"use strict";

const fs = require("fs");
const path = require("path");
const { ipcMain } = require("electron");
const { SenderContextBuffer } = require("./lib/context.js");
const {
  createMessageRecord,
  findKernelCommand,
  getLiveMessages,
  inspectMentions,
  updateIdentityFromCommand,
  updateIdentityFromOwnMessage,
} = require("./lib/mentions.js");
const {
  assertValidConfig,
  normalizeConfig,
} = require("./lib/config.js");
const { RollingDebugLog } = require("./lib/debug-log.js");
const {
  compileBlacklist,
  formatDateInTimeZone,
  formatOneBotSummary,
  isBlacklisted,
} = require("./lib/output.js");
const {
  recordToForwardNode,
  sendOneBotForwardWithImageFallback,
  sendOneBotMessage,
} = require("./lib/onebot.js");

const SLUG = "mention_exporter";
const PATCH_MARK = Symbol.for("LiteLoader.mention_exporter.sendPatched");

const startedAt = Math.floor(Date.now() / 1000);
const identity = { uid: "", uin: "" };
const rememberedMessages = new Set();
const rememberedQueue = [];
const dataDirectory = path.join(LiteLoader.path.data, SLUG);
const debugLogPath = path.join(dataDirectory, "debug.log");
const rollingDebugLog = new RollingDebugLog(debugLogPath, {
  maxBytes: 5 * 1024 * 1024,
  maxBackups: 3,
});
const senderContexts = new SenderContextBuffer(enqueueOneBotContext, 120000);

const savedConfig = LiteLoader.api.config.get(SLUG, {});
let config;
let blacklist;
let groupIdBlacklist;
let outputPath;
let debugLogFailureReported = false;

let oneBotQueue = Promise.resolve();

function output(...args) {
  console.log("\x1b[36m%s\x1b[0m", "Mention Exporter:", ...args);
}

function debugLog(event, details = {}, level = "debug") {
  if (config?.debugLogEnabled === false) return;
  try {
    rollingDebugLog.write(level, event, details);
    debugLogFailureReported = false;
  } catch (error) {
    if (debugLogFailureReported) return;
    debugLogFailureReported = true;
    console.error("Mention Exporter failed to write its debug log:", error);
  }
}

function cloneConfig(value) {
  return JSON.parse(JSON.stringify(value));
}

function resolveOutputPath(value) {
  return path.isAbsolute(value) ? value : path.join(dataDirectory, value);
}

function applyConfig(value, { persist = false, strict = false } = {}) {
  const nextConfig = strict ? assertValidConfig(value) : normalizeConfig(value);
  const nextOutputPath = resolveOutputPath(nextConfig.outputFile);
  const nextBlacklist = compileBlacklist(nextConfig.blacklist, (error, entry) => {
    console.error("Mention Exporter ignored an invalid blacklist expression:", entry, error.message);
  });

  if (nextConfig.fileEnabled !== false) {
    fs.mkdirSync(path.dirname(nextOutputPath), { recursive: true });
  }

  config = nextConfig;
  outputPath = nextOutputPath;
  blacklist = nextBlacklist;
  groupIdBlacklist = new Set(nextConfig.groupIdBlacklist);
  if (!nextConfig.enabled || !nextConfig.onebot.enabled) senderContexts.clear();
  if (persist) LiteLoader.api.config.set(SLUG, config);
  debugLog("config.applied", {
    persist,
    enabled: config.enabled,
    fileEnabled: config.fileEnabled,
    debugLogEnabled: config.debugLogEnabled,
    oneBotEnabled: config.onebot.enabled,
    oneBotMessageType: config.onebot.messageType,
    oneBotTimeoutMs: config.onebot.timeoutMs,
  });
  return cloneConfig(config);
}

applyConfig(savedConfig, { persist: true });

function remember(message) {
  const id = String(message?.msgId ?? "");
  if (!id) return true;

  const key = `${message.peerUid ?? ""}:${id}`;
  if (rememberedMessages.has(key)) return false;

  rememberedMessages.add(key);
  rememberedQueue.push(key);

  const limit = Math.max(100, Number(config.maxRememberedMessages) || 10000);
  while (rememberedQueue.length > limit) {
    rememberedMessages.delete(rememberedQueue.shift());
  }
  return true;
}

