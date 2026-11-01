import { createRecoveryClient } from "./recovery-client.js";
import { createPlayerMedia } from "./player-media.js";
import { createPlayerDialogs } from "./player-dialogs.js";
import { readMediaFailure } from "./media-errors.js";
import { createFrameBridge } from "./frames/bridge.js";
import { collectDialogs } from "./dialogs.js";
import { mountPlayerControls } from "./ui/controls.js";
import { requestPlayback, playbackBlocked } from "./playback.js";
import { configKey, route, courseId, ACTION_DELAY_MS } from "./constants.js";
import { log } from "./utils.js";
export function startPlayer(env) {
  const { panel, runtime, annual, diagnostics, channel, accountScope, lifecycle } = env;
  const { $, status } = panel;
  const { run, job, direct, directConfig, exitBridge } = runtime;
  const { playbackDiagnostic } = diagnostics;
  $("#preview").replaceChildren();
  let config;
  try {
    config = directConfig || JSON.parse(localStorage.getItem(configKey(run)) || "null");
  } catch {
    /* fail closed */
  }
  if (!config || config.job !== job || String(config.course.id) !== courseId()) {
    status("任务信息不匹配，未启动自动操作");
    return;
  }
  $("#panel").classList.toggle("player-panel", true);
  $("#progress").textContent = `当前课程：${config.course.name || config.course.id}`;
  const doneKey = `hz-helper-worker-done:${run}:${job}`;
  if (sessionStorage.getItem(doneKey)) {
    status("此任务已报告完成，不会重复计入或重新播放，请关闭此页");
    return;
  }
  let enabled = true,
    completed = false,
    lastBeat = 0,
    since = Date.now();
  let video = null,
    playbackAttempted = false,
    release = null,
    locked = false;
  let playAttempts = 0,
    nextPlayAt = 0,
    networkErrorSince = 0,
    ticking = false;
  let unexpectedPauseRetries = 0,
    playbackStableSince = 0;
  let lastPosition = NaN,
    lastAdvance = Date.now(),
    frameSince = 0,
    frameSignature = "",
    lastFrameSkip = 0;
  let waitingForDialogClose = false;
  const frameBridge = createFrameBridge({ lifecycle });
  let frameReport = null,
    frameBlockedAt = 0,
    automaticPauseAt = 0,
    recoveryRequested = false,
    pauseReason = "",
    lastFrameDiagnostic = "",
    lastFrameVerifyAt = 0;
  function requestRecovery(reason, level = "warning") {
    if (recoveryRequested) return;
    recoveryRequested = true;
    if (direct) {
      video?.pause();
      frameBridge.command(false);
      exitBridge.arm();
      playbackDiagnostic("手动课页恢复", `${reason}；2秒后重新载入同一课程，不计入完成`, level);
      status("正在恢复当前课件，2秒后重新载入同一课程");
      lifecycle.timeout(() => location.reload(), ACTION_DELAY_MS);
      return;
    }
    recoveryClient.request(reason);
    playbackDiagnostic("请求重新打开当前课程", reason, level);
  }
  const mediaState = {
    get video() {
      return video;
    },
    get enabled() {
      return enabled;
    },
    get completed() {
      return completed;
    },
    get unexpectedPauseRetries() {
      return unexpectedPauseRetries;
    },
    get playAttempts() {
      return playAttempts;
    },
    updatePlaybackControl,
  };
  const { findPlayer, applyMute, observePlayer } = createPlayerMedia({
    panel,
    lifecycle,
    state: mediaState,
    playbackDiagnostic,
    diagnostics,
    config,
  });
  runtime.onStudyObservation = (http, platform, finish) => {
    playbackDiagnostic(
      "平台进度上报",
      `HTTP ${Number(http) || 0}；平台状态 ${Number.isFinite(Number(platform)) ? Number(platform) : "未知"}；完成标记 ${[0, 1, "0", "1"].includes(finish) ? finish : "未知"}`,
    );
  };
  function resume(event) {
    $("#panel").classList.toggle("is-paused", false);
    enabled = true;
    updatePlaybackControl();
    automaticPauseAt = 0;
    recoveryRequested = false;
    recoveryClient.clear();
    frameBridge.command(true, event?.isTrusted === true);
    waitingForDialogClose = false;
    playbackAttempted = false;
    playAttempts = 0;
    unexpectedPauseRetries = 0;
    playbackStableSince = 0;
    nextPlayAt = 0;
    networkErrorSince = 0;
    since = Date.now();
    lastAdvance = Date.now();
    status("已恢复，等待页面加载");
    send("resumed", { manual: event?.isTrusted === true });
    // 实际点击时在用户手势内发起播放，便于浏览器授予自动播放权限。
    if (event?.isTrusted) {
      const found = findPlayer();
      const candidate = video || (found.videos.length === 1 ? found.videos[0] : null);
      if (candidate && candidate.readyState >= 2 && candidate.playbackRate === 1 && !completed) {
        video = candidate;
        applyMute();
        playbackAttempted = true;
        playAttempts = 1;
        requestPlayback(video)
          .then(() => {
            updatePlaybackControl();
            lastAdvance = Date.now();
          })
          .catch((error) => {
            if (playbackBlocked(error)) pause("浏览器仍拒绝播放，请点击视频中央播放键");
            else {
              playbackAttempted = false;
              nextPlayAt = Date.now() + 5000;
              status("启动较慢，5秒后自动重试");
            }
          });
      }
    }
  }
  mountPlayerControls(panel);
  function playing() {
    return (
      enabled &&
      !completed &&
      (video ? !video.paused && !video.ended : frameReport?.state === "playing")
    );
  }
  function updatePlaybackControl() {
    const active = playing();
    const label = active ? "暂停" : "继续播放";
    const button = $("#playback-toggle");
    if (button.getAttribute("aria-label") === label) return;
    button.innerHTML = `${panel.icon(active ? "pause" : "play", 20)}<span>${label}</span>`;
    button.setAttribute("aria-label", label);
  }
  const send = (type, extra = {}) =>
    channel.postMessage({ type, run, job, id: config.course.id, ...extra });
  const recoveryClient = createRecoveryClient({
    send,
    onReceipt: (receipt) => {
      playbackDiagnostic(
        receipt.status === "blocked" ? "自动恢复未执行" : "主面板已确认恢复请求",
        receipt.detail,
        receipt.status === "blocked" ? "warning" : "info",
      );
    },
  });
  function pause(reason, recoverOnDialogClose = false) {
    $("#panel").classList.toggle("is-paused", true);
    enabled = false;
    updatePlaybackControl();
    video?.pause();
    frameBridge.command(false);
    pauseReason = reason;
    automaticPauseAt =
      ["已手动暂停", "主面板已暂停"].includes(reason) || reason.includes("自动继续未勾选")
        ? 0
        : Date.now();
    waitingForDialogClose = recoverOnDialogClose;
    const manual = ["已手动暂停", "主面板已暂停"].includes(reason);
    if (manual) recoveryClient.clear();
    if (
      !video &&
      !frameReport?.supported &&
      findPlayer().frames &&
      ["已手动暂停", "主面板已暂停"].includes(reason)
    )
      reason += "；课件及平台计时不受此按钮控制";
    playbackDiagnostic(
      "助手暂停",
      `${reason}；${document.visibilityState === "hidden" ? "后台" : "可见"}；${document.hasFocus?.() ? "有焦点" : "无焦点"}`,
    );
    status(reason, { logged: true });
    send("paused", { reason, recoverOnDialogClose, manual });
  }
  async function rememberDirect(kind) {
    const scope = await accountScope(),
      key = `hz-helper-records-v1:${scope}`;
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(key) || "{}");
    } catch {
      saved = {};
    }
    const records = Object.assign(
      Object.create(null),
      saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {},
    );
    records[config.course.id] = {
      id: config.course.id,
      name: config.course.name,
      kind,
      at: Date.now(),
    };
    localStorage.setItem(key, JSON.stringify(records));
  }
  async function markDirect(kind) {
    try {
      await rememberDirect(kind);
      pause(kind === "manual" ? "已记录为已学，可返回课程列表" : "已移除此课，可返回课程列表");
    } catch (error) {
      pause(error.message);
    }
  }
  $("#worker-learned").onclick = () =>
    direct ? markDirect("manual") : send("manual-action", { action: "manual" });
  $("#worker-remove").onclick = () =>
    direct ? markDirect("excluded") : send("manual-action", { action: "excluded" });
  $("#playback-toggle").onclick = (event) => {
    if (playing()) pause("已手动暂停");
    else resume(event);
    updatePlaybackControl();
  };
  lifecycle.on(channel, "message", (event) => {
    const m = event.data;
    if (m?.run !== run || m?.job !== job) return;
    if (m.type === "recovery-ack") {
      recoveryClient.acknowledge(m);
      return;
    }
    if (m.type === "skip") {
      enabled = false;
      video?.pause();
      exitBridge.arm();
      status("已移出计划，关闭此课页");
      window.close();
      return;
    }
    if (m.type === "list-complete") {
      enabled = false;
      video?.pause();
      exitBridge.arm();
      status("学习中心已确认完成，关闭此课页");
      window.close();
      return;
    }
    if (m.type === "pause") pause("主面板已暂停");
    if (m.type === "resume") resume();
  });
  if (!navigator.locks) {
    pause("浏览器不支持 Web Locks，无法保证脚本单播放实例");
    return;
  }
  navigator.locks
    .request("hz-helper-player-v1", { ifAvailable: true }, async (lock) => {
      if (!lock) {
        pause("另一助手播放页占用锁，请关闭多余课页");
        return;
      }
      locked = true;
      await new Promise((resolve) => {
        release = resolve;
      });
    })
    .catch((error) => pause(error.message));
  lifecycle.on(window, "pagehide", () => {
    release?.();
    send("leaving");
  });

  const dialogs = createPlayerDialogs({
    state: {
      get completed() {
        return completed;
      },
      set completed(value) {
        completed = value;
      },
      get video() {
        return video;
      },
      set lastAdvance(value) {
        lastAdvance = value;
      },
    },
    config,
    run,
    job,
    direct,
    doneKey,
    exitBridge,
    annual,
    pause,
    status,
    requestRecovery,
    send,
    rememberDirect,
    lifecycle,
  });
  async function tick(dialogBudget = 8) {
    if (route() !== "#/class" || courseId() !== String(config.course.id)) {
      pause("页面已离开当前课程，停止跟随操作");
      return;
    }
    recoveryClient.tick();
    if (Date.now() - lastBeat > 2000) {
      send("heartbeat", { completed });
      lastBeat = Date.now();
    }
    if (!enabled && waitingForDialogClose && !collectDialogs().count) {
      log("弹窗等待诊断", {
        event: "弹窗已消失，恢复当前课程",
        visibility: document.visibilityState,
        focused: document.hasFocus?.(),
      });
      resume();
    }
    if (!enabled && automaticPauseAt && Date.now() - automaticPauseAt >= 90000)
      requestRecovery(`播放自动暂停超过90秒：${pauseReason}`);
    if (!enabled || !locked) return;
    // 初始渲染可能暂时显示 iframe；它不能单独证明这是外部课件。
    // 每秒重新识别，优先使用可见的主播放器，不刷新或另开课程。
    const found = findPlayer(),
      videos = found.videos;
    const nextVideo = videos.length === 1 ? videos[0] : null;
    if (nextVideo !== video) {
      video = nextVideo;
      observePlayer(video);
      playbackAttempted = false;
      playAttempts = 0;
      nextPlayAt = 0;
      networkErrorSince = 0;
      unexpectedPauseRetries = 0;
      playbackStableSince = 0;
      lastPosition = NaN;
      lastAdvance = Date.now();
    }
    const frames = found.frames;
    applyMute();
    const iframeMode = !video && frames > 0;
    if (direct && completed) {
      video?.pause();
      status("当前课程已完成，可返回课程列表");
      return;
    }
    if (completed) {
      status("已获平台完成提示，等待课页关闭");
      return;
    }
    if (await dialogs.handle({ dialogBudget, tick })) return;
    if (completed) {
      status("已获平台完成提示，等待播放页关闭");
      return;
    }
    const mediaFailure = readMediaFailure(video);
    if (mediaFailure && [3, 4].includes(mediaFailure.code)) {
      requestRecovery(
        `媒体播放错误 code=${mediaFailure.code}（${mediaFailure.code === 3 ? "解码失败或媒体损坏" : "媒体源或格式不受支持"}）；来源 ${mediaFailure.source}；关闭后重开同一课程`,
        "error",
      );
      return;
    }
    if (videos.length > 1) {
      pause("检测到多个可见主视频，无法确认当前播放器");
      return;
    }
    if (!video && !iframeMode) {
      const elapsed = Date.now() - since;
      if (elapsed >= 180000) pause("已自动重试识别3分钟，主播放器仍未出现；请检查后继续");
      else
        status(
          `主播放器尚未出现，自动重试识别（${Math.min(3, Math.floor(elapsed / 60000) + 1)}/3轮，最多3分钟）`,
        );
      return;
    }
    if (video && video.playbackRate !== 1) {
      pause("检测到非 1 倍速，请手动恢复正常速度后继续");
      return;
    }
    if (video?.error) {
      if (video.error.code !== 2) {
        pause(`视频播放错误 code=${video.error.code}，不是可恢复网络错误`);
        return;
      }
      if (!networkErrorSince) networkErrorSince = Date.now();
      if (Date.now() - networkErrorSince >= 180000)
        requestRecovery("播放器网络错误 code=2 持续3分钟，关闭后重开当前课程");
      else
        status(
          `视频网络异常，等待原播放器恢复（${Math.min(3, Math.floor((Date.now() - networkErrorSince) / 60000) + 1)}/3轮）；持续3分钟后重开当前课程`,
        );
      return;
    }
    networkErrorSince = 0;
    if (iframeMode) {
      const src =
        found.frameNodes.length === 1 ? found.frameNodes[0].getAttribute?.("src")?.trim() : "";
      if (!src || src === "about:blank") {
        frameSince = 0;
        frameSignature = "";
        status("正在识别课件类型…");
        return;
      }
      if (src !== frameSignature) {
        frameSignature = src;
        frameSince = Date.now();
        frameBlockedAt = 0;
      }
      frameReport = frameBridge.inspect(found.frameNodes, {
        enabled,
        muted: $("#mute-video").checked,
      });
      if (frameReport.supported) {
        const diagnostic = `${frameReport.state}:${frameReport.error || ""}`;
        if (diagnostic !== lastFrameDiagnostic) {
          lastFrameDiagnostic = diagnostic;
          playbackDiagnostic(
            "课件播放状态",
            `${frameReport.selector || "原生控件"}；状态 ${frameReport.state}；${frameReport.error || "未报告播放错误"}`,
          );
        }
        if (["blocked", "error", "unsupported"].includes(frameReport.state)) {
          frameBlockedAt ||= Date.now();
          status(`课件播放未恢复：${frameReport.error || frameReport.state}；正在重试原生播放按钮`);
          if (Date.now() - frameBlockedAt >= 90000)
            requestRecovery("已识别课件播放90秒仍失败，关闭后重开当前课程");
        } else {
          frameBlockedAt = 0;
          status(
            frameReport.ended
              ? "课件播放结束，正在核对平台完成状态"
              : frameReport.state === "playing"
                ? "课件正常播放中，主面板核对平台进度"
                : "已点击课件播放按钮，等待播放器启动；主面板持续核对进度",
          );
          if (frameReport.ended && !direct && Date.now() - lastFrameVerifyAt >= 60000) {
            lastFrameVerifyAt = Date.now();
            send("verify-completion");
          }
        }
        return;
      }
      const unreadable = frameReport.state !== "unknown";
      const diagnostic = `${frameReport.state}:${src.split(/[?#]/)[0]}`;
      if (diagnostic !== lastFrameDiagnostic) {
        lastFrameDiagnostic = diagnostic;
        let address = "地址不可用";
        try {
          const url = new URL(src, location.href);
          address = `${url.origin}${url.pathname}`;
        } catch {}
        playbackDiagnostic(
          unreadable ? "课件内容未读到" : "课件控件未匹配",
          `${address}；${unreadable ? "子页未响应、尚未加载或内层框架不可访问；不会自动排除" : "已读取课件文档，未找到支持的原生控件"}`,
        );
      }
      if (unreadable) {
        status("尚未读到课件内容，正在重试；不会按未知样式跳过");
        if (Date.now() - frameSince >= 90000)
          requestRecovery("课件内容90秒未能读取，关闭后重开当前课程；不自动排除");
        return;
      }
      const grace = 10000;
      if (Date.now() - frameSince < grace) {
        status("正在识别 iframe 原生播放控件…");
        return;
      }
      if (direct) {
        pause("未识别此 iframe 课件，可返回课程列表选择其他课程");
        return;
      }
      if (!lastFrameSkip || Date.now() - lastFrameSkip >= 5000) {
        lastFrameSkip = Date.now();
        send("iframe-skip", { reason: "未识别原生播放控件", inspected: true });
      }
      status("课件样式未识别，等待主面板跳过；不计入完成");
      return;
    }
    frameSince = 0;
    frameSignature = "";
    if (video.ended) {
      pause("视频已结束但未收到明确完成学分提示，不能自动认定完成");
      return;
    }
    if (document.visibilityState === "hidden" && video.paused) {
      playbackStableSince = 0;
      playbackAttempted = false;
      playAttempts = 0;
      unexpectedPauseRetries = 0;
      nextPlayAt = 0;
      lastAdvance = Date.now();
      status("视频在后台暂停，继续核对平台学习进度");
      return;
    }
    if (document.visibilityState === "hidden" && !video.paused) lastAdvance = Date.now();
    if (video.paused) {
      playbackStableSince = 0;
      if (playbackAttempted && video.readyState >= 2 && Date.now() >= nextPlayAt) {
        if (unexpectedPauseRetries >= 4) {
          unexpectedPauseRetries = 0;
          nextPlayAt = Date.now() + 60000;
          playbackDiagnostic("播放重试冷却", "视频反复暂停，等待 60 秒后再次检查");
          status("视频反复暂停，等待60秒后继续重试；学习中心仍在核对");
          return;
        }
        unexpectedPauseRetries++;
        playbackAttempted = false;
        playAttempts = 0;
        log("播放暂停诊断", {
          event: "无可见弹窗，尝试恢复播放",
          attempt: unexpectedPauseRetries,
          visibility: document.visibilityState,
          focused: document.hasFocus?.(),
          currentTime: video.currentTime,
        });
        playbackDiagnostic(
          "检测到视频暂停",
          `无可见弹窗；${document.visibilityState === "hidden" ? "后台" : "可见"}；${document.hasFocus?.() ? "有焦点" : "无焦点"}；第 ${unexpectedPauseRetries}/4 次重试；播放位置 ${Number.isFinite(video.currentTime) ? Math.floor(video.currentTime) + " 秒" : "未知"}`,
        );
        status(`视频意外暂停，正在尝试恢复（${unexpectedPauseRetries}/4）`);
      }
    }
    if (video.paused && !playbackAttempted && video.readyState >= 2 && Date.now() >= nextPlayAt) {
      playbackAttempted = true;
      playAttempts++;
      try {
        await requestPlayback(video, 15000);
        lastAdvance = Date.now();
        nextPlayAt = Date.now() + 10000;
        log("调用正常播放");
        if (unexpectedPauseRetries)
          playbackDiagnostic(
            "播放重试已发出",
            video.paused ? "播放器仍处于暂停状态，稍后继续检查" : "播放器已开始播放，继续观察",
          );
      } catch (error) {
        if (!enabled) return;
        playbackDiagnostic(
          "播放重试失败",
          `浏览器返回 ${String(error.name || "Error").slice(0, 80)}；${document.visibilityState === "hidden" ? "后台" : "可见"}`,
        );
        if (playbackBlocked(error)) {
          pause("浏览器拒绝自动播放或不支持此视频，请手动点播放再点继续");
          return;
        }
        if (playAttempts >= 4) {
          pause("正常播放已尝试4次仍未启动，请检查后点击继续");
          return;
        }
        const delay = [5000, 10000, 20000][playAttempts - 1];
        nextPlayAt = Date.now() + delay;
        playbackAttempted = false;
        status(`播放启动较慢，${delay / 1000}秒后重试（${playAttempts}/3）`);
      }
    } else if (!video.paused) {
      const position = Number(video.currentTime);
      if (
        !Number.isFinite(lastPosition) ||
        (Number.isFinite(position) && position > lastPosition + 0.05)
      ) {
        lastPosition = position;
        lastAdvance = Date.now();
        if (!playbackStableSince) playbackStableSince = Date.now();
        if (Date.now() - playbackStableSince >= 30000) unexpectedPauseRetries = 0;
      }
      if (Date.now() - lastAdvance >= 180000) {
        pause("视频3分钟没有前进，请检查网络后继续；未重开课程或跳转进度");
        return;
      }
      status(
        video.readyState < 3 || Date.now() - lastAdvance > 15000
          ? "视频正在缓冲，继续等待网络恢复（最多3分钟）"
          : "正常播放中（1倍速），等待平台完成提示",
      );
    } else if (video.readyState < 2) {
      if (Date.now() - lastAdvance >= 180000) pause("视频数据3分钟内仍未就绪，请检查后继续");
      else status("视频数据加载中，最多等待3分钟，不重新打开课程");
    }
  }
  lifecycle.interval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      await tick();
    } catch (error) {
      pause(error.message);
    } finally {
      ticking = false;
      updatePlaybackControl();
    }
  }, 1000);
  status(direct ? "已接管当前课程，自动识别并尝试播放" : "正在识别主播放器…");
  send("heartbeat", { completed: false });
}
