import { createRepository } from "../src/repository.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeJSON, migrateCourse } from "../src/storage.js";
import { createScanner } from "../src/scanner.js";
import { requestPlayback, playbackBlocked } from "../src/playback.js";
import { goalReached, projectProgress } from "../src/planner.js";

test("persistence skips equal values and checks actual storage after another writer", () => {
  const values = new Map(),
    writes = [];
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      writes.push(key);
      values.set(key, value);
    },
  };
  assert.equal(writeJSON("x", { a: 1 }, storage), true);
  assert.equal(writeJSON("x", { a: 1 }, storage), false);
  values.set("x", "{}");
  assert.equal(writeJSON("x", { a: 1 }, storage), true);
  assert.equal(writes.length, 2);
});
test("legacy credit cache migrates once; explicit hours take precedence", () => {
  assert.deepEqual(migrateCourse({ id: "old", credits: 2 }), { id: "old", hours: 2 });
  assert.deepEqual(migrateCourse({ id: "new", credits: 2, hours: 3 }), { id: "new", hours: 3 });
});
test("scan lookup is read only until an explicit initialization", () => {
  const state = { cache: {}, scope: "account" };
  const scanner = createScanner({ repository: { state }, getBase: () => null });
  const before = JSON.stringify(state);
  assert.equal(scanner.scanFor({ category: "专业课程" }).scan.nextPage, 1);
  assert.equal(scanner.hasMore({ category: "专业课程" }), true);
  assert.equal(JSON.stringify(state), before);
  const initialized = scanner.scanFor({ category: "专业课程" }, true).scan;
  assert.equal(state.cache.categoryScans["专业课程"], initialized);
});
test("projection and goal checks share category and total requirements", () => {
  const base = { total: 1, professional: 1, public: 0 };
  const projected = projectProgress(base, [{ hours: 2, category: "一般公需" }]);
  assert.deepEqual(base, { total: 1, professional: 1, public: 0 });
  assert.deepEqual(projected, { total: 3, professional: 1, public: 2 });
  const settings = {
    category: "auto",
    targetMode: "absolute",
    target: 3,
    professional: 2,
    public: 2,
  };
  assert.equal(goalReached(settings, 3, projected), false);
  assert.equal(goalReached({ ...settings, professional: 1 }, 3, projected), true);
  assert.equal(
    goalReached({ ...settings, targetMode: "increment", mode: "annual", target: 1 }, 1, base),
    true,
  );
});
test("play starts in the caller stack to retain trusted user activation", async () => {
  const calls = [];
  const pending = requestPlayback({
    play() {
      calls.push("play");
      return Promise.resolve();
    },
  });
  calls.push("returned");
  assert.deepEqual(calls, ["play", "returned"]);
  await pending;
  for (const name of ["NotAllowedError", "SecurityError", "NotSupportedError"])
    assert.equal(playbackBlocked({ name }), true);
  assert.equal(playbackBlocked({ name: "AbortError" }), false);
});

test("log levels distinguish normal events, recoverable warnings and errors, including older rows", async () => {
  const { eventLevel } = await import("../src/event-log.js");
  assert.equal(eventLevel({ kind: "query", event: "查询完成" }), "info");
  assert.equal(eventLevel({ kind: "query", event: "查询重试" }), "warning");
  assert.equal(eventLevel({ kind: "error", event: "查询失败" }), "error");
  assert.equal(eventLevel({ kind: "auth", http: 401 }), "error");
  assert.equal(eventLevel({ kind: "progress", level: "warning" }), "warning");
  assert.equal(eventLevel({ level: "invalid", kind: "page" }), "info");
});

test("shared progress rendering distinguishes unknown from zero and clears stale accessibility values", async () => {
  const { renderProgressBar } = await import("../src/ui/progress-bar.js");
  const attrs = new Map();
  const track = {
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
  };
  const fill = { style: {} };
  renderProgressBar(track, fill, 0);
  assert.equal(attrs.get("aria-valuenow"), "0");
  renderProgressBar(track, fill, null, "未取得平台进度");
  assert.equal(attrs.has("aria-valuenow"), false);
  assert.equal(attrs.get("aria-valuetext"), "未取得平台进度");
  renderProgressBar(track, fill, 125);
  assert.equal(fill.style.width, "100%");
  assert.equal(attrs.has("aria-valuetext"), false);
  renderProgressBar(track, fill, -5);
  assert.equal(fill.style.width, "0%");
});

test("settings keep typed values and avoid equal writes while respecting another tab", () => {
  const old = globalThis.localStorage,
    values = new Map();
  let writes = 0;
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
      writes++;
    },
  };
  const nodes = new Map();
  const $ = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, { value: "15", checked: false });
    return nodes.get(selector);
  };
  try {
    const repo = createRepository({ panel: { $ } });
    repo.state.scope = "user-a";
    $("#auto").checked = true;
    repo.saveSettings();
    const key = "hz-helper-settings-v1:user-a";
    let saved = JSON.parse(values.get(key));
    assert.equal(saved.auto, true);
    assert.equal(saved["annual-limit"], false);
    assert.equal(saved["refresh-minutes"], "15");
    repo.saveSettings();
    assert.equal(writes, 1);
    values.set(key, "{}");
    repo.saveSettings();
    assert.equal(writes, 2);
    $("#target").value = "60";
    repo.saveSettings();
    saved = JSON.parse(values.get(key));
    assert.equal(saved.target, "60");
    assert.equal(writes, 3);
  } finally {
    if (old === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = old;
  }
});
