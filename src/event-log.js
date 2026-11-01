import { appendLog, readLog, writeJSON } from "./storage.js";
export const LOG_KEY = "hz-helper-events-v1";
export const LOG_LIMIT = 30;
const listeners = new Set();
export function onLogChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function eventLevel(row) {
  if (["debug", "info", "warning", "error"].includes(row.level)) return row.level;
  if (row.kind === "error" || Number(row.http) >= 400 || row.platform === -1) return "error";
  if (row.kind === "warning" || /重试|暂停|未响应|未识别|未读到|未完成|异常/.test(row.event || ""))
    return "warning";
  return "info";
}
export function recordEvent(kind, event, detail = "", extra = {}) {
  try {
    appendLog(
      LOG_KEY,
      {
        time: Date.now(),
        kind,
        event,
        detail,
        ...extra,
        level: eventLevel({ kind, event, ...extra }),
      },
      LOG_LIMIT,
    );
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* A closed view cannot affect platform requests. */
      }
    }
  } catch {
    /* Diagnostics must never affect playback or a platform request. */
  }
}
export function migrateLogs() {
  const oldKeys = ["hz-helper-auth-observations-v1", "hz-helper-playback-diagnostics-v1"];
  try {
    const rows = readLog(LOG_KEY);
    for (const key of oldKeys)
      for (const row of readLog(key)) {
        const auth = key.includes("auth");
        rows.push({
          time: row.time,
          kind: auth ? "auth" : "playback",
          event: auth ? "登录观察" : String(row.event || "播放状态"),
          detail: auth
            ? `${row.transport}；HTTP ${row.http}；平台状态 ${row.platform}；${row.path}`
            : String(row.detail || ""),
          ...(auth
            ? {
                path: row.path,
                http: row.http,
                platform: row.platform,
                transport: row.transport,
              }
            : { debug: row.debug }),
        });
      }
    rows.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
    if (rows.length) writeJSON(LOG_KEY, rows.slice(-LOG_LIMIT));
    for (const key of oldKeys) localStorage.removeItem(key);
  } catch {
    /* Keep legacy records when migration cannot be persisted. */
  }
}
