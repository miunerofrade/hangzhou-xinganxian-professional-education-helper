import { test } from "node:test";
import assert from "node:assert/strict";
import { createRecovery } from "../src/recovery.js";
import { createRecoveryClient } from "../src/recovery-client.js";

function harness() {
  const values = new Map(),
    timers = [],
    sent = [],
    opened = [];
  const job = { job: "J", course: { id: "7" }, startedAt: Date.now() };
  const state = {
    active: true,
    paused: false,
    manualPaused: false,
    busy: true,
    recovering: false,
    current: job,
    child: {
      closed: false,
      close() {
        this.closed = true;
      },
    },
  };
  const storage = {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  };
  const recovery = createRecovery({
    state,
    repository: { state: { scope: "account" }, identity: async () => "account" },
    channel: { postMessage: (m) => sent.push(m) },
    panel: { status: () => {} },
    session: "R",
    openCourse: (course) => {
      opened.push(course);
      state.current = { ...job, job: "new-job" };
      return true;
    },
    probePlayers: async () => {},
    checkCenter: async () => {},
    isMonitorBusy: () => false,
    lifecycle: {
      disposed: false,
      timeout: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
    },
  });
  return { state, job, timers, sent, opened, storage, recovery };
}
async function withClock(run) {
  const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const navigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const timeout = globalThis.setTimeout;
  const h = harness();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: h.storage });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: { request: async (_name, _options, fn) => fn({}) } },
  });
  globalThis.setTimeout = (fn) => {
    queueMicrotask(fn);
    return 1;
  };
  try {
    await run(h);
  } finally {
    globalThis.setTimeout = timeout;
    if (storage) Object.defineProperty(globalThis, "localStorage", storage);
    else delete globalThis.localStorage;
    if (navigator) Object.defineProperty(globalThis, "navigator", navigator);
    else delete globalThis.navigator;
  }
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
test("a fatal-media request received while busy is queued and runs without another worker request", async () =>
  withClock(async (h) => {
    assert.equal(h.recovery.request(h.job, "媒体解码错误").status, "queued");
    assert.equal(h.opened.length, 0);
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].ms, 2000);
    h.recovery.request(h.job, "媒体解码错误");
    assert.equal(h.timers.length, 1, "coalesce repeated requests");
    h.state.busy = false;
    h.timers.shift().fn();
    await flush();
    assert.equal(h.opened.length, 1);
    assert.equal(h.opened[0].id, "7");
    assert.ok(h.sent.some((m) => m.type === "recovery-close"));
  }));
test("queued recovery never overrides manual pause or follows a replaced job", async () =>
  withClock(async (h) => {
    h.recovery.request(h.job, "解码错误");
    h.state.busy = false;
    h.state.manualPaused = true;
    h.timers.shift().fn();
    await flush();
    assert.equal(h.opened.length, 0);
    assert.equal(h.recovery.request(h.job, "解码错误").status, "blocked");
    h.state.manualPaused = false;
    h.state.busy = true;
    h.recovery.request(h.job, "解码错误");
    h.state.current = { job: "different", course: { id: "8" } };
    h.state.busy = false;
    h.timers.shift().fn();
    await flush();
    assert.equal(h.opened.length, 0);
  }));
test("worker retries unacknowledged recovery with one request ID, then stops after a valid receipt", () => {
  const sent = [],
    receipts = [];
  let now = 0;
  const client = createRecoveryClient({
    send: (type, extra) => sent.push({ type, ...extra }),
    onReceipt: (m) => receipts.push(m),
    now: () => now,
  });
  client.request("fatal");
  const id = sent[0].requestId;
  now = 9999;
  client.tick();
  assert.equal(sent.length, 1);
  now = 10000;
  client.tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].requestId, id);
  client.acknowledge({ requestId: "stale", status: "queued" });
  now = 20000;
  client.tick();
  assert.equal(sent.length, 3);
  client.acknowledge({ requestId: id, status: "queued" });
  now = 30000;
  client.tick();
  assert.equal(sent.length, 3);
  assert.equal(receipts.length, 1);
  client.clear();
  now = 50000;
  client.tick();
  assert.equal(sent.length, 3);
});
