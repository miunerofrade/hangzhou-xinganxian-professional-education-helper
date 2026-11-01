import { createLogView, formatLogTime } from "./ui/log.js";
import { readLog } from "./storage.js";
import { LOG_KEY, LOG_LIMIT, onLogChange, recordEvent, eventLevel } from "./event-log.js";
export function createDiagnostics({ $, lifecycle }) {
  const view = createLogView({
    $,
    lifecycle,
    key: LOG_KEY,
    selector: "#event-log",
    empty: "暂无日志",
    trimStored: true,
    limit: LOG_LIMIT,
    describe: (row) => ({
      label: String(row.event || "运行状态"),
      level: eventLevel(row),
      detail: String(row.detail || ""),
      tone: eventLevel(row),
      kind: row.kind,
    }),
  });
  const unsubscribe = onLogChange(view.render);
  lifecycle.defer(unsubscribe);
  let playbackSnapshot = () => null;
  function playbackDiagnostic(event, detail, level) {
    recordEvent("playback", event, detail, {
      debug: playbackSnapshot(),
      ...(level ? { level } : {}),
    });
  }
  $("#copy-log").onclick = async () => {
    const rows = readLog(LOG_KEY).slice(-LOG_LIMIT);
    if (!rows.length) {
      $("#log-result").textContent = "暂无日志";
      return;
    }
    const output = [
      "学习助手日志",
      ...rows
        .reverse()
        .map(
          (row) =>
            `${formatLogTime(row.time, true)}；[${eventLevel(row).toUpperCase()}] ${row.event}\n${row.detail}${row.debug ? `\n详细状态：${JSON.stringify(row.debug)}` : ""}`,
        ),
    ].join("\n\n");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("剪贴板不可用");
      await navigator.clipboard.writeText(output);
      $("#log-result").textContent = "日志已复制";
    } catch {
      $("#log-result").textContent = "复制失败，请检查浏览器剪贴板权限";
    }
  };
  $("#clear-log").onclick = () => {
    view.clear();
    $("#log-result").textContent = "";
  };
  return {
    playbackDiagnostic,
    set playbackSnapshot(fn) {
      playbackSnapshot = fn;
    },
  };
}
