"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

test("hooks live IPC, writes JSONL, and sends adjacent context through OneBot", async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mention-exporter-"));
  const configured = [];
  const ipcHandlers = new Map();
  const oneBotRequests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      oneBotRequests.push({
        url: request.url,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 1 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  global.LiteLoader = {
    path: { data: temporaryDirectory },
    api: {
      config: {
        get: () => ({
          enabled: true,
          outputFile: "mentions.jsonl",
          includeElements: true,
          startupGraceSeconds: 10,
          maxRememberedMessages: 100,
          blacklist: [{ pattern: "广告|推广", flags: "u" }],
          groupIdBlacklist: ["999999"],
          onebot: {
            enabled: true,
            url: `http://127.0.0.1:${address.port}`,
            headers: {},
            timeoutMs: 2000,
            timeZone: "Asia/Shanghai",
            messageType: "private",
            targetId: "112233",
            accessToken: "",
          },
        }),
        set: (slug, config) => configured.push({ slug, config }),
      },
    },
  };

  const originalLoad = Module._load;
  Module._load = function mockElectron(request, parent, isMain) {
    if (request === "electron") {
      return {
        ipcMain: {
          handle: (channel, handler) => ipcHandlers.set(channel, handler),
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  let plugin;
  try {
    plugin = require("../main.js");
  } finally {
    Module._load = originalLoad;
  }
  const forwarded = [];
  const window = {
    webContents: {
      send(...args) {
        forwarded.push(args);
        return "forwarded";
      },
    },
  };

  try {
    plugin.onLogin("u_self");
    plugin.onBrowserWindowCreated(window);

    const command = {
      cmdName: "nodeIKernelMsgListener/onRecvMsg",
      payload: {
        msgList: [
          {
            msgId: "live-message-1",
            msgSeq: "1",
            msgTime: String(Math.floor(Date.now() / 1000)),
            chatType: 2,
            sendType: 0,
            peerUid: "123456",
            peerUin: "123456",
            peerName: "广告推广群",
            senderUid: "u_sender",
            senderUin: "654321",
            sendNickName: "发送者",
            elements: [
              {
                elementType: 1,
                textElement: {
                  content: "@当前账号 测试",
                  atType: 2,
                  atUid: "0",
                  atNtUid: "u_self",
                },
              },
            ],
          },
        ],
      },
    };

    const previousCommand = structuredClone(command);
    previousCommand.payload.msgList[0].msgId = "previous-message";
    previousCommand.payload.msgList[0].elements[0].textElement = {
      content: "上一条消息",
      atType: 0,
      atUid: "0",
      atNtUid: "",
    };
    window.webContents.send("RM_IPCFROM_TEST", { type: "request" }, previousCommand);

    const result = window.webContents.send("RM_IPCFROM_TEST", { type: "request" }, command);
    window.webContents.send("RM_IPCFROM_TEST", { type: "request" }, command);
    const blacklistedCommand = structuredClone(command);
    blacklistedCommand.payload.msgList[0].msgId = "blacklisted-message";
    blacklistedCommand.payload.msgList[0].elements[0].textElement.content = "@当前账号 广告";
    window.webContents.send("RM_IPCFROM_TEST", { type: "request" }, blacklistedCommand);
    const blockedCommand = structuredClone(command);
    blockedCommand.payload.msgList[0].msgId = "blocked-group-message";
    blockedCommand.payload.msgList[0].peerUid = "999999";
    blockedCommand.payload.msgList[0].peerUin = "999999";
    window.webContents.send("RM_IPCFROM_TEST", { type: "request" }, blockedCommand);
    const nextCommand = structuredClone(previousCommand);
    nextCommand.payload.msgList[0].msgId = "next-message";
    nextCommand.payload.msgList[0].elements[0].textElement.content = "下一条消息";
    window.webContents.send("RM_IPCFROM_TEST", { type: "request" }, nextCommand);

    for (let attempt = 0; oneBotRequests.length < 2 && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const outputPath = path.join(temporaryDirectory, "mention_exporter", "mentions.jsonl");
    const lines = fs.readFileSync(outputPath, "utf8").trim().split("\n");
    const record = JSON.parse(lines[0]);
    const debugPath = path.join(temporaryDirectory, "mention_exporter", "debug.log");
    const debugEvents = fs.readFileSync(debugPath, "utf8").trim().split("\n").map(JSON.parse);

    assert.equal(result, "forwarded");
    assert.equal(forwarded.length, 6);
    assert.equal(lines.length, 1, "duplicate delivery should be exported once");
    assert.equal(record.group.name, "广告推广群", "group names must not match the message blacklist");
    assert.equal(record.mention.atMe, true);
    assert.equal(record.message.id, "live-message-1");
    assert.ok(debugEvents.some((entry) => entry.event === "config.applied"));
    assert.ok(debugEvents.some((entry) => entry.event === "onebot.context_queued"
      && entry.details.triggerMessageId === "live-message-1"));
    assert.equal(configured[0].slug, "mention_exporter");
    assert.equal(typeof ipcHandlers.get("LiteLoader.mention_exporter.getConfig"), "function");
    assert.equal(typeof ipcHandlers.get("LiteLoader.mention_exporter.saveConfig"), "function");
    assert.equal(typeof ipcHandlers.get("LiteLoader.mention_exporter.testOneBot"), "function");
    assert.deepEqual(oneBotRequests.map((request) => request.url), [
      "/send_private_msg",
      "/send_private_forward_msg",
    ]);
    assert.match(oneBotRequests[0].body.message[0].data.text, /群：广告推广群（123456）/);
    assert.deepEqual(
      oneBotRequests[1].body.messages.map((node) => node.data.content[0].data.text),
      ["上一条消息", "@当前账号 测试", "下一条消息"],
    );

    const updated = ipcHandlers.get("LiteLoader.mention_exporter.saveConfig")(null, {
      ...configured[0].config,
      fileEnabled: false,
      outputFile: "changed.jsonl",
    });
    assert.equal(updated.fileEnabled, false);
    assert.equal(configured.at(-1).config.outputFile, "changed.jsonl");
  } finally {
    delete global.LiteLoader;
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});