function isFromCurrentRun(message) {
  let messageTime = Number(message?.msgTime);
  if (!Number.isFinite(messageTime) || messageTime <= 0) return true;
  if (messageTime > 1e12) messageTime /= 1000;

  const grace = Math.max(0, Number(config.startupGraceSeconds) || 0);
  return messageTime >= startedAt - grace;
}

function jsonLine(record) {
  const seen = new WeakSet();
  return JSON.stringify(record, (_key, value) => {
    if (typeof value === "bigint") return value.toString();
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value;
  });
}

// 当前输出适配点。后续若改为 SQLite、HTTP 或其他方式，只需替换这里。
function writeRecord(record) {
  fs.appendFileSync(outputPath, `${jsonLine(record)}\n`, "utf8");
}

function enqueueOneBotContext(context) {
  if (!config.onebot.enabled || !config.onebot.url) return;
  const groupId = String(context.mention.group.uin || context.mention.group.uid || "");
  if (groupIdBlacklist.has(groupId)
    || isBlacklisted(context.mention.message.text, blacklist)) return;

  const onebot = cloneConfig(config.onebot);
  const summary = formatOneBotSummary(context.mention, onebot.timeZone);
  const messageId = context.mention.message.id || "message";
  const debugContext = {
    triggerMessageId: messageId,
    groupId,
    senderId: String(context.mention.sender?.uin || context.mention.sender?.uid || ""),
    nodeCount: context.records.length,
    timedOut: context.timedOut,
  };
  const nodes = context.records.map((record) => recordToForwardNode(record, debugLog));
  debugLog("onebot.context_queued", debugContext);
  oneBotQueue = oneBotQueue
    .then(() => sendOneBotMessage(onebot, summary))
    .then((result) => {
      debugLog("onebot.summary_sent", { ...debugContext, status: result.status });
      return sendOneBotForwardWithImageFallback(onebot, nodes, {
        debug: debugLog,
        context: debugContext,
      });
    })
    .then((result) => {
      if (result.usedImageFallback) {
        console.warn(`Mention Exporter omitted unavailable images from ${messageId}`);
      }
      debugLog("onebot.forward_sent", {
        ...debugContext,
        status: result.status,
        usedImageFallback: result.usedImageFallback,
      }, result.usedImageFallback ? "warn" : "debug");
      output(
        `sent ${messageId} -> OneBot (${nodes.length} forward nodes${context.timedOut ? ", timeout" : ""}${result.usedImageFallback ? ", images omitted" : ""})`,
      );
    })
    .catch((error) => {
      debugLog("onebot.send_failed", { ...debugContext, error }, "error");
      console.error(`Mention Exporter failed to send ${messageId} to OneBot:`, error);
    });
}

function senderContextKey(message) {
  const groupId = String(message?.peerUin || message?.peerUid || "");
  const senderId = String(message?.senderUid || message?.senderUin || "");
  return groupId && senderId ? `${groupId}:${senderId}` : "";
}

function recordForFile(record) {
  if (config.includeElements !== false) return record;
  const copy = { ...record, message: { ...record.message } };
  delete copy.message.elements;
  return copy;
}

