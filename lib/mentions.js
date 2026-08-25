"use strict";

const CHAT_TYPE_GROUP = 2;

const AT_TYPE = Object.freeze({
  ALL: 1,
  ONE: 2,
  ME: 4,
});

const LIVE_MESSAGE_COMMANDS = new Set([
  "nodeIKernelMsgListener/onRecvMsg",
  "nodeIKernelMsgListener/onRecvActiveMsg",
]);

function toId(value) {
  return value === null || value === undefined || value === "0"
    ? ""
    : String(value);
}

function findKernelCommand(args) {
  for (const value of args) {
    if (value && typeof value === "object" && typeof value.cmdName === "string") {
      return value;
    }
    if (Array.isArray(value)) {
      const command = findKernelCommand(value);
      if (command) return command;
    }
  }
  return null;
}

function getLiveMessages(command) {
  if (!command || !LIVE_MESSAGE_COMMANDS.has(command.cmdName)) return [];
  return Array.isArray(command.payload?.msgList) ? command.payload.msgList : [];
}

function updateIdentityFromCommand(identity, command) {
  if (command?.cmdName !== "nodeIKernelSessionListener/onSessionInitComplete") {
    return identity;
  }

  identity.uid ||= toId(command.payload?.uid);
  identity.uin ||= toId(command.payload?.uin);
  return identity;
}

function updateIdentityFromOwnMessage(identity, message) {
  if (Number(message?.sendType) !== 2) return identity;

  identity.uid ||= toId(message.senderUid);
  identity.uin ||= toId(message.senderUin);
  return identity;
}

function inspectMentions(message, identity) {
  if (Number(message?.chatType) !== CHAT_TYPE_GROUP) return null;

  const matches = [];
  let atAll = false;
  let atMe = false;

  for (const element of message.elements ?? []) {
    const text = element?.textElement;
    if (!text) continue;

    const atType = Number(text.atType);
    const atUid = toId(text.atUid);
    const atNtUid = toId(text.atNtUid);
    const matchesAll = atType === AT_TYPE.ALL;
    const matchesMe =
      atType === AT_TYPE.ME ||
      Boolean(identity.uid && atNtUid === identity.uid) ||
      Boolean(identity.uin && atUid === identity.uin);

    if (!matchesAll && !matchesMe) continue;

    atAll ||= matchesAll;
    atMe ||= matchesMe;
    matches.push({
      content: String(text.content ?? ""),
      atType,
      atUid,
      atNtUid,
      matchesAll,
      matchesMe,
    });
  }

  return atAll || atMe ? { atAll, atMe, matches } : null;
}

function cardText(arkElement) {
  let card = arkElement?.bytesData;
  if (Buffer.isBuffer(card)) card = card.toString("utf8");
  if (typeof card === "string") {
    try {
      card = JSON.parse(card);
    } catch {
      return "[卡片]";
    }
  }
  if (!card || typeof card !== "object") return "[卡片]";

  const parts = [];
  const add = (value) => {
    if (typeof value !== "string") return;
    const text = value.replace(/\s+/g, " ").trim();
    if (!text || parts.some((part) => part === text || (text.length > 3 && part.includes(text)))) {
      return;
    }
    parts.push(text);
  };
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 3) return;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    for (const key of ["title", "desc", "summary", "name", "tag", "singer", "author", "text"]) {
      add(value[key]);
    }
    Object.values(value).forEach((item) => visit(item, depth + 1));
  };

  add(arkElement?.prompt);
  add(card.prompt);
  add(card.title);
  add(card.desc);
  visit(card.meta);
  return parts.join("\n") || "[卡片]";
}

function elementToText(element) {
  if (element?.textElement) return String(element.textElement.content ?? "");
  if (element?.picElement) return "[图片]";
  if (element?.pttElement) return "[语音]";
  if (element?.videoElement) return "[视频]";
  if (element?.fileElement) return "[文件]";
  if (element?.marketFaceElement || element?.faceElement) return "[表情]";
  if (element?.arkElement) return cardText(element.arkElement);
  if (element?.markdownElement) return "[Markdown]";
  if (element?.structLongMsgElement) return "[长消息]";
  if (element?.multiForwardMsgElement) return "[合并转发]";
  return "";
}

function parseMessageTime(value) {
  let timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  if (timestamp < 1e12) timestamp *= 1000;

  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function createMessageRecord(message, mention, commandName, capturedAt, includeElements) {
  const elements = Array.isArray(message.elements) ? message.elements : [];
  const record = {
    schemaVersion: 1,
    capturedAt: capturedAt.toISOString(),
    sourceCommand: commandName,
    mention,
    group: {
      uin: toId(message.peerUin || message.peerUid),
      uid: toId(message.peerUid),
      name: String(message.peerName ?? ""),
    },
    sender: {
      uin: toId(message.senderUin),
      uid: toId(message.senderUid),
      nickname: String(message.sendNickName ?? ""),
      memberName: String(message.sendMemberName ?? ""),
      remarkName: String(message.sendRemarkName ?? ""),
    },
    message: {
      id: toId(message.msgId),
      sequence: toId(message.msgSeq),
      time: parseMessageTime(message.msgTime),
      text: elements.map(elementToText).join(""),
    },
  };

  if (includeElements) record.message.elements = elements;
  return record;
}

module.exports = {
  AT_TYPE,
  CHAT_TYPE_GROUP,
  cardText,
  createMessageRecord,
  findKernelCommand,
  getLiveMessages,
  inspectMentions,
  parseMessageTime,
  updateIdentityFromCommand,
  updateIdentityFromOwnMessage,
};
