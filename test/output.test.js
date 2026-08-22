"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  compileBlacklist,
  formatOneBotSummary,
  isBlacklisted,
} = require("../lib/output.js");

const record = {
  capturedAt: "2026-08-12T07:34:47.186Z",
  group: {
    name: "测试群",
    uin: "123456",
  },
  message: {
    text: "@全体成员 请查收",
    time: "2026-08-12T07:34:47.000Z",
  },
};

test("formats the separate OneBot source summary", () => {
  assert.equal(
    formatOneBotSummary({
      ...record,
      sender: { uin: "654321", nickname: "发送者", memberName: "群名片" },
    }, "Asia/Shanghai"),
    "群：测试群（123456）\n发送者：群名片（654321）\n发送日期：2026-08-12 15:34:47",
  );
});

test("blacklist supports strings and flags while matching only supplied message text", () => {
  const errors = [];
  const blacklist = compileBlacklist([
    { pattern: "广告|推广", flags: "iu" },
    { pattern: "[", flags: "u" },
  ], (error, entry) => errors.push({ error, entry }));

  assert.equal(blacklist.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(isBlacklisted("这是广告消息", blacklist), true);
  assert.equal(isBlacklisted("普通消息", blacklist), false);
  assert.equal(isBlacklisted("广告群（123456）", blacklist), true, "the matcher remains generic");
});
