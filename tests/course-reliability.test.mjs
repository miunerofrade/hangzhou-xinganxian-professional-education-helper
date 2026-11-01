import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture.mjs";
import { createSkinAdapter } from "../src/frames/adapter.js";
import { startFrameWorker, createFrameBridge, FRAME_CHANNEL } from "../src/frames/bridge.js";
import { observePlatformProgress, STALL_MS } from "../src/recovery.js";
import { classify } from "../src/planner.js";
const visible = () => [{}];
function dialog(message, onClick, level = 0) {
  return {
    getClientRects: visible,
    contains: () => false,
    querySelector: () => ({ textContent: message }),
    querySelectorAll: () =>
      ["取消", "确定"].map((label) => ({
        textContent: label,
        disabled: false,
        getClientRects: visible,
        click: () => onClick(label),
      })),
    level,
  };
}
test("stacked known dialogs are handled separately, without repeat clicks or pausing", async () => {
  const clicks = [];
  const first = dialog("是否继续学习？", (label) => clicks.push("resume:" + label));
  const second = dialog("您是否要继续学习?请在2分钟之内点击确定", (label) =>
    clicks.push("presence:" + label),
  );
  const f = fixture(null, { messageBoxes: [first, second] });
  await f.tick();
  f.advance(1000);
  await f.tick();
  await f.tick();
  f.advance(1000);
  await f.tick();
  await f.tick();
  assert.deepEqual(clicks, ["presence:确定", "resume:确定"]);
  assert.equal(
    f.sent.some((m) => m.type === "paused"),
    false,
  );
});
test("recognized single-video collision acknowledges the alert and requests retry, never completion", async () => {
  const f = fixture("同时只能播放一个视频");
  await f.tick();
  f.advance(1000);
  await f.tick();
  assert.deepEqual(f.clicks, ["确定"]);
  assert.ok(f.sent.some((m) => m.type === "recovery-request"));
  assert.equal(
    f.sent.some((m) => m.type === "complete"),
    false,
  );
});
test("background confirmation does not add a second delay before clicking", async () => {
  const f = fixture("您是否要继续学习?请在2分钟之内点击确定", {
    visibilityState: "hidden",
  });
  await f.tick();
  assert.deepEqual(f.clicks, ["确定"]);
});
test("explicit course hours notice is recognized without inventing an awarded amount", async () => {
  assert.deepEqual(classify("学时已达标"), { type: "quota" });
  const f = fixture("学时已达标");
  await f.tick();
  f.advance(1000);
  await f.tick();
  assert.equal(
    f.sent.some((m) => m.type === "complete"),
    false,
  );
  assert.ok(f.sent.some((m) => m.type === "complete-notice" && !("credits" in m)));
});
test("unknown popup has an automatic reopen fallback instead of waiting forever", async () => {
  const f = fixture("未收录的课件提示");
  await f.tick();
  assert.equal(f.clicks.length, 0);
  f.advance(90001);
  await f.tick();
  assert.ok(f.sent.some((m) => m.type === "recovery-request"));
});
function withGlobals(values, work) {
  const saved = new Map(
    Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  return Promise.resolve()
    .then(work)
    .finally(() => {
      for (const [key, descriptor] of saved)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
    });
}
function skin({ blocked = false, unknown = false } = {}) {
  const clicks = [];
  const video = {
    tagName: "VIDEO",
    paused: true,
    muted: false,
    playbackRate: 1,
    currentTime: 0,
    ended: false,
    pause() {
      this.paused = true;
    },
    async play() {
      if (blocked) throw Object.assign(new Error("blocked"), { name: "NotAllowedError" });
      this.paused = false;
    },
  };
  const start = {
    getClientRects: visible,
    textContent: "播放视频",
    click() {
      clicks.push("playVideo");
    },
  };
  const toggle = {
    getClientRects: visible,
    textContent: "",
    click() {
      clicks.push("toPause");
      video.paused = !video.paused;
    },
  };
  const root = {
    querySelector: () => (unknown ? null : {}),
    querySelectorAll: (q) =>
      q === "video,audio"
        ? [video]
        : q === "#playVideo" && !unknown
          ? [start]
          : q === "#toPause" && !unknown
            ? [toggle]
            : [],
  };
  return { root, video, clicks };
}
test("two-stage skin starts once and only uses the pause toggle when actually paused", async () => {
  await withGlobals({ getComputedStyle: () => ({ visibility: "visible" }) }, async () => {
    const s = skin(),
      adapter = createSkinAdapter(s.root);
    adapter.inspect({ muted: true });
    await Promise.resolve();
    assert.deepEqual(s.clicks, ["playVideo"]);
    assert.equal(s.video.paused, false);
    assert.equal(s.video.muted, true);
    adapter.inspect({ muted: true });
    assert.equal(s.clicks.length, 1, "do not toggle a running video");
    adapter.inspect({ enabled: false, muted: true });
    assert.equal(s.video.paused, true);
    adapter.inspect({ enabled: true, muted: true, gesture: true });
    assert.equal(s.video.paused, false);
    assert.deepEqual(s.clicks, ["playVideo", "toPause", "toPause"]);
    assert.equal(s.video.currentTime, 0);
    assert.equal(s.video.playbackRate, 1);
  });
});
test("unknown skins stay unsupported and browser autoplay rejection is reported", async () => {
  await withGlobals({ getComputedStyle: () => ({ visibility: "visible" }) }, async () => {
    const unknown = skin({ unknown: true });
    assert.equal(createSkinAdapter(unknown.root).inspect().supported, false);
    const blocked = skin({ blocked: true }),
      adapter = createSkinAdapter(blocked.root);
    adapter.inspect({ muted: true });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const report = adapter.inspect({ muted: true });
    assert.equal(report.state, "blocked");
    assert.equal(report.error, "NotAllowedError");
  });
});
test("frame worker accepts only authenticated top-page messages and sends no credentials", async () => {
  const handlers = new Map(),
    out = [],
    top = {};
  const s = skin();
  top.postMessage = (message, origin) => out.push({ message, origin });
  await withGlobals(
    {
      window: { top, addEventListener: (type, fn) => handlers.set(type, fn) },
      document: s.root,
      getComputedStyle: () => ({ visibility: "visible" }),
    },
    async () => {
      startFrameWorker();
      const receive = handlers.get("message");
      const data = {
        channel: FRAME_CHANNEL,
        type: "inspect",
        nonce: "task",
        enabled: true,
        muted: true,
      };
      receive({ origin: "https://evil.example", source: top, data });
      assert.equal(out.length, 0);
      receive({
        origin: "https://learning.hzrs.hangzhou.gov.cn",
        source: {},
        data,
      });
      assert.equal(out.length, 0);
      receive({
        origin: "https://learning.hzrs.hangzhou.gov.cn",
        source: top,
        data,
      });
      assert.equal(out.length, 1);
      assert.equal(out[0].message.nonce, "task");
      assert.equal(out[0].message.supported, true);
      assert.equal(out[0].origin, "https://learning.hzrs.hangzhou.gov.cn");
    },
  );
});
test("a cross-origin frame needs source, origin and nonce to report support", async () => {
  let receiver;
  const child = {
    postMessage(message) {
      this.request = message;
    },
  };
  const frame = {
    contentWindow: child,
    getAttribute: (name) =>
      name === "src" ? "https://xc-course.hzrs.hangzhou.gov.cn:5443/zj/2023/zy23400/zj.html" : null,
  };
  Object.defineProperty(frame, "contentDocument", {
    get() {
      throw new Error("cross-origin");
    },
  });
  await withGlobals(
    {
      window: {
        addEventListener: (type, fn) => {
          if (type === "message") receiver = fn;
        },
      },
      location: { href: "https://learning.hzrs.hangzhou.gov.cn/" },
      crypto: { randomUUID: () => "nonce" },
    },
    async () => {
      const bridge = createFrameBridge();
      assert.equal(bridge.inspect([frame], { enabled: true, muted: true }).state, "waiting");
      receiver({
        origin: "https://evil.example",
        source: child,
        data: {
          channel: FRAME_CHANNEL,
          type: "report",
          nonce: "nonce",
          supported: true,
          state: "playing",
        },
      });
      assert.equal(bridge.inspect([frame]).supported, false);
      receiver({
        origin: "https://xc-course.hzrs.hangzhou.gov.cn:5443",
        source: child,
        data: {
          channel: FRAME_CHANNEL,
          type: "report",
          nonce: "wrong",
          supported: true,
          state: "playing",
        },
      });
      assert.equal(bridge.inspect([frame]).supported, false);
      receiver({
        origin: "https://xc-course.hzrs.hangzhou.gov.cn:5443",
        source: child,
        data: {
          channel: FRAME_CHANNEL,
          type: "report",
          nonce: "nonce",
          supported: true,
          state: "playing",
        },
      });
      assert.equal(bridge.inspect([frame]).state, "playing");
    },
  );
});
test("only an actual increase in platform seconds resets the stall clock", () => {
  const job = { startedAt: 1000, lastProgressAt: 1000 };
  observePlatformProgress(job, 0, 2000);
  assert.equal(job.lastProgressAt, 1000);
  observePlatformProgress(job, 5, 3000);
  assert.equal(job.lastProgressAt, 3000);
  observePlatformProgress(job, 5, 3000 + STALL_MS);
  assert.equal(job.lastProgressAt, 3000);
  observePlatformProgress(job, 4, 4000 + STALL_MS);
  assert.equal(job.lastProgressAt, 3000);
});

test("the top course page operates a recognized iframe instead of skipping it", async () => {
  const s = skin();
  const frame = {
    getClientRects: visible,
    getAttribute: (name) =>
      name === "src" ? "https://learning.hzrs.hangzhou.gov.cn/course/index.html" : null,
    contentDocument: s.root,
  };
  const f = fixture(null, { noVideo: true, frames: [frame] });
  await f.tick();
  f.advance(11000);
  await f.tick();
  assert.equal(s.video.paused, false);
  assert.deepEqual(s.clicks, ["playVideo"]);
  assert.equal(
    f.sent.some((m) => m.type === "iframe-skip"),
    false,
  );
  f.nodes.get("#playback-toggle").onclick();
  assert.equal(s.video.paused, true);
  f.nodes.get("#playback-toggle").onclick({ isTrusted: true });
  assert.equal(s.video.paused, false);
});
test("manually opened course pages have a two-second reload fallback", async () => {
  let reloads = 0;
  const f = fixture("未识别且持续存在的弹窗", {
    direct: true,
    onReload: () => reloads++,
  });
  await f.tick();
  f.advance(90001);
  await f.tick();
  const timer = f.timeouts.findLast((t) => t.ms === 2000);
  assert.ok(timer);
  assert.equal(reloads, 0);
  timer.fn();
  assert.equal(reloads, 1);
  assert.equal(
    f.sent.some((m) => m.type === "complete"),
    false,
  );
});

test("background stacks are drained in one task rather than one throttled minute per dialog", async () => {
  const clicks = [];
  const boxes = [
    dialog("是否继续学习？", (label) => clicks.push(label)),
    dialog("您是否要继续学习?请在2分钟之内点击确定", (label) => clicks.push(label)),
  ];
  const f = fixture(null, { visibilityState: "hidden", messageBoxes: boxes });
  await f.tick();
  assert.deepEqual(clicks, ["确定", "确定"]);
  assert.equal(
    f.sent.some((m) => m.type === "paused"),
    false,
  );
});
test("recognized conflict is handled even before a main player has appeared", async () => {
  const f = fixture("同时只能播放一个视频", { noVideo: true });
  await f.tick();
  f.advance(1000);
  await f.tick();
  assert.ok(f.sent.some((m) => m.type === "recovery-request"));
  assert.deepEqual(f.clicks, ["确定"]);
});
test("an explicit completion dialog is handled before a media error can block it", async () => {
  const overlay = mediaErrorDialog("The media playback was aborted due to a corruption problem");
  const f = fixture("您的学习时间已达到要求，获得学分:0.5,是否继续学习?", {
    video: { error: { code: 3 } },
    semanticDialogs: [overlay],
    mediaErrorDialogs: [overlay],
  });
  await f.tick();
  f.advance(1000);
  await f.tick();
  assert.ok(f.sent.some((m) => m.type === "complete"));
  assert.equal(
    f.sent.some((m) => m.type === "recovery-request"),
    false,
  );
  assert.deepEqual(f.clicks, ["取消"]);
});

test("an ended embedded video is not restarted while awaiting platform completion", async () => {
  await withGlobals({ getComputedStyle: () => ({ visibility: "visible" }) }, async () => {
    const s = skin();
    s.video.ended = true;
    const result = createSkinAdapter(s.root).inspect({ muted: true });
    assert.equal(result.ended, true);
    assert.equal(result.state, "ended");
    assert.equal(s.clicks.length, 0);
  });
});

test("unreadable frames never become unknown skins or permanent exclusions", async () => {
  for (const src of [
    "https://xc-course.hzrs.hangzhou.gov.cn:5443/lesson?token=secret",
    "https://unconfigured.example/lesson",
  ]) {
    const frame = {
      getClientRects: visible,
      getAttribute: (name) => (name === "src" ? src : null),
      contentDocument: null,
      contentWindow: { postMessage() {} },
    };
    const f = fixture(null, { noVideo: true, frames: [frame] });
    await f.tick();
    f.advance(11000);
    await f.tick();
    assert.equal(
      f.sent.some((m) => m.type === "iframe-skip"),
      false,
    );
    assert.match(f.nodes.get("#state").textContent, /不会按未知样式跳过/);
    f.advance(90000);
    await f.tick();
    assert.equal(
      f.sent.some((m) => m.type === "iframe-skip"),
      false,
    );
    assert.ok(f.sent.some((m) => m.type === "recovery-request"));
  }
});

test("an accessible wrapper does not prove its cross-origin child has an unknown skin", () => {
  const nested = { contentDocument: null };
  const root = {
    readyState: "complete",
    querySelectorAll: (selector) => (selector === "iframe" ? [nested] : []),
    querySelector: () => null,
  };
  assert.equal(createSkinAdapter(root).inspect().state, "inaccessible");
  nested.contentDocument = {
    readyState: "loading",
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  assert.equal(createSkinAdapter(root).inspect().state, "waiting");
  nested.contentDocument.readyState = "complete";
  assert.equal(createSkinAdapter(root).inspect().state, "unknown");
});

test("one playback control follows actual media state and preserves trusted-click resume", async () => {
  const f = fixture(null, {
    direct: true,
    video: { paused: true, currentTime: 0 },
  });
  assert.equal(f.nodes.has("#resume"), false);
  await f.tick();
  const toggle = f.nodes.get("#playback-toggle");
  assert.equal(toggle.getAttribute("aria-label"), "暂停");
  toggle.onclick({ isTrusted: true });
  assert.equal(f.video.paused, true);
  assert.equal(toggle.getAttribute("aria-label"), "继续播放");
  assert.equal(
    f.nodes.get("#status-line").hidden,
    true,
    "manual pause needs no duplicate status text",
  );
  toggle.onclick({ isTrusted: true });
  assert.equal(f.video.paused, false);
  await Promise.resolve();
  assert.equal(toggle.getAttribute("aria-label"), "暂停");
  f.video.paused = true;
  await f.tick();
  assert.equal(toggle.getAttribute("aria-label"), f.video.paused ? "继续播放" : "暂停");
});

function mediaErrorDialog(message) {
  const owner = {
    querySelector: (selector) => (selector === "video" ? {} : null),
  };
  return {
    textContent: message,
    getClientRects: visible,
    matches: (selector) => selector === ".vjs-error-display",
    closest: (selector) => (selector === ".video-js" ? owner : null),
  };
}
test("Video.js error dialogs trigger one recovery, not an unknown-dialog pause or completion", async () => {
  const overlay = mediaErrorDialog(
    "The media playback was aborted due to a corruption problem or because the media used features your browser did not support.",
  );
  for (const code of [3, 4]) {
    const f = fixture(null, {
      video: { error: { code } },
      semanticDialogs: [overlay],
      mediaErrorDialogs: [overlay],
    });
    await f.tick();
    await f.tick();
    assert.equal(f.sent.filter((m) => m.type === "recovery-request").length, 1);
    assert.equal(
      f.sent.some((m) => m.type === "paused"),
      false,
    );
    assert.equal(
      f.sent.some((m) => m.type === "complete"),
      false,
    );
    const logs = JSON.parse(f.storage.get("hz-helper-events-v1"));
    assert.ok(logs.some((row) => row.level === "error" && row.detail.includes(`code=${code}`)));
  }
});
test("visible player error text can recover when the native video is hidden", async () => {
  const overlay = mediaErrorDialog("The media playback was aborted due to a corruption problem");
  const f = fixture(null, {
    noVideo: true,
    semanticDialogs: [overlay],
    mediaErrorDialogs: [overlay],
  });
  await f.tick();
  assert.ok(f.sent.some((m) => m.type === "recovery-request" && m.reason.includes("videojs")));
  assert.equal(
    f.sent.some((m) => m.type === "paused"),
    false,
  );
});
test("real unknown dialogs and explicit manual pause retain priority over media recovery", async () => {
  const unknown = { getClientRects: visible };
  const blocked = fixture(null, {
    video: { error: { code: 3 } },
    semanticDialogs: [unknown],
  });
  await blocked.tick();
  assert.ok(blocked.sent.some((m) => m.type === "paused"));
  assert.equal(
    blocked.sent.some((m) => m.type === "recovery-request"),
    false,
  );
  const f = fixture(null);
  await f.tick();
  f.nodes.get("#playback-toggle").onclick();
  f.video.error = { code: 3 };
  await f.tick();
  assert.equal(
    f.sent.some((m) => m.type === "recovery-request"),
    false,
  );
});
test("persistent network errors recover after the existing grace period", async () => {
  const f = fixture(null, { video: { error: { code: 2 } } });
  await f.tick();
  f.advance(179999);
  await f.tick();
  assert.equal(
    f.sent.some((m) => m.type === "recovery-request"),
    false,
  );
  f.advance(1);
  await f.tick();
  assert.ok(f.sent.some((m) => m.type === "recovery-request"));
  assert.equal(
    f.sent.some((m) => m.type === "complete"),
    false,
  );
});

test("a manually opened course with a fatal media error uses the two-second reload fallback", async () => {
  let reloads = 0;
  const f = fixture(null, {
    direct: true,
    video: { error: { code: 3 } },
    onReload: () => reloads++,
  });
  await f.tick();
  assert.equal(reloads, 0);
  const timer = f.timeouts.find((t) => t.ms === 2000);
  assert.ok(timer);
  await timer.fn();
  assert.equal(reloads, 1);
  assert.equal(f.savedRecords()["7"]?.kind, undefined);
});
