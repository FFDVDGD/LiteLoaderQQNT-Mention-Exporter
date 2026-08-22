"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { SenderContextBuffer } = require("../lib/context.js");

function record(id) {
  return { message: { id } };
}

test("collects the same sender's previous, mention, and next message", () => {
  const ready = [];
  const buffer = new SenderContextBuffer((context) => ready.push(context));

  buffer.accept("group-a:sender-a", record("previous"), false);
  buffer.accept("group-a:sender-b", record("other-sender"), false);
  buffer.accept("group-a:sender-a", record("mention"), true);
  buffer.accept("group-a:sender-b", record("other-sender-2"), false);
  buffer.accept("group-a:sender-a", record("next"), false);

  assert.equal(ready.length, 1);
  assert.deepEqual(ready[0].records.map((item) => item.message.id), [
    "previous",
    "mention",
    "next",
  ]);
  assert.equal(ready[0].mention.message.id, "mention");
  assert.equal(ready[0].timedOut, false);
  buffer.clear();
});

test("a consecutive mention completes the first context and starts another", () => {
  const ready = [];
  const buffer = new SenderContextBuffer((context) => ready.push(context));

  buffer.accept("group:sender", record("previous"), false);
  buffer.accept("group:sender", record("mention-1"), true);
  buffer.accept("group:sender", record("mention-2"), true);
  buffer.accept("group:sender", record("next"), false);

  assert.deepEqual(ready.map((context) => context.records.map((item) => item.message.id)), [
    ["previous", "mention-1", "mention-2"],
    ["mention-1", "mention-2", "next"],
  ]);
  buffer.clear();
});

test("times out with the available previous and mention messages", async () => {
  const ready = [];
  const buffer = new SenderContextBuffer((context) => ready.push(context), 5);

  buffer.accept("group:sender", record("previous"), false);
  buffer.accept("group:sender", record("mention"), true);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(ready.length, 1);
  assert.deepEqual(ready[0].records.map((item) => item.message.id), ["previous", "mention"]);
  assert.equal(ready[0].timedOut, true);
  buffer.clear();
});

test("starts at the mention when the plugin has no previous message", () => {
  const ready = [];
  const buffer = new SenderContextBuffer((context) => ready.push(context));

  buffer.accept("group:sender", record("mention"), true);
  buffer.accept("group:sender", record("next"), false);

  assert.deepEqual(ready[0].records.map((item) => item.message.id), ["mention", "next"]);
  buffer.clear();
});