function inspectIpc(channel, args) {
  if (!config.enabled || typeof channel !== "string" || !channel.includes("RM_IPCFROM_")) {
    return;
  }

  const command = findKernelCommand(args);
  if (!command) return;

  updateIdentityFromCommand(identity, command);

  for (const message of getLiveMessages(command)) {
    updateIdentityFromOwnMessage(identity, message);
    if (!isFromCurrentRun(message) || !remember(message)) continue;

    const mention = inspectMentions(message, identity);
    const record = createMessageRecord(
      message,
      mention,
      command.cmdName,
      new Date(),
      true,
    );
    const groupId = String(record.group.uin || record.group.uid || "");
    if (Number(message.chatType) !== 2 || groupIdBlacklist.has(groupId)) continue;

    const blacklisted = Boolean(mention && isBlacklisted(record.message.text, blacklist));
    if (blacklisted) {
      output(`ignored blacklisted message body ${record.message.id || "message"}`);
      continue;
    }

    const contextKey = senderContextKey(message);
    if (contextKey) {
      senderContexts.accept(
        contextKey,
        record,
        Boolean(mention && config.onebot.enabled && config.onebot.url),
      );
    }

    if (!mention) continue;

    if (config.fileEnabled !== false) {
      try {
        writeRecord(recordForFile(record));
        output(`captured ${record.message.id || "message"} -> ${outputPath}`);
      } catch (error) {
        debugLog("file.write_failed", {
          messageId: record.message.id || "message",
          path: outputPath,
          error,
        }, "error");
        console.error(`Mention Exporter failed to write ${record.message.id || "message"}:`, error);
      }
    }
  }
}

ipcMain.handle("LiteLoader.mention_exporter.getConfig", () => cloneConfig(config));

ipcMain.handle("LiteLoader.mention_exporter.saveConfig", (_event, value) => {
  const saved = applyConfig(value, { persist: true, strict: true });
  output(
    `configuration updated; file: ${saved.fileEnabled ? outputPath : "disabled"}; ` +
    `OneBot: ${saved.onebot.enabled && saved.onebot.url ? "enabled" : "disabled"}`,
  );
  return saved;
});

ipcMain.handle("LiteLoader.mention_exporter.testOneBot", async (_event, value) => {
  const candidate = assertValidConfig({
    ...config,
    onebot: {
      ...config.onebot,
      ...(value ?? {}),
    },
  }, { requireOneBotUrl: true });
  const now = formatDateInTimeZone(new Date(), candidate.onebot.timeZone);
  const summary = `群：OneBot 测试群（123456）\n发送者：测试发送者（654321）\n发送日期：${now}`;
  const nodes = ["上一条测试消息", "@当前账号 测试消息", "下一条测试消息"].map((text) => ({
    type: "node",
    data: {
      user_id: "654321",
      nickname: "测试发送者",
      content: [{ type: "text", data: { text } }],
    },
  }));
  const messageResult = await sendOneBotMessage(candidate.onebot, summary);
  const forwardResult = await sendOneBotForward(candidate.onebot, nodes);
  output(`OneBot test returned HTTP ${messageResult.status}/${forwardResult.status}`);
  return { status: forwardResult.status };
});

function onBrowserWindowCreated(window) {
  const webContents = window?.webContents;
  if (!webContents) return;

  const sendTarget = webContents.__qqntim_original_object || webContents;
  const originalSend = sendTarget.send;
  if (typeof originalSend !== "function" || originalSend[PATCH_MARK]) return;

  function patchedSend(channel, ...args) {
    try {
      inspectIpc(channel, args);
    } catch (error) {
      debugLog("ipc.inspect_failed", { channel, error }, "error");
      console.error("Mention Exporter failed to inspect an IPC message:", error);
    }
    return Reflect.apply(originalSend, this, [channel, ...args]);
  }

  Object.defineProperty(patchedSend, PATCH_MARK, { value: true });
  sendTarget.send = patchedSend;
}

function onLogin(uid) {
  identity.uid = String(uid ?? "");
  debugLog("plugin.login", {
    uid: identity.uid,
    fileEnabled: config.fileEnabled,
    debugLogEnabled: config.debugLogEnabled,
    oneBotEnabled: config.onebot.enabled,
  });
  output(
    `logged in as ${identity.uid || "unknown uid"}; ` +
    `file: ${config.fileEnabled !== false ? outputPath : "disabled"}; ` +
    `debug log: ${config.debugLogEnabled !== false ? debugLogPath : "disabled"}; ` +
    `OneBot: ${config.onebot.enabled && config.onebot.url ? "enabled" : "disabled"}`,
  );
}

module.exports = {
  onBrowserWindowCreated,
  onLogin,
};
