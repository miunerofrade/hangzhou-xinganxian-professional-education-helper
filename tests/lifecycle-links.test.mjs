import { test } from "node:test";
import assert from "node:assert/strict";
import { createLifecycle } from "../src/lifecycle.js";
import { createCourseLinks } from "../src/course-links.js";
class Channel {
  handlers = new Set();
  sent = [];
  addEventListener(type, handler) {
    this.handlers.add(handler);
  }
  removeEventListener(type, handler) {
    this.handlers.delete(handler);
  }
  postMessage(message) {
    this.sent.push(message);
    this.onSend?.(message);
  }
  reply(message) {
    for (const fn of [...this.handlers]) fn({ data: message });
  }
}
test("missing course links time out without opening a browser window", async () => {
  const owner = createLifecycle(),
    channel = new Channel();
  const links = createCourseLinks({ channel, lifecycle: owner, timeoutMs: 5 });
  try {
    assert.equal(await links.connect("run", "job", "7"), null);
    assert.equal(channel.sent.length, 1);
    assert.equal(channel.sent[0].type, "course-link-probe");
  } finally {
    owner.dispose();
  }
  assert.equal(channel.handlers.size, 0);
});
test("reconnection validates nonce, run, job and course; close requires real acknowledgement", async () => {
  const owner = createLifecycle(),
    channel = new Channel(),
    links = createCourseLinks({ channel, lifecycle: owner, timeoutMs: 20 });
  channel.onSend = (m) => {
    if (m.type === "course-link-probe") {
      for (const wrong of [{ run: "other" }, { job: "old" }, { id: "8" }, { nonce: "stale" }])
        channel.reply({ ...m, ...wrong, type: "course-link-present" });
      channel.reply({ ...m, type: "course-link-present" });
    }
  };
  const handle = await links.connect("run", "job", "7");
  assert.equal(handle.run, "run");
  assert.equal(handle.closed, false);
  handle.close();
  assert.equal(channel.sent.at(-1).type, "course-link-close");
  assert.equal(handle.closed, false, "asking to close does not prove closure");
  channel.reply({
    type: "course-link-closed",
    run: "run",
    job: "old",
    id: "7",
  });
  assert.equal(handle.closed, false);
  channel.reply({
    type: "course-link-closed",
    run: "run",
    job: "job",
    id: "7",
  });
  assert.equal(handle.closed, true);
  channel.reply({ type: "heartbeat", run: "run", job: "job", id: "7" });
  assert.equal(handle.closed, false, "same job may finish its own page reload");
  assert.equal(await links.connect("run", "job", "7"), handle, "one handle per job");
  owner.dispose();
});
test("unloading resolves pending reconnection and never keeps a dangling request", async () => {
  const owner = createLifecycle(),
    channel = new Channel(),
    links = createCourseLinks({ channel, lifecycle: owner, timeoutMs: 10000 });
  const waiting = links.connect("run", "job", "7");
  owner.dispose();
  assert.equal(await waiting, null);
  assert.equal(channel.handlers.size, 0);
  assert.equal(await links.connect("run", "job", "7"), null);
  assert.equal(channel.sent.length, 1);
});
test("lifecycle teardown removes listeners and timers once, even if a disposer fails", async () => {
  const owner = createLifecycle(),
    target = new EventTarget();
  let calls = 0,
    timed = 0,
    cleaned = 0;
  owner.on(target, "ping", () => calls++);
  owner.interval(() => timed++, 2);
  owner.timeout(() => timed++, 2);
  owner.defer(() => cleaned++);
  owner.defer(() => {
    throw new Error("cleanup failure");
  });
  target.dispatchEvent(new Event("ping"));
  owner.dispose();
  owner.dispose();
  target.dispatchEvent(new Event("ping"));
  await new Promise((resolve) => setTimeout(resolve, 8));
  assert.equal(calls, 1);
  assert.equal(timed, 0);
  assert.equal(cleaned, 1);
  assert.equal(owner.disposed, true);
  owner.timeout(() => timed++, 0);
  owner.interval(() => timed++, 1);
  assert.equal(timed, 0);
});
