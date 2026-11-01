import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, source } from "../fixture.mjs";

await test("completion gating, deduplication, native continuation, unknown dialog/iframe/rate blocking, scheduling order, overnight window, network entry audit.", async () => {
  let f;

  f = fixture("您的学习时间已达到要求，获得学分:2.5,是否继续学习?");
  await f.tick();
  assert.equal(f.clicks.length, 0, "completion button waits");
  f.advance(11000);
  await f.tick();
  assert.deepEqual(f.clicks, ["取消"]);
  assert.equal(f.sent.filter((m) => m.type === "complete").length, 1);
  assert.equal(f.sent.find((m) => m.type === "complete").credits, 2.5);
  assert.equal(f.video.ended, false, "platform completion does not require video end");
  await f.tick();
  assert.equal(f.sent.filter((m) => m.type === "complete").length, 1, "no duplicate completion");

  for (const message of ["是否继续学习？", "您是否要继续学习?请在2分钟之内点击确定"]) {
    f = fixture(message);
    await f.tick();
    f.advance(11000);
    await f.tick();
    assert.deepEqual(f.clicks, ["确定"]);
    assert.equal(
      f.sent.some((m) => m.type === "complete"),
      false,
    );
  }
  const dialogControl = { visible: true };
  f = fixture("是否继续学习？", { dialogControl });
  await f.tick();
  f.advance(11000);
  await f.tick();
  dialogControl.visible = false;
  await f.tick();
  f.advance(120000);
  dialogControl.visible = true;
  await f.tick();
  f.advance(11000);
  await f.tick();
  assert.deepEqual(
    f.clicks,
    ["确定", "确定"],
    "a reused dialog is handled again after it disappears",
  );
  f = fixture("是否继续学习？", { dialogControl: { visible: true } });
  await f.tick();
  f.advance(11000);
  await f.tick();
  f.advance(91000);
  await f.tick();
  assert.equal(f.clicks.length, 1, "a persistent dialog is never clicked twice");
  assert.equal(f.sent.find((m) => m.type === "paused")?.recoverOnDialogClose, true);
  const recoveryDialog = { visible: true };
  f = fixture("是否继续学习？", { dialogControl: recoveryDialog });
  await f.tick();
  f.advance(11000);
  await f.tick();
  f.advance(91000);
  await f.tick();
  recoveryDialog.visible = false;
  await f.tick();
  assert.equal(
    f.sent.some((m) => m.type === "resumed"),
    true,
    "dialog disappearance resumes the paused worker",
  );
  let automaticPlays = 0,
    copiedDiagnostic = "";
  f = fixture(null, {
    navigator: {
      clipboard: {
        async writeText(value) {
          copiedDiagnostic = value;
        },
      },
    },
    video: {
      paused: true,
      currentTime: 0,
      async play() {
        automaticPlays++;
        this.paused = false;
      },
    },
  });
  await f.tick();
  assert.equal(automaticPlays, 1);
  f.video.paused = true;
  f.advance(11000);
  await f.tick();
  assert.equal(automaticPlays, 2, "unexpected pause without a dialog retries playback");
  let playbackEntries = JSON.parse(f.storage.get("hz-helper-events-v1"));
  assert.equal(
    playbackEntries.some((row) => row.event === "检测到视频暂停"),
    true,
  );
  assert.equal(
    playbackEntries.some((row) => row.event === "播放重试已发出"),
    true,
  );
  assert.ok(f.nodes.get("#event-log").children.length, "diagnostics appear in the panel");
  await f.nodes.get("#copy-log").onclick();
  assert.match(copiedDiagnostic, /检测到视频暂停/);
  assert.match(copiedDiagnostic, /第 1\/4 次重试/);
  assert.match(copiedDiagnostic, /"courseId":"7"/);
  assert.match(copiedDiagnostic, /"readyState":4/);
  assert.doesNotMatch(copiedDiagnostic, /fixture-not-a-real-token/);
  assert.equal(f.nodes.get("#log-result").textContent, "日志已复制");
  f.nodes.get("#playback-toggle").onclick();
  f.advance(11000);
  await f.tick();
  assert.equal(automaticPlays, 2, "manual pause is respected");
  assert.equal(JSON.parse(f.storage.get("hz-helper-events-v1")).at(-1).event, "助手暂停");
  f.nodes.get("#clear-log").onclick();
  assert.equal(f.storage.has("hz-helper-events-v1"), false);
  await f.nodes.get("#copy-log").onclick();
  assert.equal(f.nodes.get("#log-result").textContent, "暂无日志");
  let immediatelyPaused = 0;
  f = fixture(null, {
    video: {
      paused: true,
      async play() {
        immediatelyPaused++;
        this.paused = true;
      },
    },
  });
  await f.tick();
  for (let i = 0; i < 5; i++) {
    f.advance(11000);
    await f.tick();
  }
  assert.equal(immediatelyPaused, 5, "unexpected pauses have a bounded retry count");
  assert.equal(
    f.sent.some((m) => m.type === "paused"),
    false,
    "repeated background pauses do not stop the plan",
  );
  assert.match(f.nodes.get("#state").textContent, /等待60秒/);
  f.advance(59000);
  await f.tick();
  assert.equal(immediatelyPaused, 5, "cooldown prevents rapid repeated retries");
  f.advance(2000);
  await f.tick();
  assert.equal(immediatelyPaused, 6, "playback retries again after cooldown");
  assert.ok(JSON.parse(f.storage.get("hz-helper-events-v1")).length <= 30);
  let playerPauseListener;
  f = fixture(null, {
    video: {
      addEventListener(type, fn) {
        if (type === "pause") playerPauseListener = fn;
      },
    },
  });
  await f.tick();
  playerPauseListener();
  assert.equal(JSON.parse(f.storage.get("hz-helper-events-v1")).at(-1).event, "播放器触发暂停事件");
  await f.nodes.get("#copy-log").onclick();
  assert.match(f.nodes.get("#log-result").textContent, /复制失败/);
  let backgroundPlays = 0;
  f = fixture(null, {
    video: {
      paused: true,
      async play() {
        backgroundPlays++;
        this.paused = false;
      },
    },
  });
  await f.tick();
  f.setVisibility("hidden");
  f.video.paused = true;
  f.advance(120000);
  await f.tick();
  assert.equal(backgroundPlays, 1, "a paused background video is not repeatedly restarted");
  assert.equal(
    f.sent.some((m) => m.type === "paused"),
    false,
    "background video pause does not pause the study plan",
  );
  assert.match(f.nodes.get("#state").textContent, /继续核对平台学习进度/);
  f.setVisibility("visible");
  await f.tick();
  assert.equal(backgroundPlays, 2, "playback can resume when the course becomes visible");
  f = fixture("请输入验证码后继续");
  await f.tick();
  assert.equal(f.video.paused, true);
  assert.equal(f.clicks.length, 0);
  f = fixture("是否继续学习？", { autoContinue: false });
  await f.tick();
  f.advance(11000);
  await f.tick();
  assert.equal(f.clicks.length, 0);
  f = fixture(null, { iframe: true });
  await f.tick();
  f.advance(180001);
  await f.tick();
  assert.equal(
    f.sent.some((m) => m.type === "paused"),
    false,
    "iframe can wait beyond three minutes for a platform prompt",
  );
  assert.equal(
    f.sent.some((m) => m.type === "complete"),
    false,
    "elapsed time does not confirm completion",
  );
  f = fixture(null, { video: { playbackRate: 2 } });
  await f.tick();
  assert.equal(f.video.paused, true);
  f = fixture(null, { video: { ended: true } });
  await f.tick();
  assert.equal(
    f.sent.some((m) => m.type === "complete"),
    false,
  );
  const courses = [
    { id: "a", credits: 2, hours: 2, remaining: 600 },
    { id: "b", credits: 5, hours: 5, remaining: 3000 },
  ];
  assert.equal(f.api.rank(courses)[0].id, "a");
  assert.equal(f.api.inWindow("23:00-02:00", new Date(2026, 9, 29, 1, 0)), true);
  assert.equal(f.api.inWindow("23:00-02:00", new Date(2026, 9, 29, 12, 0)), false);
  assert.throws(() => f.api.inWindow("24:00-25:00"));
  for (const message of [
    "是否继续学习",
    "已达到要求",
    "您的学习时间已达到要求，可以提交心得。现在提交心得吗?",
    "请根据您对本课程内容的理解，完成考核题!",
  ])
    assert.equal(f.api.classify(message).type, "unknown");
  assert.equal((source.match(/await fetch\(/g) || []).length, 1, "one allowlisted network entry");
  assert.equal(
    /\.currentTime\s*=(?!=)|\.playbackRate\s*=(?!=)|dispatchEvent\(/.test(source),
    false,
    "no seeking, rate writes or synthetic events",
  );
});

await test("completion-scoped unload suppression with native cleanup, listener removal, retry success/exhaustion/auth handling, write-API refusal, slow DOM grace, play retry, autoplay rejection, recoverable video network errors.", async () => {
  let f;

  // The unload adapter keeps platform cleanup, suppressing cancellation only after explicit completion.
  f = fixture("您的学习时间已达到要求，获得学分:2.5,是否继续学习?");
  let nativeCleanup = 0;
  function originalGuard(event) {
    nativeCleanup++;
    event.preventDefault();
    event.returnValue = "leave warning";
  }
  f.addBeforeUnload(originalGuard);
  let unloading = f.fireUnload();
  assert.equal(unloading.defaultPrevented, true);
  assert.equal(unloading.returnValue, "leave warning");
  await f.tick();
  f.advance(11000);
  await f.tick();
  unloading = f.fireUnload();
  assert.equal(unloading.defaultPrevented, false);
  assert.equal(unloading.returnValue, true);
  assert.equal(nativeCleanup, 2, "site cleanup was called on both unloads");
  f.removeBeforeUnload(originalGuard);
  f.fireUnload();
  assert.equal(nativeCleanup, 2, "wrapped listener can be removed by original listener");

  // Query retry is restricted to the read allowlist and transient failures.
  let failures = 0;
  f = fixture(null, {
    controller: true,
    response: () => {
      if (failures++ < 2) throw new TypeError("network");
      return { status: 200, data: { ok: true } };
    },
  });
  assert.equal((await f.api.readAPI("/api/index/Course/index", { page: 1 })).data.ok, true);
  assert.equal(f.requests.length, 3);
  f = fixture(null, {
    controller: true,
    response: () => {
      throw new TypeError("offline");
    },
  });
  await assert.rejects(f.api.readAPI("/api/index/Course/index", { page: 1 }), /4次/);
  assert.equal(f.requests.length, 4);
  f = fixture(null, { controller: true, response: () => ({ status: -1 }) });
  await assert.rejects(f.api.readAPI("/api/index/Course/index", { page: 1 }), /登录已过期/);
  assert.equal(f.requests.length, 1);
  await assert.rejects(f.api.readAPI("/api/index/Study.Index/confirmPlay", {}), /白名单/);
  assert.equal(f.requests.length, 1);

  f = fixture(null, { noVideo: true });
  await f.tick();
  f.advance(60000);
  await f.tick();
  assert.equal(
    f.sent.some((m) => m.type === "paused"),
    false,
    "slow DOM gets more than 45 seconds",
  );
  f.advance(121000);
  await f.tick();
  assert.equal(
    f.sent.some((m) => m.type === "paused"),
    true,
  );

  let playAttempts = 0;
  f = fixture(null, {
    video: {
      paused: true,
      currentTime: 0,
      async play() {
        playAttempts++;
        if (playAttempts < 2) throw new Error("temporarily interrupted");
        this.paused = false;
      },
    },
  });
  await f.tick();
  assert.equal(playAttempts, 1);
  assert.equal(
    f.sent.some((m) => m.type === "paused"),
    false,
  );
  f.advance(6000);
  await f.tick();
  assert.equal(playAttempts, 2);
  assert.equal(f.video.paused, false);
  f = fixture(null, {
    video: {
      paused: true,
      async play() {
        throw Object.assign(new Error("gesture needed"), { name: "NotAllowedError" });
      },
    },
  });
  await f.tick();
  assert.equal(
    f.sent.some((m) => m.type === "paused"),
    true,
    "browser gesture restrictions do not loop",
  );
  f = fixture(null, { video: { error: { code: 2 } } });
  await f.tick();
  f.advance(61000);
  await f.tick();
  assert.equal(
    f.sent.some((m) => m.type === "paused"),
    false,
  );
  f.video.error = null;
  await f.tick();
  assert.equal(
    f.sent.some((m) => m.type === "paused"),
    false,
    "recovered network error resumes monitoring",
  );
});

await test("direct video-page takeover without task parameters/preview, collapsed menu, automatic normal play, trusted-click playback, direct completion persistence and manual learned action.", async () => {
  let f;

  // A video opened by the user is taken over without scheduler parameters or a preview.
  f = fixture(null, { direct: true, video: { paused: true, currentTime: 0 } });
  assert.ok(f.nodes.has("#playback-toggle"));
  assert.equal(f.nodes.has("#resume"), false);
  assert.equal(f.nodes.has("#plan"), false);
  assert.match(f.ui.innerHTML, /<section[^>]*id="panel"[^>]*hidden/);
  await f.tick();
  assert.equal(f.video.paused, false);
  assert.equal(f.requests.length, 0);
  await f.tick();
  assert.match(f.nodes.get("#state").textContent, /正常播放/);
  f.nodes.get("#playback-toggle").onclick();
  assert.equal(f.video.paused, true);
  f.nodes.get("#playback-toggle").onclick({ isTrusted: true });
  assert.equal(f.video.paused, false, "manual Continue invokes play inside the user gesture");
  f = fixture("您的学习时间已达到要求，获得学分:0.5,是否继续学习?", { direct: true });
  await f.tick();
  f.advance(11000);
  await f.tick();
  assert.equal(f.savedRecords()["7"].kind, "complete");
  assert.equal(f.video.paused, true);
  assert.equal(f.clicks.length, 0, "direct takeover leaves the completed page for the user");
  f = fixture(null, { direct: true });
  await f.tick();
  await f.nodes.get("#worker-learned").onclick();
  assert.equal(f.savedRecords()["7"].kind, "manual");
  assert.equal(f.video.paused, true);
});

await test("iframe monitoring waits for platform completion without controlling the frame or inferring credit from elapsed time.", async () => {
  let f = fixture();

  // iframe mode monitors platform prompts without controlling iframe playback.
  const iframePlayer = {
    paused: true,
    playbackRate: 1,
    readyState: 4,
    getClientRects: () => [{}],
    pause() {
      this.paused = true;
    },
    async play() {
      this.paused = false;
    },
  };
  const monitoredFrame = {
    getClientRects: () => [{}],
    contentDocument: {
      documentElement: {},
      querySelectorAll: (q) => (q === "video" ? [iframePlayer] : []),
    },
  };
  f = fixture(null, { direct: true, noVideo: true, frames: [monitoredFrame] });
  await f.tick();
  f.advance(180001);
  await f.tick();
  assert.equal(iframePlayer.paused, true, "no automatic iframe playback");
  assert.equal(
    f.sent.some((m) => m.type === "paused"),
    false,
    "wait for platform rather than timing out at three minutes",
  );
  assert.match(f.nodes.get("#state").textContent, /正在识别课件类型/);
  f.nodes.get("#playback-toggle").onclick();
  assert.match(f.nodes.get("#state").textContent, /已恢复/);
  f = fixture("您的学习时间已达到要求，获得学分:0.5,是否继续学习?", {
    direct: true,
    noVideo: true,
    frames: [monitoredFrame],
  });
  await f.tick();
  f.advance(11000);
  await f.tick();
  assert.equal(
    f.savedRecords()["7"].kind,
    "complete",
    "direct iframe completion waits for platform dialog",
  );
  f = fixture("您的学习时间已达到要求，获得学分:0.5,是否继续学习?", {
    noVideo: true,
    frames: [monitoredFrame],
  });
  await f.tick();
  f.advance(11000);
  await f.tick();
  assert.deepEqual(f.clicks, ["取消"]);
  assert.equal(f.sent.filter((m) => m.type === "complete").length, 1);
  f = fixture("请输入验证码后继续", { noVideo: true, frames: [monitoredFrame] });
  await f.tick();
  assert.equal(
    f.sent.some((m) => m.type === "paused"),
    true,
  );
  assert.equal(f.clicks.length, 0);
  assert.match(source, /xc-course\.hzrs\.hangzhou\.gov\.cn\/\*/);
});
