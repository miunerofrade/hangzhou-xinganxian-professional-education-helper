import { test } from "node:test";
import assert from "node:assert/strict";
import { createMenuMotion } from "../src/ui/motion.js";
function setup({ reduced = false } = {}) {
  const previousWindow = globalThis.window,
    previousComputed = globalThis.getComputedStyle;
  globalThis.window = { innerWidth: 1000 };
  globalThis.getComputedStyle = (node) => ({ opacity: node.style.opacity || "1" });
  const tracks = [];
  function node(name, rect) {
    return {
      hidden: name === "panel",
      style: {},
      getBoundingClientRect: () => rect,
      animate(frames, options) {
        let finish, reject;
        const finished = new Promise((resolve, fail) => {
          finish = resolve;
          reject = fail;
        });
        const track = {
          name,
          frames,
          options,
          finished,
          finish,
          cancel() {
            this.cancelled = true;
            reject(new Error("cancelled"));
          },
        };
        tracks.push(track);
        return track;
      },
    };
  }
  const panel = node("panel", { left: 568, right: 988, width: 420 });
  const launcher = node("ball", { left: 942, right: 988, width: 46 });
  return {
    panel,
    launcher,
    tracks,
    motion: createMenuMotion({ panel, launcher, reducedMotion: () => reduced }),
    restore() {
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
      if (previousComputed === undefined) delete globalThis.getComputedStyle;
      else globalThis.getComputedStyle = previousComputed;
    },
  };
}
test("close tracks overlap and keep the offscreen frame until the menu is hidden", async () => {
  const f = setup();
  try {
    f.panel.hidden = false;
    f.motion.transition(false);
    const menu = f.tracks.find((t) => t.name === "panel"),
      ball = f.tracks.find((t) => t.name === "ball");
    assert.equal(menu.options.fill, "both");
    assert.equal(ball.options.fill, "both");
    assert.ok(
      ball.options.delay < menu.options.duration,
      "ball enters before the menu stops moving",
    );
    assert.match(menu.frames[1].transform, /translate3d/);
    assert.equal(f.panel.hidden, false);
    menu.finish();
    await Promise.resolve();
    assert.equal(f.panel.hidden, true);
    assert.equal(menu.cancelled, true);
    assert.equal(ball.cancelled, undefined, "ball continues independently of menu cleanup");
    ball.finish();
    await Promise.resolve();
    assert.equal(f.launcher.style.opacity, "");
    assert.equal(f.launcher.style.willChange, "");
  } finally {
    f.restore();
  }
});
test("open tracks are scheduled together with a non-linear overlapping handoff", () => {
  const f = setup();
  try {
    f.motion.transition(true);
    assert.equal(f.tracks.length, 2);
    const menu = f.tracks.find((t) => t.name === "panel"),
      ball = f.tracks.find((t) => t.name === "ball");
    assert.ok(menu.options.delay > 0 && menu.options.delay < ball.options.duration);
    assert.match(menu.options.easing, /cubic-bezier/);
    assert.equal(menu.options.fill, "both");
    f.motion.transition(false);
    assert.equal(menu.cancelled, true);
    assert.equal(ball.cancelled, true);
  } finally {
    f.restore();
  }
});
test("reduced motion switches directly without layers or animation tracks", () => {
  const f = setup({ reduced: true });
  try {
    f.motion.transition(true);
    assert.equal(f.panel.hidden, false);
    f.motion.transition(false);
    assert.equal(f.panel.hidden, true);
    assert.equal(f.tracks.length, 0);
    assert.equal(f.launcher.style.opacity, "");
  } finally {
    f.restore();
  }
});
