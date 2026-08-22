"use strict";

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  fileEnabled: true,
  outputFile: "mentions.jsonl",
  includeElements: true,
  startupGraceSeconds: 10,
  maxRememberedMessages: 10000,
  blacklist: [],
  groupIdBlacklist: [],
  onebot: Object.freeze({
    enabled: false,
    url: "",
    headers: Object.freeze({}),
    timeoutMs: 60000,
    timeZone: "Asia/Shanghai",
    messageType: "private",
    targetId: "",
    accessToken: "",
  }),
});

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value, fallback, minimum) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? number : fallback;
}

function normalizeHeaders(value) {
  if (!isObject(value)) return {};

  return Object.fromEntries(
    Object.entries(value)
      .filter(([name, headerValue]) => name && headerValue !== null && headerValue !== undefined)
      .map(([name, headerValue]) => [name, Array.isArray(headerValue)
        ? headerValue.map(String)
        : String(headerValue)]),
  );
}

function normalizeBlacklist(value) {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry === "string") return entry ? [entry] : [];
    if (!isObject(entry) || typeof entry.pattern !== "string" || !entry.pattern) return [];
    return [{
      pattern: entry.pattern,
      flags: typeof entry.flags === "string" ? entry.flags : "u",
    }];
  });
}

function normalizeGroupIdBlacklist(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((entry) => typeof entry === "string" || typeof entry === "number")
    .map((entry) => String(entry).trim())
    .filter(Boolean))];
}

function normalizeConfig(value) {
  const source = isObject(value) ? value : {};
  const migratingWebhook = !isObject(source.onebot) && isObject(source.webhook);
  const onebot = isObject(source.onebot)
    ? source.onebot
    : isObject(source.webhook) ? source.webhook : {};

  return {
    enabled: source.enabled !== false,
    fileEnabled: source.fileEnabled !== false,
    outputFile: typeof source.outputFile === "string" && source.outputFile.trim()
      ? source.outputFile.trim()
      : DEFAULT_CONFIG.outputFile,
    includeElements: source.includeElements !== false,
    startupGraceSeconds: finiteNumber(
      source.startupGraceSeconds,
      DEFAULT_CONFIG.startupGraceSeconds,
      0,
    ),
    maxRememberedMessages: finiteNumber(
      source.maxRememberedMessages,
      DEFAULT_CONFIG.maxRememberedMessages,
      100,
    ),
    blacklist: normalizeBlacklist(source.blacklist),
    groupIdBlacklist: normalizeGroupIdBlacklist(source.groupIdBlacklist),
    onebot: {
      enabled: onebot.enabled === true && (!migratingWebhook || onebot.mode === "onebot11"),
      url: typeof onebot.url === "string" ? onebot.url.trim() : "",
      headers: normalizeHeaders(onebot.headers),
      timeoutMs: finiteNumber(onebot.timeoutMs, DEFAULT_CONFIG.onebot.timeoutMs, 1000),
      timeZone: typeof onebot.timeZone === "string" && onebot.timeZone.trim()
        ? onebot.timeZone.trim()
        : DEFAULT_CONFIG.onebot.timeZone,
      messageType: (onebot.messageType ?? onebot.oneBotMessageType) === "group"
        ? "group"
        : "private",
      targetId: typeof (onebot.targetId ?? onebot.oneBotTargetId) === "string"
        || typeof (onebot.targetId ?? onebot.oneBotTargetId) === "number"
        ? String(onebot.targetId ?? onebot.oneBotTargetId).trim()
        : "",
      accessToken: typeof onebot.accessToken === "string" ? onebot.accessToken.trim() : "",
    },
  };
}

function validateConfig(value, options = {}) {
  const errors = [];
  const source = isObject(value) ? value : {};
  const onebot = isObject(source.onebot)
    ? source.onebot
    : isObject(source.webhook) ? source.webhook : {};
  const config = normalizeConfig(value);

  if (typeof source.outputFile !== "string" || !source.outputFile.trim()) {
    errors.push("输出文件名不能为空");
  }

  const startupGraceSeconds = Number(source.startupGraceSeconds);
  if (!Number.isFinite(startupGraceSeconds) || startupGraceSeconds < 0) {
    errors.push("启动宽限秒数必须是大于或等于 0 的数字");
  }

  const maxRememberedMessages = Number(source.maxRememberedMessages);
  if (!Number.isFinite(maxRememberedMessages) || maxRememberedMessages < 100) {
    errors.push("消息去重上限不能小于 100");
  }

  const timeoutMs = Number(onebot.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
    errors.push("OneBot 请求超时不能小于 1000 毫秒");
  }

  if (!isObject(onebot.headers)) {
    errors.push("OneBot 请求头必须是 JSON 对象");
  } else {
    for (const [name, headerValue] of Object.entries(onebot.headers)) {
      const validValue = ["string", "number", "boolean"].includes(typeof headerValue)
        || (Array.isArray(headerValue) && headerValue.every((item) => typeof item === "string"));
      if (!name || !validValue) {
        errors.push("OneBot 请求头的名称或值无效");
        break;
      }
    }
  }

  if (config.onebot.timeZone) {
    try {
      new Intl.DateTimeFormat("zh-CN", { timeZone: config.onebot.timeZone }).format();
    } catch {
      errors.push("OneBot 时区不是有效的 IANA 时区");
    }
  }

  const requireOneBotUrl = options.requireOneBotUrl || onebot.enabled === true;
  if (requireOneBotUrl || config.onebot.url) {
    try {
      const url = new URL(config.onebot.url);
      if (url.protocol !== "http:") {
        errors.push("OneBot 地址只支持 http://");
      }
    } catch {
      errors.push("OneBot HTTP 地址无效");
    }
  }

  if (requireOneBotUrl) {
    const messageType = onebot.messageType ?? onebot.oneBotMessageType;
    if (messageType !== "private" && messageType !== "group") {
      errors.push("OneBot v11 接收目标只能是私聊或群聊");
    }
    if (!/^\d+$/.test(config.onebot.targetId)) {
      errors.push("OneBot v11 接收目标必须是 QQ 号或群号");
    }
  }

  if (!Array.isArray(source.blacklist)) {
    errors.push("消息正文正则黑名单必须是数组");
  } else {
    source.blacklist.forEach((entry, index) => {
      const pattern = typeof entry === "string" ? entry : entry?.pattern;
      const flags = typeof entry === "string" ? "u" : entry?.flags ?? "u";
      if (typeof pattern !== "string" || !pattern) {
        errors.push(`第 ${index + 1} 条消息正文黑名单缺少正则表达式`);
        return;
      }
      try {
        new RegExp(pattern, flags);
      } catch (error) {
        errors.push(`第 ${index + 1} 条消息正文黑名单无效：${error.message}`);
      }
    });
  }

  if (!Array.isArray(source.groupIdBlacklist)) {
    errors.push("群 ID 黑名单必须是数组");
  } else {
    source.groupIdBlacklist.forEach((entry, index) => {
      if (!/^\d+$/.test(String(entry).trim())) {
        errors.push(`第 ${index + 1} 条群 ID 黑名单不是有效群号`);
      }
    });
  }

  return { config, errors };
}

function assertValidConfig(value, options) {
  const result = validateConfig(value, options);
  if (result.errors.length) {
    throw new Error(result.errors.join("；"));
  }
  return result.config;
}

module.exports = {
  DEFAULT_CONFIG,
  assertValidConfig,
  normalizeConfig,
  validateConfig,
};
