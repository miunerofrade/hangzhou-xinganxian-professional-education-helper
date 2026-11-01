import { visible, text, round } from "./utils.js";
import { collectDialogs } from "./dialogs.js";
import { classify } from "./planner.js";
export function createPlayerMedia({
  panel,
  lifecycle,
  state,
  playbackDiagnostic,
  diagnostics,
  config,
}) {
  const { $ } = panel;
  const mutedByHelper = new WeakMap();
  function applyMute() {
    if (!state.video) return;
    if ($("#mute-video").checked) {
      if (!mutedByHelper.has(state.video)) mutedByHelper.set(state.video, state.video.muted);
      state.video.muted = true;
    } else if (mutedByHelper.has(state.video)) {
      state.video.muted = mutedByHelper.get(state.video);
      mutedByHelper.delete(state.video);
    }
  }
  function findPlayer() {
    const videos = [...document.querySelectorAll(".video_wrap video")].filter(visible);
    const frames = [...document.querySelectorAll("#app iframe")].filter(visible);
    return { videos, frames: frames.length, frameNodes: frames };
  }
  diagnostics.playbackSnapshot = () => {
    const dialogs = collectDialogs();
    return {
      courseId: String(config.course.id),
      courseName: String(config.course.name || ""),
      visibility: document.visibilityState,
      focused: document.hasFocus?.() ?? null,
      dialogCount: dialogs.count,
      dialogKinds: dialogs.boxes.map(
        (box) => classify(text(box.querySelector(".el-message-box__message"))).type,
      ),
      helperEnabled: state.enabled,
      completed: state.completed,
      unexpectedPauseRetries: state.unexpectedPauseRetries,
      playAttempts: state.playAttempts,
      player: state.video
        ? {
            paused: state.video.paused,
            ended: state.video.ended,
            currentTime: Number.isFinite(state.video.currentTime)
              ? round(state.video.currentTime)
              : null,
            duration: Number.isFinite(state.video.duration) ? round(state.video.duration) : null,
            readyState: state.video.readyState,
            networkState: state.video.networkState ?? null,
            playbackRate: state.video.playbackRate,
            muted: state.video.muted,
            errorCode: state.video.error?.code ?? null,
          }
        : null,
    };
  };
  const observedPlayers = new WeakSet();
  function observePlayer(player) {
    if (!player || observedPlayers.has(player)) return;
    observedPlayers.add(player);
    lifecycle.on(player, "playing", state.updatePlaybackControl);
    lifecycle.on(player, "ended", state.updatePlaybackControl);
    lifecycle.on(player, "pause", () => {
      state.updatePlaybackControl();
      if (state.enabled && player === state.video && !state.completed)
        playbackDiagnostic("播放器触发暂停事件", "播放器报告已暂停，暂停来源未知");
    });
  }
  panel.onMuteChanged = applyMute;
  return { findPlayer, applyMute, observePlayer };
}
