"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RollingDebugLog } = require("../lib/debug-log.js");

test("writes structured diagnostics and redacts credentials and base64 payloads", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mention-debug-"));
  const logPath = path.join(directory, "debug.log");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const logger = new RollingDebugLog(logPath, {
    now: () => new Date("2026-08-29T13:34:17.000Z"),
  });

  logger.write("warn", "image.downgraded", {
    accessToken: "top-secret-token",
    authorization: "Bearer top-secret-token",
    file: "base64://aGVsbG8=",
    response: "failed body: base64://aGVsbG8=",
    url: "https://example.com/download?appid=1407&fileid=top-secret-file&rkey=top-secret-token",
  });

  const text = fs.readFileSync(logPath, "utf8");
  const entry = JSON.parse(text);
  assert.equal(entry.timestamp, "2026-08-29T13:34:17.000Z");
  assert.equal(entry.level, "warn");
  assert.equal(entry.event, "image.downgraded");
  assert.doesNotMatch(text, /top-secret-token|top-secret-file|aGVsbG8=/);
  assert.match(entry.details.file, /^\[base64 omitted:/);
  assert.match(entry.details.response, /\[base64 omitted:/);
  assert.equal(new URL(entry.details.url).searchParams.get("fileid"), "[REDACTED]");
  assert.equal(new URL(entry.details.url).searchParams.get("rkey"), "[REDACTED]");
});

test("rotates the current log and keeps only the configured backups", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mention-debug-"));
  const logPath = path.join(directory, "debug.log");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const logger = new RollingDebugLog(logPath, {
    maxBytes: 180,
    maxBackups: 2,
    now: () => new Date("2026-08-29T13:34:17.000Z"),
  });

  for (let sequence = 1; sequence <= 8; sequence += 1) {
    logger.write("debug", "rotation.test", { sequence, padding: "x".repeat(20) });
  }

  assert.equal(fs.existsSync(logPath), true);
  assert.equal(fs.existsSync(`${logPath}.1`), true);
  assert.equal(fs.existsSync(`${logPath}.2`), true);
  assert.equal(fs.existsSync(`${logPath}.3`), false);
  const retained = [logPath, `${logPath}.1`, `${logPath}.2`]
    .flatMap((file) => fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse))
    .map((entry) => entry.details.sequence);
  assert.ok(retained.includes(8));
  assert.ok(!retained.includes(1));
});
