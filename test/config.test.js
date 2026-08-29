"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertValidConfig,
  normalizeConfig,
  validateConfig,
} = require("../lib/config.js");

test("normalizes missing settings into a complete independent config", () => {
  const config = normalizeConfig({
    enabled: false,
    onebot: {
      enabled: true,
      url: " http://127.0.0.1:3000 ",
      headers: { Authorization: 123 },
    },
  });

  assert.equal(config.enabled, false);
  assert.equal(config.fileEnabled, true);
  assert.equal(config.debugLogEnabled, true);
  assert.equal(config.outputFile, "mentions.jsonl");
  assert.equal(config.onebot.url, "http://127.0.0.1:3000");
  assert.equal(config.onebot.headers.Authorization, "123");
  assert.equal(config.onebot.timeoutMs, 60000);
  assert.deepEqual(config.groupIdBlacklist, []);
  assert.notEqual(config.onebot.headers, normalizeConfig({}).onebot.headers);
});

test("migrates the previous OneBot webhook settings", () => {
  const config = normalizeConfig({
    webhook: {
      enabled: true,
      mode: "onebot11",
      url: "http://127.0.0.1:3000",
      oneBotMessageType: "group",
      oneBotTargetId: "123456",
      accessToken: "secret",
    },
  });

  assert.equal(config.onebot.enabled, true);
  assert.equal(config.onebot.messageType, "group");
  assert.equal(config.onebot.targetId, "123456");
  assert.equal(config.onebot.accessToken, "secret");
  assert.equal(Object.hasOwn(config, "webhook"), false);
});

test("accepts settings produced by the GUI", () => {
  const config = assertValidConfig({
    enabled: true,
    fileEnabled: true,
    debugLogEnabled: false,
    outputFile: "mentions.jsonl",
    includeElements: false,
    startupGraceSeconds: 10,
    maxRememberedMessages: 10000,
    blacklist: [{ pattern: "广告|推广", flags: "iu" }],
    groupIdBlacklist: [123456, "123456", " 654321 "],
    onebot: {
      enabled: true,
      url: "http://127.0.0.1:3000",
      headers: { Authorization: "Bearer test" },
      timeoutMs: 10000,
      timeZone: "Asia/Shanghai",
      messageType: "group",
      targetId: "123456",
      accessToken: "",
    },
  });

  assert.equal(config.blacklist.length, 1);
  assert.equal(config.debugLogEnabled, false);
  assert.deepEqual(config.groupIdBlacklist, ["123456", "654321"]);
  assert.equal(config.onebot.messageType, "group");
});

test("reports invalid OneBot and blacklist settings", () => {
  const result = validateConfig({
    enabled: true,
    fileEnabled: true,
    outputFile: "mentions.jsonl",
    includeElements: true,
    startupGraceSeconds: 10,
    maxRememberedMessages: 10000,
    blacklist: [{ pattern: "[", flags: "u" }],
    groupIdBlacklist: ["not-a-group"],
    onebot: {
      enabled: true,
      url: "https://example.com/hook",
      headers: [],
      timeoutMs: 100,
      timeZone: "Not/A_Time_Zone",
      messageType: "channel",
      targetId: "not-a-number",
    },
  });

  assert.ok(result.errors.some((error) => error.includes("只支持 http://")));
  assert.ok(result.errors.some((error) => error.includes("请求头")));
  assert.ok(result.errors.some((error) => error.includes("时区")));
  assert.ok(result.errors.some((error) => error.includes("黑名单")));
  assert.ok(result.errors.some((error) => error.includes("有效群号")));
  assert.ok(result.errors.some((error) => error.includes("接收目标")));
  assert.throws(() => assertValidConfig(result.config, { requireOneBotUrl: true }));
});
