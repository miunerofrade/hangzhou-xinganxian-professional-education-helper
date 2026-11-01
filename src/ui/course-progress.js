import { renderProgressBar } from "./progress-bar.js";
export function renderCourseProgress($, snapshot) {
  const percent = snapshot?.percent;
  const valid = Number.isFinite(percent) && Number.isFinite(snapshot?.checkedAt);
  $("#center-progress").hidden = false;
  const value = renderProgressBar(
    $("#center-progress-bar"),
    $("#center-progress-fill"),
    valid ? percent : null,
    "尚未取得平台进度",
  );
  if (value === null) {
    $("#center-progress-label").textContent = "课程进度";
    $("#center-check-time").textContent = "—";
    $("#center-check-time").removeAttribute("datetime");
    return;
  }
  $("#center-progress-label").textContent = `课程进度 ${value}%`;
  const time = new Date(snapshot.checkedAt);
  $("#center-check-time").textContent =
    `核对 ${time.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}`;
  $("#center-check-time").setAttribute("datetime", time.toISOString());
}
