import { route, courseId } from "./constants.js";
// Channel-backed handles cannot create tabs. A match requires run, job, course and nonce.
export function createCourseLinks({ channel, lifecycle, timeoutMs = 1800 }) {
  const pending = new Map(),
    handles = new Set();
  const matches = (a, b) => a.run === b.run && a.job === b.job && String(a.id) === String(b.id);
  function receive({ data: m }) {
    if (!m) return;
    if (m.type === "course-link-present") {
      const request = pending.get(m.nonce);
      if (!request || !matches(request, m)) return;
      request.finish(makeHandle(m));
    }
    if (m.type === "leaving" || m.type === "course-link-closed")
      for (const handle of handles) if (matches(handle, m)) handle.closed = true;
    if (m.type === "heartbeat")
      for (const handle of handles) if (matches(handle, m)) handle.closed = false;
  }
  function makeHandle(m) {
    for (const existing of handles)
      if (matches(existing, m)) {
        existing.closed = false;
        return existing;
      }
    const handle = {
      run: m.run,
      job: m.job,
      id: String(m.id),
      closed: false,
      close() {
        if (!this.closed)
          channel.postMessage({
            type: "course-link-close",
            run: this.run,
            job: this.job,
            id: this.id,
          });
      },
    };
    handles.add(handle);
    return handle;
  }
  lifecycle.on(channel, "message", receive);
  lifecycle.defer(() => {
    for (const request of [...pending.values()]) request.finish(null);
    handles.clear();
  });
  function connect(run, job, id) {
    if (lifecycle.disposed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const nonce = crypto.randomUUID();
      let timer;
      const request = {
        run,
        job,
        id: String(id),
        finish(value) {
          clearTimeout(timer);
          pending.delete(nonce);
          resolve(value);
        },
      };
      pending.set(nonce, request);
      timer = setTimeout(() => request.finish(null), timeoutMs);
      channel.postMessage({
        type: "course-link-probe",
        run,
        job,
        id: String(id),
        nonce,
      });
    });
  }
  return { connect };
}
export function bindCourseLinkResponder({ channel, runtime, lifecycle }) {
  const current = (m) =>
    route() === "#/class" &&
    m?.run === runtime.run &&
    m.job === runtime.job &&
    String(m.id) === courseId();
  lifecycle.on(channel, "message", ({ data: m }) => {
    if (!current(m)) return;
    if (m.type === "course-link-probe" && typeof m.nonce === "string") {
      channel.postMessage({
        type: "course-link-present",
        run: runtime.run,
        job: runtime.job,
        id: courseId(),
        nonce: m.nonce,
      });
    }
    if (m.type === "course-link-close") {
      runtime.exitBridge.arm();
      for (const video of document.querySelectorAll(".video_wrap video")) video.pause();
      window.close();
      // Closure is confirmed by pagehide/leaving, never by requesting close alone.
    }
  });
  lifecycle.on(window, "pagehide", () => {
    if (route() === "#/class")
      channel.postMessage({
        type: "course-link-closed",
        run: runtime.run,
        job: runtime.job,
        id: courseId(),
      });
  });
}
