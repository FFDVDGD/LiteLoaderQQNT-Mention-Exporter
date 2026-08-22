"use strict";

class SenderContextBuffer {
  constructor(onReady, timeoutMs = 120000) {
    this.onReady = onReady;
    this.timeoutMs = timeoutMs;
    this.previous = new Map();
    this.pending = new Map();
  }

  accept(key, record, trigger) {
    const previous = this.previous.get(key);
    const pending = this.pending.get(key);

    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(key);
      this.onReady({
        mention: pending.mention,
        records: [...pending.records, record],
        timedOut: false,
      });
    }

    this.previous.set(key, record);
    if (!trigger) return;

    const context = {
      mention: record,
      records: previous ? [previous, record] : [record],
      timer: null,
    };
    context.timer = setTimeout(() => {
      if (this.pending.get(key) !== context) return;
      this.pending.delete(key);
      this.onReady({
        mention: context.mention,
        records: context.records,
        timedOut: true,
      });
    }, this.timeoutMs);
    context.timer.unref?.();
    this.pending.set(key, context);
  }

  clear() {
    for (const context of this.pending.values()) clearTimeout(context.timer);
    this.previous.clear();
    this.pending.clear();
  }
}

module.exports = { SenderContextBuffer };
