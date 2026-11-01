import { createKeyedList } from "./keyed-list.js";
import { logSummary } from "./log-summary.js";
import { readLog, writeJSON } from "../storage.js";
export function formatLogTime(value, full = false) {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "时间未知";
  return at.toLocaleString(
    "zh-CN",
    full
      ? { hour12: false }
      : {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        },
  );
}
export function createLogView({
  $,
  lifecycle,
  key,
  selector,
  empty,
  describe,
  trimStored = false,
  limit = 30,
}) {
  const box = $(selector);
  const list = createKeyedList({
    container: box,
    key: (item) => item.key,
    create: ({ row }) => {
      const entry = describe(row);
      const item = document.createElement("details");
      item.className = "auth-entry";
      item.name = "hz-helper-log-accordion";
      const head = document.createElement("summary");
      head.className = "auth-entry-head";
      const label = document.createElement("span");
      label.className = "auth-entry-label";
      label.textContent = logSummary(entry.label, entry.detail);
      const time = document.createElement("time");
      time.className = "auth-entry-time";
      time.textContent = formatLogTime(row.time);
      const stamp = document.createElement("div");
      stamp.className = "auth-entry-stamp";
      const level = document.createElement("span");
      level.className = "auth-entry-level";
      level.textContent = String(entry.level || "info").toUpperCase();
      stamp.append(time, level);
      head.append(label, stamp);
      const body = document.createElement("div");
      body.className = "auth-entry-body";
      const meta = document.createElement("p");
      meta.className = "auth-entry-meta";
      meta.textContent = entry.detail;
      body.append(meta);
      if (row.debug) {
        const debug = document.createElement("pre");
        debug.className = "auth-entry-debug";
        debug.textContent = JSON.stringify(row.debug, null, 2);
        body.append(debug);
      }
      item.append(head, body);
      return { element: item };
    },
    update: () => {},
  });
  lifecycle.on(
    box,
    "toggle",
    (event) => {
      if (!event.target.open) return;
      for (const item of box.children) if (item !== event.target) item.open = false;
    },
    true,
  );
  function render() {
    let rows = readLog(key);
    if (trimStored && rows.length > limit) {
      rows = rows.slice(-limit);
      try {
        writeJSON(key, rows);
      } catch {
        /* Rendering still works if storage is unavailable. */
      }
    }
    if (!rows.length) {
      list.render([]);
      box.textContent = empty;
      return;
    }
    if (!box.children.length) box.textContent = "";
    const occurrences = new Map();
    list.render(
      rows
        .slice(-limit)
        .reverse()
        .map((row) => {
          const signature = JSON.stringify(row);
          const occurrence = occurrences.get(signature) || 0;
          occurrences.set(signature, occurrence + 1);
          return { row, key: `${signature}:${occurrence}` };
        }),
    );
  }

  function clear() {
    localStorage.removeItem(key);
    render();
  }
  lifecycle.on(window, "storage", (event) => {
    if (event.key === key) render();
  });
  render();
  return { render, clear };
}
