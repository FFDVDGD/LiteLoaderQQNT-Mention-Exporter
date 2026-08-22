"use strict";

function compileBlacklist(entries, onError = () => {}) {
  if (!Array.isArray(entries)) return [];

  const expressions = [];
  for (const entry of entries) {
    const pattern = typeof entry === "string" ? entry : entry?.pattern;
    const flags = typeof entry === "string" ? "u" : entry?.flags ?? "u";
    if (typeof pattern !== "string" || !pattern) continue;

    try {
      expressions.push(new RegExp(pattern, flags));
    } catch (error) {
      onError(error, entry);
    }
  }
  return expressions;
}

function isBlacklisted(content, expressions) {
  return expressions.some((expression) => {
    expression.lastIndex = 0;
    return expression.test(content);
  });
}

function formatDateInTimeZone(value, timeZone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知时间";

  const options = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  };
  if (timeZone) options.timeZone = timeZone;

  let parts;
  try {
    parts = new Intl.DateTimeFormat("zh-CN", options).formatToParts(date);
  } catch {
    delete options.timeZone;
    parts = new Intl.DateTimeFormat("zh-CN", options).formatToParts(date);
  }

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function formatOneBotSummary(record, timeZone) {
  const groupName = String(record.group?.name ?? "").trim() || "未知群";
  const groupId = String(record.group?.uin || record.group?.uid || "未知");
  const senderName = String(
    record.sender?.memberName
    || record.sender?.remarkName
    || record.sender?.nickname
    || "",
  ).trim() || "未知发送者";
  const senderId = String(record.sender?.uin || record.sender?.uid || "未知");
  const messageTime = formatDateInTimeZone(
    record.message?.time || record.capturedAt,
    timeZone,
  );

  return `群：${groupName}（${groupId}）\n发送者：${senderName}（${senderId}）\n发送日期：${messageTime}`;
}

module.exports = {
  compileBlacklist,
  formatDateInTimeZone,
  formatOneBotSummary,
  isBlacklisted,
};
