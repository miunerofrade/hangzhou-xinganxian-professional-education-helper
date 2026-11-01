import { validRefreshMinutes } from "./settings-schema.js";
import { number, log } from "./utils.js";
import { recordEvent } from "./event-log.js";
export function createAutoRefresh({ state, panel, annual, centerMonitor }) {
  const { $, ui } = panel;
  const refreshTimeKey = "hz-helper-auto-refresh-last-v1";
  let lastAutoRefresh = number(sessionStorage.getItem(refreshTimeKey));
  if (!Number.isFinite(lastAutoRefresh) || lastAutoRefresh <= 0) lastAutoRefresh = Date.now();
  function checkAutoRefresh() {
    const minutes = number($("#refresh-minutes").value);
    const timer = $("#refresh-countdown");
    timer.hidden = false;
    const valid = validRefreshMinutes(minutes);
    const remaining = valid
      ? Math.max(0, Math.ceil((lastAutoRefresh + minutes * 60000 - Date.now()) / 1000))
      : 0;
    if (!$("#auto-refresh").checked) timer.textContent = "刷新已关闭";
    else if (!valid) timer.textContent = "刷新间隔无效";
    else if (!state.active || !state.planSettings) timer.textContent = "刷新待学习";
    else if (state.paused && !state.heartbeatPaused) timer.textContent = "刷新已暂停";
    else
      timer.textContent =
        remaining > 0
          ? `刷新 ${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`
          : "等待刷新";
    if (
      !$("#auto-refresh").checked ||
      !valid ||
      !state.active ||
      (state.paused && !state.heartbeatPaused) ||
      !state.planSettings ||
      state.busy ||
      state.completing ||
      centerMonitor.busy ||
      state.historyBusy ||
      state.catalogBusy ||
      annual.learnedBusy ||
      annual.annualBusy ||
      annual.refreshTask ||
      state.current?.complete ||
      state.current?.skipped ||
      state.child?.closed
    )
      return;
    const focused = ui.activeElement;
    if (focused && ["INPUT", "TEXTAREA", "SELECT"].includes(focused.tagName)) return;
    if (Date.now() - lastAutoRefresh < minutes * 60000) return;
    lastAutoRefresh = Date.now();
    sessionStorage.setItem(refreshTimeKey, String(lastAutoRefresh));
    timer.textContent = "正在刷新";
    recordEvent("page", "定时刷新主页面", `设置间隔 ${minutes} 分钟；已保存计划，刷新后尝试恢复`);
    log("按设置刷新主页面");
    location.reload();
  }
  return checkAutoRefresh;
}
