"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SENSITIVE_KEY = /(?:authorization|cookie|credential|fileid|password|secret|token|rkey|skey)/i;
const SENSITIVE_QUERY = /^(?:access_?token|authorization|credential|fileid|key|password|rkey|secret|skey|token)$/i;
const MAX_STRING_LENGTH = 4096;

function sanitizeString(value) {
  let result = value;
  if (result.startsWith("base64://")) {
    return `[base64 omitted: ${Math.max(0, result.length - "base64://".length)} characters]`;
  }

  result = result.replace(/base64:\/\/[a-z\d+/_=-]+/gi, (match) => (
    `[base64 omitted: ${match.length - "base64://".length} characters]`
  ));
  result = result.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]");
  result = result.replace(
    /([?&](?:access_?token|authorization|credential|fileid|key|password|rkey|secret|skey|token)=)[^&\s]*/gi,
    "$1[REDACTED]",
  );

  if (/^https?:\/\//i.test(result)) {
    try {
      const url = new URL(result);
      for (const key of url.searchParams.keys()) {
        if (SENSITIVE_QUERY.test(key)) url.searchParams.set(key, "[REDACTED]");
      }
      result = url.href;
    } catch {
      // Keep malformed diagnostic text after applying the generic redactions above.
    }
  }

  return result.length <= MAX_STRING_LENGTH
    ? result
    : `${result.slice(0, MAX_STRING_LENGTH)}…[truncated]`;
}

function sanitize(value, seen = new WeakSet()) {
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "bigint") return value.toString();
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (value instanceof Error) {
    return sanitize({ name: value.name, message: value.message, code: value.code }, seen);
  }
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitize(item, seen),
  ]));
}

class RollingDebugLog {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.maxBytes = Math.max(1, Number(options.maxBytes) || 5 * 1024 * 1024);
    this.maxBackups = Math.max(0, Math.floor(Number(options.maxBackups ?? 3) || 0));
    this.now = options.now || (() => new Date());
  }

  write(level, event, details = {}) {
    const line = `${JSON.stringify({
      timestamp: this.now().toISOString(),
      level: String(level || "debug"),
      event: String(event || "unknown"),
      details: sanitize(details),
    })}\n`;
    const bytes = Buffer.byteLength(line);

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.rotateIfNeeded(bytes);
    fs.appendFileSync(this.filePath, line, "utf8");
  }

  rotateIfNeeded(incomingBytes) {
    let size = 0;
    try {
      size = fs.statSync(this.filePath).size;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!size || size + incomingBytes <= this.maxBytes) return;

    if (!this.maxBackups) {
      fs.rmSync(this.filePath, { force: true });
      return;
    }

    fs.rmSync(`${this.filePath}.${this.maxBackups}`, { force: true });
    for (let index = this.maxBackups - 1; index >= 1; index -= 1) {
      const source = `${this.filePath}.${index}`;
      const destination = `${this.filePath}.${index + 1}`;
      if (fs.existsSync(source)) fs.renameSync(source, destination);
    }
    fs.renameSync(this.filePath, `${this.filePath}.1`);
  }
}

module.exports = { RollingDebugLog, sanitize };
