"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createMessageRecord,
  findKernelCommand,
  getLiveMessages,
  inspectMentions,
  updateIdentityFromCommand,
  updateIdentityFromOwnMessage,
} = require("../lib/mentions.js");

function groupMessage(textElement, overrides = {}) {
  return {
    msgId: "10001",
    msgSeq: "42",
    msgTime: "1786505943",
    chatType: 2,
    sendType: 0,
    peerUid: "123456",
    peerUin: "123456",
    peerName: "测试群",
    senderUid: "u_sender",
    senderUin: "654321",
    sendNickName: "发送者",
    elements: [
      {
        elementType: 1,
        textElement,
      },
    ],
    ...overrides,
  };
}

test("recognizes @全体成员", () => {
  const result = inspectMentions(
    groupMessage({ content: "@全体成员 请查收", atType: 1, atUid: "0", atNtUid: "" }),
    { uid: "u_self", uin: "111" },
  );

  assert.equal(result.atAll, true);
  assert.equal(result.atMe, false);
});

test("recognizes QQNT ATTYPEME", () => {
  const result = inspectMentions(
    groupMessage({ content: "@我", atType: 4, atUid: "0", atNtUid: "" }),
    { uid: "u_self", uin: "111" },
  );

  assert.equal(result.atAll, false);
  assert.equal(result.atMe, true);
});

test("recognizes a normal directed @ by NT uid", () => {
  const result = inspectMentions(
    groupMessage({ content: "@测试账号", atType: 2, atUid: "0", atNtUid: "u_self" }),
    { uid: "u_self", uin: "111" },
  );

  assert.equal(result.atMe, true);
});

test("recognizes a normal directed @ by uin", () => {
  const result = inspectMentions(
    groupMessage({ content: "@测试账号", atType: 2, atUid: "111", atNtUid: "" }),
    { uid: "u_self", uin: "111" },
  );

  assert.equal(result.atMe, true);
});

test("ignores unrelated @ and private messages", () => {
  const unrelated = inspectMentions(
    groupMessage({ content: "@其他人", atType: 2, atUid: "222", atNtUid: "u_other" }),
    { uid: "u_self", uin: "111" },
  );
  const privateMessage = inspectMentions(
    groupMessage(
      { content: "@全体成员", atType: 1, atUid: "0", atNtUid: "" },
      { chatType: 1 },
    ),
    { uid: "u_self", uin: "111" },
  );

  assert.equal(unrelated, null);
  assert.equal(privateMessage, null);
});

test("extracts only live message commands", () => {
  const command = {
    cmdName: "nodeIKernelMsgListener/onRecvMsg",
    payload: { msgList: [{ msgId: "1" }] },
  };

  assert.equal(findKernelCommand([{}, command]), command);
  assert.deepEqual(getLiveMessages(command), [{ msgId: "1" }]);
  assert.deepEqual(
    getLiveMessages({ cmdName: "nodeIKernelMsgListener/onMsgInfoListUpdate", payload: command.payload }),
    [],
  );
});

test("learns the current account identity", () => {
  const identity = { uid: "", uin: "" };
  updateIdentityFromCommand(identity, {
    cmdName: "nodeIKernelSessionListener/onSessionInitComplete",
    payload: { uid: "u_self", uin: "111" },
  });
  updateIdentityFromOwnMessage(identity, {
    sendType: 2,
    senderUid: "u_ignored",
    senderUin: "222",
  });

  assert.deepEqual(identity, { uid: "u_self", uin: "111" });
});

test("creates a stable JSONL-friendly record", () => {
  const message = groupMessage({
    content: "@全体成员 测试",
    atType: 1,
    atUid: "0",
    atNtUid: "",
  });
  const mention = inspectMentions(message, { uid: "u_self", uin: "111" });
  const record = createMessageRecord(
    message,
    mention,
    "nodeIKernelMsgListener/onRecvMsg",
    new Date("2026-08-12T00:00:00.000Z"),
    true,
  );

  assert.equal(record.schemaVersion, 1);
  assert.equal(record.group.uin, "123456");
  assert.equal(record.sender.uin, "654321");
  assert.equal(record.message.text, "@全体成员 测试");
  assert.equal(record.message.elements.length, 1);
  assert.doesNotThrow(() => JSON.stringify(record));
});
