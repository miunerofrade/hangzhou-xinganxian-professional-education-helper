import { createLifecycle } from "../lifecycle.js";
import { ORIGIN, FRAME_ORIGINS } from "../constants.js";
import { createSkinAdapter } from "./adapter.js";
export const FRAME_CHANNEL = "hz-helper-course-frame-v1";
const allowed = new Set(FRAME_ORIGINS);
export function startFrameWorker() {
  const adapter = createSkinAdapter(document);
  let initializationError = "";
  window.addEventListener("unhandledrejection", (event) => {
    if (event.reason?.name === "NotAllowedError") initializationError = "NotAllowedError";
  });
  window.addEventListener("error", (event) => {
    let filename = "";
    try {
      filename = new URL(event.filename, location.href).pathname.split("/").at(-1);
    } catch {}
    if (/^(?:apiwrapper|scofunctions|common(?:_single)?|pck_player)\.js$/i.test(filename))
      initializationError = `${filename}: ${event.error?.name || "Error"}`;
  });
  window.addEventListener("message", (event) => {
    const m = event.data;
    if (
      event.origin !== ORIGIN ||
      event.source !== window.top ||
      m?.channel !== FRAME_CHANNEL ||
      m.type !== "inspect" ||
      typeof m.nonce !== "string"
    )
      return;
    const result = adapter.inspect({
      enabled: m.enabled === true,
      muted: m.muted === true,
    });
    if (!result.supported && document.readyState && document.readyState !== "complete")
      result.state = "waiting";
    if (initializationError && result.supported && result.state !== "playing") {
      result.state = initializationError === "NotAllowedError" ? "blocked" : "error";
      result.error = initializationError;
    }
    event.source.postMessage(
      { channel: FRAME_CHANNEL, type: "report", nonce: m.nonce, ...result },
      event.origin,
    );
  });
}
export function createFrameBridge({ lifecycle: externalLifecycle } = {}) {
  const lifecycle = externalLifecycle || createLifecycle();
  const states = new Map();
  let options = { enabled: true, muted: false };
  function origin(frame) {
    try {
      return new URL(frame.getAttribute("src"), location.href).origin;
    } catch {
      return null;
    }
  }
  lifecycle.on(window, "message", (event) => {
    const m = event.data;
    if (m?.channel !== FRAME_CHANNEL || m.type !== "report") return;
    for (const [frame, state] of states) {
      if (
        event.source !== frame.contentWindow ||
        event.origin !== state.origin ||
        m.nonce !== state.nonce
      )
        continue;
      state.report = {
        supported: m.supported === true,
        state: String(m.state || "unknown"),
        error: typeof m.error === "string" ? m.error.slice(0, 64) : null,
        paused: typeof m.paused === "boolean" ? m.paused : null,
        position: Number.isFinite(m.position) ? m.position : null,
        ended: m.ended === true,
        selector: String(m.selector || "").slice(0, 32),
      };
      state.at = Date.now();
    }
  });
  function inspect(frames, next = options) {
    options = next;
    for (const frame of [...states.keys()]) if (!frames.includes(frame)) states.delete(frame);
    const reports = [];
    for (const frame of frames) {
      const src = frame.getAttribute?.("src") || "";
      if (next.muted && allowed.has(origin(frame))) {
        const permissions = frame.getAttribute?.("allow") || "";
        if (!/\bautoplay\b/.test(permissions))
          frame.setAttribute?.("allow", `${permissions}${permissions ? "; " : ""}autoplay`);
      }
      let state = states.get(frame);
      if (!state || state.src !== src) {
        state = {
          src,
          nonce: crypto.randomUUID(),
          origin: origin(frame),
          at: 0,
          report: null,
          adapter: null,
        };
        states.set(frame, state);
      }
      try {
        const doc = frame.contentDocument;
        if (doc) {
          if (state.document !== doc) {
            state.document = doc;
            state.adapter = createSkinAdapter(doc);
          }
          state.report = state.adapter.inspect(options);
          if (!state.report.supported && doc.readyState && doc.readyState !== "complete")
            state.report.state = "waiting";
          state.at = Date.now();
        }
      } catch {
        /* Cross-origin document access is intentionally not bypassed. */
      }
      if (!state.adapter && allowed.has(state.origin))
        frame.contentWindow?.postMessage(
          {
            channel: FRAME_CHANNEL,
            type: "inspect",
            nonce: state.nonce,
            enabled: options.enabled,
            muted: options.muted,
          },
          state.origin,
        );
      reports.push(
        state.report && Date.now() - state.at < 180000
          ? state.report
          : {
              supported: false,
              state: allowed.has(state.origin) ? "waiting" : "inaccessible",
            },
      );
    }
    return (
      reports.find((item) => item.supported) || reports[0] || { supported: false, state: "unknown" }
    );
  }
  function command(enabled, gesture = false) {
    return inspect([...states.keys()], { ...options, enabled, gesture });
  }
  if (!externalLifecycle)
    window.addEventListener("pagehide", () => lifecycle.dispose(), {
      once: true,
    });
  return { inspect, command };
}
