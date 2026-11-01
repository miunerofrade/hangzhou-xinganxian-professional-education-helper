import { recordEvent } from "./event-log.js";
import { number, log } from "./utils.js";
import { pauseFromWorker, resumeFromWorker } from "./controller-state.js";

export const isCurrentCourseMessage = (message, state, session) =>
  !!state.current &&
  message?.run === session &&
  message?.job === state.current.job &&
  String(message.id) === state.current.course.id;

export function createControllerMessageHandler({
  state,
  store,
  session,
  annual,
  estimateKey,
  present,
  courseAction,
  recovery,
  channel,
  checkLearningCenter,
  render,
  status,
  markComplete,
  finished,
  stop,
  fail,
  $,
}) {
  return function handleControllerMessage(event) {
    const m = event.data;
    if (m?.type === "estimate-updated" && m.scope === store.scope && m.year === annual.annualYear) {
      try {
        const saved = JSON.parse(localStorage.getItem(estimateKey()) || "null");
        if (saved) void annual.onEstimateUpdated(store.scope, saved).catch(fail);
      } catch {}
      return;
    }
    if (m?.type === "presence" && m.probe === state.probe) present.add(m.job || "manual");
    if (!isCurrentCourseMessage(m, state, session)) return;
    if (m.type === "manual-action" && ["manual", "excluded"].includes(m.action)) {
      courseAction(state.current.course.id, m.action);
      return;
    }
    if (
      m.type === "iframe-skip" &&
      m.inspected === true &&
      !state.current.complete &&
      !state.current.skipped
    ) {
      courseAction(state.current.course.id, "auto-excluded");
      status("自动跳过：iframe 课件，等待课页关闭");
      return;
    }
    if (m.type === "recovery-request" && !state.current.complete && !state.current.skipped) {
      recordEvent("recovery", "播放页请求恢复", String(m.reason || "播放操作停滞").slice(0, 160));
      const receipt = recovery.request(state.current, String(m.reason || "播放操作停滞"));
      channel.postMessage({
        type: "recovery-ack",
        run: session,
        job: state.current.job,
        id: state.current.course.id,
        requestId: m.requestId,
        ...receipt,
      });
      return;
    }
    if (m.type === "verify-completion") {
      if (Date.now() - (state.current.lastVerificationHintAt || 0) >= 30000) {
        state.current.lastVerificationHintAt = Date.now();
        void checkLearningCenter(true);
      }
      return;
    }
    if (m.type === "heartbeat") {
      state.lastHeartbeat = Date.now();
      state.missingSince = 0;
    }
    if (m.type === "paused" && !state.current.complete && !state.current.skipped) {
      const manual = m.manual === true || ["已手动暂停", "主面板已暂停"].includes(m.reason);
      pauseFromWorker(state, manual);
      render();
      recordEvent(
        "state",
        manual ? "手动暂停学习" : "播放操作暂停",
        state.manualPaused
          ? "保留手动暂停，不继续监控或切课"
          : "继续核对学习中心与已学列表；平台确认完成后关闭当前课页",
      );
      status(
        state.manualPaused
          ? `播放页已暂停：${m.reason}`
          : `播放操作已暂停：${m.reason}；主面板继续核对完成状态`,
      );
    }
    if (m.type === "resumed" && state.paused && (state.heartbeatPaused || m.manual === true)) {
      resumeFromWorker(state);
      render();
      status("播放页已恢复，继续核对学习中心");
    }
    if (
      m.type === "complete-notice" &&
      m.notice === "course-hours-met" &&
      !state.current.skipped &&
      !state.current.complete
    ) {
      markComplete(state.current, "平台明确提示课程学时已达标");
      void annual.refreshLearnedInBackground();
      return;
    }
    if (m.type === "complete" && !state.current.skipped && !finished.has(state.current.course.id)) {
      const credits = number(m.credits);
      if (!(credits > 0)) {
        stop("平台完成提示中没有有效学分");
        return;
      }
      markComplete(state.current);
      status("平台提示完成，后台查询已学列表");
      void annual.refreshLearnedInBackground().catch((error) => {
        log("后台查询已学列表失败", error.message);
        $("#learned-summary").textContent = "已学列表查询失败，请手动重试";
      });
    }
  };
}
