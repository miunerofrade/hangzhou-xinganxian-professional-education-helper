import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../fixture.mjs";
import { catalogResponse } from "./catalogs.mjs";

await test("startup iframe auto-recognition retry, automatic playback after main player appears, visible main player priority, renderer node replacement retry.", async () => {
  let f = fixture();

  // A temporary iframe at boot must not require clicking Continue to recover.
  const startup = { iframe: true, video: { paused: true, currentTime: 0 } };
  f = fixture(null, startup);
  await f.tick();
  f.advance(20000);
  await f.tick();
  assert.equal(
    f.sent.some((m) => m.type === "paused"),
    false,
  );
  startup.iframe = false;
  await f.tick();
  assert.equal(
    f.video.paused,
    false,
    "main player starts automatically after temporary iframe disappears",
  );
  assert.equal(
    f.sent.some((m) => m.type === "paused"),
    false,
  );

  // A visible main player wins even if a separate iframe is present.
  const both = { iframe: false, visibleFrame: true, video: { paused: true, currentTime: 0 } };
  f = fixture(null, both);
  await f.tick();
  assert.equal(f.video.paused, false);
  assert.equal(
    f.sent.some((m) => m.type === "paused"),
    false,
  );

  // Renderer replacing the video node resets initial-start retries for the new element.
  const changing = { video: { paused: true, currentTime: 0 } };
  f = fixture(null, changing);
  await f.tick();
  assert.equal(f.video.paused, false);
  const replacement = {
    paused: true,
    playbackRate: 1,
    readyState: 4,
    ended: false,
    error: null,
    currentTime: 0,
    getClientRects: () => [{}],
    pause() {
      this.paused = true;
    },
    async play() {
      this.paused = false;
    },
  };
  changing.videoNode = replacement;
  await f.tick();
  assert.equal(replacement.paused, false);
});

await test("verified iframe is excluded without completion; optional screen wake lock can be acquired and released.", async () => {
  const verifiedFrame = {
    contentDocument: {
      readyState: "complete",
      querySelectorAll: () => [],
      querySelector: () => null,
    },
    getClientRects: () => [{}],
    getAttribute: (key) =>
      key === "src" ? "https://xc-course.hzrs.hangzhou.gov.cn:5443/lesson" : null,
  };
  const frameSkip = fixture(null, { noVideo: true, frames: [verifiedFrame] });
  await frameSkip.tick();
  assert.equal(
    frameSkip.sent.some((m) => m.type === "iframe-skip"),
    false,
  );
  frameSkip.advance(11000);
  await frameSkip.tick();
  assert.equal(frameSkip.sent.filter((m) => m.type === "iframe-skip").length, 1);
  assert.equal(
    frameSkip.sent.some((m) => m.type === "complete"),
    false,
    "iframe skip never creates a completion",
  );
  const frameDirect = fixture(null, { direct: true, noVideo: true, frames: [verifiedFrame] });
  await frameDirect.tick();
  frameDirect.advance(11000);
  await frameDirect.tick();
  assert.match(frameDirect.nodes.get("#state").textContent, /返回课程列表/);
  assert.equal(
    frameDirect.sent.some((m) => m.type === "iframe-skip"),
    false,
  );
  const frameController = fixture(null, { controller: true, response: catalogResponse });
  frameController.nodes.get("#target").value = "1";
  await frameController.nodes.get("#plan").onclick();
  await frameController.nodes.get("#start").onclick();
  const frameEntry = [...frameController.storage.entries()].find(
    ([key]) => key.startsWith("hz-helper:") && key !== "hz-helper:R",
  );
  const frameConfig = JSON.parse(frameEntry[1]);
  frameController.deliver({
    type: "iframe-skip",
    run: frameEntry[0].slice("hz-helper:".length),
    job: frameConfig.job,
    id: frameConfig.course.id,
  });
  assert.equal(
    frameController.savedRecords()[frameConfig.course.id],
    undefined,
    "a legacy or uninspected iframe report cannot exclude a course",
  );
  frameController.deliver({
    type: "iframe-skip",
    inspected: true,
    run: frameEntry[0].slice("hz-helper:".length),
    job: frameConfig.job,
    id: frameConfig.course.id,
  });
  assert.equal(frameController.savedRecords()[frameConfig.course.id].kind, "auto-excluded");
  assert.equal(frameController.savedRecords()[frameConfig.course.id].reason, "iframe 课件");
  assert.equal(frameController.nodes.get("#earned").textContent, 0);
  assert.ok(
    frameController.nodes
      .get("#records")
      .children[0].children.some(
        (row) =>
          row.children[0].textContent.includes("自动跳过") &&
          row.children[0].textContent.includes("iframe 课件"),
      ),
  );
  assert.ok(frameController.courseButton(frameConfig.course.id, "恢复", "#records"));
  assert.ok(frameController.sent.some((m) => m.type === "skip"));
  assert.equal(frameController.savedCache().completed.length, 0);
  let released = 0,
    wakeRequests = 0;
  const wakeLock = {
    released: false,
    addEventListener() {},
    async release() {
      released++;
      this.released = true;
    },
  };
  const awake = fixture(null, {
    controller: true,
    navigator: {
      wakeLock: {
        async request() {
          wakeRequests++;
          return wakeLock;
        },
      },
    },
  });
  awake.nodes.get("#keep-awake").checked = true;
  awake.nodes.get("#keep-awake").onchange();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(wakeRequests, 1, "wake lock is acquired without a visible status message");
  awake.nodes.get("#keep-awake").checked = false;
  awake.nodes.get("#keep-awake").onchange();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(released, 1);
});
