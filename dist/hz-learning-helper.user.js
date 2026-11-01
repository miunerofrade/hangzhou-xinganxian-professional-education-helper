// ==UserScript==
// @name         杭州学习新干线 · 单课程调度助手
// @namespace    local.hz-learning-helper
// @version      1.35.3
// @description  课程调度与手动管理；同步平台已学记录后自动过滤。
// @match        https://learning.hzrs.hangzhou.gov.cn/*
// @match        https://xc-course.hzrs.hangzhou.gov.cn/*
// @include      https://xc-course.hzrs.hangzhou.gov.cn:5443/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  // src/no-debug-hooks.js
  function installDebugHooks() {}
  function bindDebugHooks() {}

  // src/lifecycle.js
  function createLifecycle() {
    const cleanups = /* @__PURE__ */ new Set();
    let disposed = false;
    function defer(cleanup) {
      if (disposed) {
        cleanup();
        return () => {};
      }
      cleanups.add(cleanup);
      return () => cleanups.delete(cleanup);
    }
    function on(target, type, handler, options) {
      if (disposed || !target?.addEventListener) return () => {};
      target.addEventListener(type, handler, options);
      const remove = () => target.removeEventListener?.(type, handler, options);
      const forget = defer(remove);
      return () => {
        forget();
        remove();
      };
    }
    function interval(handler, ms) {
      if (disposed) return null;
      const id = setInterval(handler, ms);
      defer(() => clearInterval(id));
      return id;
    }
    function timeout(handler, ms) {
      if (disposed) return null;
      let forget = () => {};
      const id = setTimeout(() => {
        forget();
        if (!disposed) handler();
      }, ms);
      forget = defer(() => clearTimeout(id));
      return id;
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      for (const cleanup of [...cleanups].reverse()) {
        try {
          cleanup();
        } catch {}
      }
      cleanups.clear();
    }
    return {
      on,
      interval,
      timeout,
      defer,
      dispose,
      get disposed() {
        return disposed;
      },
    };
  }

  // src/constants.js
  var ORIGIN = "https://learning.hzrs.hangzhou.gov.cn";
  var PREFIX = "[杭州学习助手]";
  var CHANNEL = "hz-learning-helper-v1";
  var configKey = (run) => `hz-helper:${run}`;
  var route = () => location.hash.split("?")[0].toLowerCase();
  var courseId = () => new URLSearchParams(location.hash.split("?")[1] || "").get("courseId");
  var closeApprovalKey = (run, job) => `hz-helper-close-approved:${run}:${job}`;
  var COURSE_ORIGIN = "https://xc-course.hzrs.hangzhou.gov.cn";
  var FRAME_ORIGINS = [ORIGIN, COURSE_ORIGIN, `${COURSE_ORIGIN}:5443`];
  var ACTION_DELAY_MS = 2e3;

  // src/course-links.js
  function createCourseLinks({ channel, lifecycle, timeoutMs = 1800 }) {
    const pending = /* @__PURE__ */ new Map(),
      handles = /* @__PURE__ */ new Set();
    const matches = (a, b) => a.run === b.run && a.job === b.job && String(a.id) === String(b.id);
    function receive({ data: m }) {
      if (!m) return;
      if (m.type === "course-link-present") {
        const request = pending.get(m.nonce);
        if (!request || !matches(request, m)) return;
        request.finish(makeHandle(m));
      }
      if (m.type === "leaving" || m.type === "course-link-closed") {
        for (const handle of handles) if (matches(handle, m)) handle.closed = true;
      }
      if (m.type === "heartbeat") {
        for (const handle of handles) if (matches(handle, m)) handle.closed = false;
      }
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
  function bindCourseLinkResponder({ channel, runtime, lifecycle }) {
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

  // src/utils.js
  var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  var log = (message, detail) =>
    console.info(PREFIX, /* @__PURE__ */ new Date().toLocaleTimeString(), message, detail ?? "");
  var visible = (el) =>
    !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  var text = (el) => (el?.textContent || "").replace(/\s+/g, "").trim();
  var number = (value) =>
    value !== null && value !== "" && value !== void 0 && Number.isFinite(Number(value))
      ? Number(value)
      : NaN;
  var round = (n) => Number(n.toFixed(3));

  // src/frames/adapter.js
  function inspectSkin(root) {
    const one = (selector) => [...root.querySelectorAll(selector)].find(visible);
    const start = one("#playVideo");
    const play = one("#toPlay");
    const toggle = one("#toPause");
    const media = [...root.querySelectorAll("video,audio")];
    return {
      supported: !!(
        start ||
        play ||
        toggle ||
        (root.querySelector?.("#firstPanel,#leftPanel,#mediaControlDiv") && media.length)
      ),
      start,
      play,
      toggle,
      mediaElements: media,
      media:
        media.length === 1
          ? media[0]
          : media.filter((item) => item.tagName === "VIDEO").length === 1
            ? media.find((item) => item.tagName === "VIDEO")
            : null,
    };
  }
  function accessibleDocuments(root, depth = 0, seen = /* @__PURE__ */ new Set()) {
    if (!root || seen.has(root) || depth > 4) return [];
    seen.add(root);
    const result = [root];
    for (const frame of root.querySelectorAll("iframe")) {
      try {
        if (frame.contentDocument)
          result.push(...accessibleDocuments(frame.contentDocument, depth + 1, seen));
      } catch {}
    }
    return result;
  }
  function createSkinAdapter(root) {
    let started = false,
      lastClick = 0,
      lastAttempt = 0,
      lastError = "",
      pending = false;
    const mutedByHelper = /* @__PURE__ */ new WeakMap();
    function inspect({ enabled = true, muted = false, gesture = false } = {}) {
      const documents = accessibleDocuments(root);
      const candidates = documents.map(inspectSkin);
      const skin =
        candidates.find((item) => item.supported && item.media) ||
        candidates.find((item) => item.supported);
      if (!skin) {
        let inaccessible = false;
        let loading = false;
        for (const doc of documents) {
          if (doc.readyState && doc.readyState !== "complete") loading = true;
          for (const frame of doc.querySelectorAll("iframe")) {
            try {
              const child = frame.contentDocument;
              if (!child || !documents.includes(child)) inaccessible = true;
            } catch {
              inaccessible = true;
            }
          }
        }
        return {
          supported: false,
          state: loading ? "waiting" : inaccessible ? "inaccessible" : "unknown",
        };
      }
      const media = skin.media;
      if (media && media.playbackRate !== 1)
        return { supported: true, state: "unsupported", error: "rate" };
      for (const item of skin.mediaElements) {
        if (muted) {
          if (!mutedByHelper.has(item)) mutedByHelper.set(item, item.muted);
          item.muted = true;
        } else if (mutedByHelper.has(item)) {
          item.muted = mutedByHelper.get(item);
          mutedByHelper.delete(item);
        }
      }
      if (!enabled) {
        if (skin.mediaElements.some((item) => !item.paused)) {
          if (skin.toggle) skin.toggle.click();
          for (const item of skin.mediaElements) item.pause();
        }
        return report("paused");
      }
      if (media?.ended) return report("ended");
      if (media && !media.paused) {
        lastError = "";
        return report("playing");
      }
      const now = Date.now();
      try {
        if (!started && skin.start) {
          started = true;
          lastClick = now;
          skin.start.click();
        } else if (
          (media?.paused || (!started && skin.play)) &&
          (gesture || now - lastClick >= 5e3)
        ) {
          const control = skin.play || skin.toggle;
          if (control) {
            started = true;
            lastClick = now;
            control.click();
          }
        }
        if (media?.paused && !pending && (gesture || now - lastAttempt >= 5e3)) {
          lastAttempt = now;
          pending = true;
          Promise.resolve(media.play())
            .then(
              () => {
                lastError = "";
              },
              (error) => {
                lastError = String(error?.name || "Error");
              },
            )
            .finally(() => {
              pending = false;
            });
        }
      } catch (error) {
        lastError = String(error?.name || "Error");
      }
      return report(
        lastError === "NotAllowedError"
          ? "blocked"
          : lastError
            ? "error"
            : media && !media.paused
              ? "playing"
              : "starting",
      );
      function report(state) {
        return {
          supported: true,
          state,
          error: lastError || null,
          paused: media ? !!media.paused : null,
          position:
            media && Number.isFinite(media.currentTime) ? Math.round(media.currentTime) : null,
          ended: media ? !!media.ended : false,
          selector: skin.start ? "#playVideo" : skin.play ? "#toPlay" : "#toPause",
          label: skin.start ? text(skin.start).slice(0, 32) : null,
        };
      }
    }
    return { inspect };
  }

  // src/frames/bridge.js
  var FRAME_CHANNEL = "hz-helper-course-frame-v1";
  var allowed = new Set(FRAME_ORIGINS);
  function startFrameWorker() {
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
  function createFrameBridge({ lifecycle: externalLifecycle } = {}) {
    const lifecycle = externalLifecycle || createLifecycle();
    const states = /* @__PURE__ */ new Map();
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
        } catch {}
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
          state.report && Date.now() - state.at < 18e4
            ? state.report
            : {
                supported: false,
                state: allowed.has(state.origin) ? "waiting" : "inaccessible",
              },
        );
      }
      return (
        reports.find((item) => item.supported) ||
        reports[0] || { supported: false, state: "unknown" }
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

  // src/storage.js
  function writeJSON(key, value, storage = localStorage) {
    const encoded = JSON.stringify(value);
    if (storage.getItem(key) === encoded) return false;
    storage.setItem(key, encoded);
    return true;
  }
  function migrateCourse(course) {
    const { credits, ...rest } = course;
    return { ...rest, hours: Number(course.hours ?? credits) };
  }
  function readLog(key) {
    try {
      const rows = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }
  function appendLog(key, row, limit = 30) {
    const rows = readLog(key);
    rows.push(row);
    writeJSON(key, rows.slice(-limit));
  }

  // src/event-log.js
  var LOG_KEY = "hz-helper-events-v1";
  var LOG_LIMIT = 30;
  var listeners = /* @__PURE__ */ new Set();
  function onLogChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  function eventLevel(row) {
    if (["debug", "info", "warning", "error"].includes(row.level)) return row.level;
    if (row.kind === "error" || Number(row.http) >= 400 || row.platform === -1) return "error";
    if (
      row.kind === "warning" ||
      /重试|暂停|未响应|未识别|未读到|未完成|异常/.test(row.event || "")
    )
      return "warning";
    return "info";
  }
  function recordEvent(kind, event, detail = "", extra = {}) {
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
        } catch {}
      }
    } catch {}
  }
  function migrateLogs() {
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
    } catch {}
  }

  // src/runtime.js
  function createRuntime({ lifecycle }) {
    migrateLogs();
    const q = new URLSearchParams(location.hash.split("?")[1] || "");
    let run = q.get("__hzRun"),
      job = q.get("__hzJob");
    let directConfig = null,
      direct = false;
    if (route() === "#/class" && courseId()) {
      let task;
      try {
        task = JSON.parse(localStorage.getItem(configKey(run)) || "null");
      } catch {}
      if (!run || !job || task?.job !== job || String(task?.course?.id) !== courseId()) {
        direct = true;
        run = `direct-${crypto.randomUUID()}`;
        job = crypto.randomUUID();
        directConfig = {
          job,
          course: { id: courseId(), name: q.get("coursetitle") || "当前课程" },
          autoContinue: true,
        };
      }
    }
    let onAuthObservation = () => {},
      onStudyObservation = (http, platform, finish) =>
        recordEvent(
          "report",
          "平台进度上报",
          `HTTP ${Number(http) || 0}；平台状态 ${Number.isFinite(Number(platform)) ? Number(platform) : "未知"}；完成标记 ${[0, 1, "0", "1"].includes(finish) ? finish : "未知"}`,
        ),
      lastAuthSuccess = -Infinity;
    const knownAuthPaths = /* @__PURE__ */ new Set([
      "/api/index/Study.Index/startPlay",
      "/api/index/Study.Index/updateStudy",
      "/api/index/Study.Index/autoPause",
      "/api/index/Study.Index/confirmPlay",
      "/api/index/Study.Index/finishStudy",
      "/api/index/Study.StudyHour/myStudyList",
      "/api/index/Study.UserIndex/index",
      "/api/index/index/SelectCourse",
      "/api/index/Course/index",
      "/api/index/index/getCourseInfo",
      "/api/index/Auth.Index/login",
      "/api/index/Auth.Index/gotoSystem",
    ]);
    function authPath(value) {
      try {
        const url = new URL(String(value), location.href);
        if (url.origin !== ORIGIN || !url.pathname.startsWith("/api/")) return null;
        return knownAuthPaths.has(url.pathname) ? url.pathname : "其他平台接口";
      } catch {
        return null;
      }
    }
    function observeAuthResponse(path, http, platform, transport) {
      if (!path) return;
      const numeric =
        platform === null || platform === void 0 || platform === "" ? null : Number(platform);
      const code = Number.isFinite(numeric) ? numeric : null,
        status = Number.isFinite(http) ? http : 0;
      if (
        code !== 100 &&
        code !== -1 &&
        status !== 401 &&
        status !== 403 &&
        status !== 0 &&
        code !== 200
      )
        return;
      if (code === 200 && status === 200) {
        if (Date.now() - lastAuthSuccess < 3e5) return;
        lastAuthSuccess = Date.now();
      }
      try {
        recordEvent(
          "auth",
          code === 100
            ? "收到续期响应"
            : code === -1
              ? "登录已过期"
              : status === 401 || status === 403
                ? "授权被拒绝"
                : status === 0
                  ? "请求未完成"
                  : "登录请求正常（采样）",
          `${transport}；HTTP ${status}；平台状态 ${code}；${path}`,
          { path, http: status, platform: code, transport },
        );
        onAuthObservation();
      } catch {}
    }
    function installAuthObserver() {
      const proto = window.XMLHttpRequest?.prototype;
      if (!proto || typeof proto.open !== "function") return;
      const originalOpen = proto.open,
        states = /* @__PURE__ */ new WeakMap();
      proto.open = function (method, url, ...rest) {
        const result = Reflect.apply(originalOpen, this, [method, url, ...rest]);
        let state = states.get(this);
        if (!state) {
          state = { path: null };
          states.set(this, state);
          this.addEventListener("loadend", () => {
            try {
              if (!state.path) return;
              let body = null;
              if (this.responseType === "" || this.responseType === "text") {
                try {
                  body = JSON.parse(this.responseText);
                } catch {}
              } else if (this.responseType === "json") body = this.response;
              observeAuthResponse(state.path, this.status, body?.status, "平台 XHR");
              if (
                [
                  "/api/index/Study.Index/startPlay",
                  "/api/index/Study.Index/confirmPlay",
                  "/api/index/Study.Index/autoPause",
                  "/api/index/Study.Index/finishStudy",
                ].includes(state.path)
              )
                recordEvent(
                  "report",
                  "平台播放请求",
                  `${state.path.split("/").at(-1)}；HTTP ${this.status}；平台状态 ${Number(body?.status) || 0}`,
                  {
                    path: state.path,
                    http: this.status,
                    platform: Number(body?.status) || null,
                  },
                );
              if (state.path === "/api/index/Study.Index/updateStudy")
                onStudyObservation(this.status, body?.status, body?.data?.finish);
            } catch {}
          });
        }
        state.path = authPath(url);
        return result;
      };
    }
    installAuthObserver();
    let previousToken = localStorage.getItem("front_token");
    lifecycle.interval(() => {
      const current = localStorage.getItem("front_token");
      if (current === previousToken) return;
      const event =
        previousToken && current ? "登录凭据已更新" : current ? "检测到登录" : "登录凭据已清除";
      previousToken = current;
      recordEvent("auth", event, "仅记录变化事件，不保存 token；更新不单独证明登录有效期已延长");
    }, 5e3);
    const exitBridge = installExitBridge();
    function installExitBridge() {
      let config;
      try {
        config = directConfig || JSON.parse(localStorage.getItem(configKey(run)) || "null");
      } catch {}
      if (
        !run ||
        !job ||
        route() !== "#/class" ||
        config?.job !== job ||
        String(config?.course?.id) !== courseId()
      )
        return { arm() {} };
      function approvedByController() {
        try {
          const approval = JSON.parse(localStorage.getItem(closeApprovalKey(run, job)) || "null");
          return (
            ["learning-center", "recovery"].includes(approval?.source) &&
            String(approval.id) === String(config.course.id) &&
            Number(approval.at) > 0
          );
        } catch {
          return false;
        }
      }
      let allowAutomaticExit = false;
      const add = window.addEventListener,
        remove = window.removeEventListener;
      const wrappers = /* @__PURE__ */ new WeakMap();
      const captureOf = (options) => (typeof options === "boolean" ? options : !!options?.capture);
      window.addEventListener = function (type, listener, options) {
        if (
          this !== window ||
          type !== "beforeunload" ||
          !listener ||
          !["function", "object"].includes(typeof listener)
        )
          return add.call(this, type, listener, options);
        let map = wrappers.get(listener);
        if (!map) {
          map = /* @__PURE__ */ new Map();
          wrappers.set(listener, map);
        }
        const capture = captureOf(options);
        if (!map.has(capture))
          map.set(capture, function (event) {
            let delivered = event;
            if (
              (allowAutomaticExit || approvedByController()) &&
              route() === "#/class" &&
              courseId() === String(config.course.id)
            ) {
              delivered = new Proxy(event, {
                get(target, key) {
                  if (key === "preventDefault") return () => {};
                  if (key === "returnValue") return "";
                  const value = Reflect.get(target, key, target);
                  return typeof value === "function" ? value.bind(target) : value;
                },
                set(target, key, value) {
                  return key === "returnValue" ? true : Reflect.set(target, key, value, target);
                },
              });
            }
            if (typeof listener === "function") listener.call(window, delivered);
            else listener.handleEvent(delivered);
          });
        return add.call(this, type, map.get(capture), options);
      };
      window.removeEventListener = function (type, listener, options) {
        const wrapper = listener && wrappers.get(listener)?.get(captureOf(options));
        return remove.call(
          this,
          type,
          type === "beforeunload" && wrapper ? wrapper : listener,
          options,
        );
      };
      return {
        arm() {
          allowAutomaticExit = true;
        },
      };
    }
    return {
      run,
      job,
      direct,
      directConfig,
      exitBridge,
      observeAuthResponse,
      set onAuthObservation(fn) {
        onAuthObservation = fn;
      },
      set onStudyObservation(fn) {
        onStudyObservation = fn;
      },
    };
  }

  // src/platform.js
  function createPlatform() {
    const callbacks = {
      onNetworkRetry: (message) => log(message),
      observeAuthResponse: () => {},
    };
    const READ_APIS = /* @__PURE__ */ new Set([
      "/api/index/Course/index",
      "/api/index/index/SelectCourse",
      "/api/index/index/getCourseInfo",
      "/api/index/Study.StudyHour/myStudyList",
      "/api/index/Study.UserIndex/index",
    ]);
    async function readAPI(path, body, notifyRetry = callbacks.onNetworkRetry, retries = 3) {
      if (!READ_APIS.has(path)) throw new Error("禁止调用未列入查询白名单的接口");
      const token = localStorage.getItem("front_token");
      if (!token) throw new Error("请先在平台登录，再重新预览");
      const delays = [5e3, 1e4, 2e4].slice(0, retries);
      for (let attempt = 0; attempt <= delays.length; attempt++) {
        if (localStorage.getItem("front_token") !== token)
          throw new Error("登录凭据已变化，停止重试，请刷新重新预览");
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), 45e3);
        let retryAfter = 0;
        const startedAt = Date.now();
        let http = 0;
        let platform = null;
        try {
          const response = await fetch(ORIGIN + path, {
            method: "POST",
            credentials: "same-origin",
            redirect: "error",
            signal: abort.signal,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(body),
          });
          http = response.status;
          if (!response.ok) {
            const error = new Error(`查询失败 HTTP ${response.status}`);
            error.retryable = [408, 429].includes(response.status) || response.status >= 500;
            const hint = response.headers?.get("Retry-After");
            if (hint)
              retryAfter = Math.min(
                6e4,
                Math.max(0, Number(hint) * 1e3 || Date.parse(hint) - Date.now() || 0),
              );
            throw error;
          }
          const data = await response.json();
          platform = Number.isFinite(Number(data?.status)) ? Number(data.status) : null;
          callbacks.observeAuthResponse(path, response.status, data?.status, "助手查询");
          if (platform !== 200) {
            const reason =
              platform === -1 || platform === 401
                ? "登录已过期或身份验证未通过，请回平台检查"
                : "平台未接受本次查询";
            throw new Error(`${reason}（HTTP ${http}；平台状态 ${platform ?? "缺失"}）`);
          }
          recordEvent(
            "query",
            "查询完成",
            `${path.split("/").at(-1)}；HTTP ${http}；平台状态 ${platform}；${Date.now() - startedAt} ms`,
            {
              path,
              http,
              platform,
              elapsedMs: Date.now() - startedAt,
            },
          );
          return data;
        } catch (error) {
          recordEvent(
            "error",
            "查询失败",
            `${path.split("/").at(-1)}；HTTP ${http}；平台状态 ${platform ?? "未返回"}；${String(error.name || "Error")}；第 ${attempt + 1} 次`,
            { path, http, platform, elapsedMs: Date.now() - startedAt },
          );
          const retryable =
            error.retryable === true ||
            ["TypeError", "AbortError", "SyntaxError"].includes(error.name);
          if (!retryable) throw error;
          if (attempt === delays.length)
            throw new Error(`查询已尝试${attempt + 1}次仍失败，进度已保留；网络恢复后重试`);
          const delay = Math.max(delays[attempt], retryAfter);
          notifyRetry(
            `网络较慢，${Math.ceil(delay / 1e3)}秒后重试（${attempt + 1}/3），已读页码保留`,
          );
          recordEvent(
            "query",
            "查询重试",
            `${path.split("/").at(-1)}；${delay / 1e3} 秒后重试；第 ${attempt + 1} 次`,
          );
          log("查询重试", {
            path,
            attempt: attempt + 1,
            waitSeconds: delay / 1e3,
          });
          clearTimeout(timeout);
          await sleep(delay);
        } finally {
          clearTimeout(timeout);
        }
      }
    }
    async function accountDigest(value) {
      const result = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
      return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    async function accountScope() {
      const token = localStorage.getItem("front_token");
      if (!token) throw new Error("请先在平台登录");
      let user;
      try {
        user = JSON.parse(localStorage.getItem("use_info") || "null");
      } catch {}
      const key = ["studentid", "userid", "user_id", "id", "studentname"].find(
        (k) => user?.[k] !== void 0 && user[k] !== null && String(user[k]).trim(),
      );
      return accountDigest(key ? `${key}:${String(user[key])}` : `session:${token}`);
    }
    return { readAPI, accountScope, accountDigest, callbacks };
  }

  // src/ui/tokens.css
  var tokens_default =
    "/* Shared normal-mode palette, dimensions and type scale. Theme overrides are separate. */\n:host {\n  --font-panel: 18px;\n  --font-body: 14px;\n  --font-meta: 12px;\n  --font-heading: 16px;\n  --font-stat: 24px;\n  --card-radius: 16px;\n  --compact-card-radius: 12px;\n  --card-padding: 16px;\n  --field-height: 38px;\n  --surface: #fff;\n  --panel-shadow: 0 6px 18px rgb(0 0 0 / 12%), 0 20px 44px -12px rgb(0 0 0 / 28%);\n  --button-radius: 24px;\n  --icon-button-size: 32px;\n  --icon-size: 16px;\n  --action-gap: 12px;\n  --action-shadow-gutter: 12px;\n  --primary-shadow:\n    inset 2px 2px 3px rgb(255 255 255 / 20%), inset -2px -2px 3px rgb(0 0 0 / 20%),\n    4px 6px 10px -5px rgb(0 0 0 / 34%);\n  --button-surface: #fff;\n  --button-surface-hover: #fafafa;\n  --button-surface-pressed: #fafafa;\n  --button-shadow:\n    inset 1px 1px 1px rgb(255 255 255 / 95%), inset -1px -1px 2px rgb(0 0 0 / 4%),\n    5px 7px 10px -5px rgb(0 0 0 / 26%);\n  --button-shadow-hover:\n    inset 1px 1px 2px rgb(255 255 255 / 100%), 6px 8px 12px -6px rgb(0 0 0 / 32%);\n  --button-shadow-pressed:\n    inset 2px 2px 4px rgb(0 0 0 / 14%), inset -2px -2px 4px rgb(255 255 255 / 90%);\n  --primary-shadow-hover:\n    inset 2px 2px 3px rgb(255 255 255 / 25%), inset -2px -2px 3px rgb(0 0 0 / 22%),\n    5px 7px 12px -5px rgb(0 0 0 / 38%);\n  --primary-shadow-pressed:\n    inset 3px 3px 6px rgb(0 0 0 / 35%), inset -1px -1px 2px rgb(255 255 255 / 14%),\n    1px 2px 4px -2px rgb(0 0 0 / 20%);\n}\n";

  // src/ui/styles.css
  var styles_default =
    '/* Shared resets and disclosure semantics. */\n*,\n*::before,\n*::after {\n  box-sizing: border-box;\n}\n[hidden] {\n  display: none !important;\n}\nsvg {\n  display: block;\n  flex: none;\n}\np {\n  margin: 0;\n  overflow-wrap: anywhere;\n}\n#controls {\n  display: grid;\n  gap: 10px;\n}\n.section-head,\n.section-title {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n}\n.section-title {\n  font-weight: 600;\n}\n.section-head {\n  justify-content: space-between;\n\n  min-height: 24px;\n}\ndetails {\n  margin-top: 0;\n}\nsummary::-webkit-details-marker {\n  display: none;\n}\nsummary::before {\n  content: "›";\n  font-size: var(--font-heading);\n  line-height: 1;\n  transition: transform 0.12s;\n}\ndetails[open] > summary::before {\n  transform: rotate(90deg);\n}\n@media (prefers-reduced-motion: reduce) {\n  summary::before {\n    transition: none;\n  }\n}\nsummary:focus-visible {\n  outline: 2px solid #111;\n  outline-offset: 3px;\n}\n.section-title {\n  color: #595959;\n\n  font-size: var(--font-body);\n}\nsummary {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  min-height: 29px;\n  color: #717171;\n  cursor: pointer;\n  list-style: none;\n  font-size: var(--font-meta);\n}\n';

  // src/ui/panel-shell.css
  var panel_shell_default =
    '/* Panel shell, viewport sizing and launcher base. */\n:host {\n  all: initial;\n  position: fixed;\n  right: 20px;\n  z-index: 2147483646;\n  font:\n    16px/1.6 -apple-system,\n    BlinkMacSystemFont,\n    "Segoe UI",\n    "PingFang SC",\n    sans-serif;\n  color: #2f2f2f;\n  color-scheme: light;\n}\n#launcher {\n  touch-action: none;\n  display: grid;\n  place-items: center;\n  width: 46px;\n  height: 46px;\n  margin-left: auto;\n  background: #ffffff;\n  border-radius: 50%;\n  box-shadow:\n    0 2px 8px #29292912,\n    0 8px 28px #29292924;\n  color: #424242;\n}\n#panel,\n#panel:focus {\n  outline: none;\n}\nh2 {\n  font-weight: 650;\n}\n.panel-caption {\n  display: block;\n  color: #717171;\n  font-size: var(--font-body);\n  letter-spacing: 1.4px;\n  margin-top: 2px;\n}\n.body {\n  display: grid;\n}\n@media (forced-colors: active) {\n  #launcher,\n  #panel {\n    outline: 1px solid CanvasText;\n  }\n}\n@media (max-width: 380px) {\n  #panel {\n    padding: 16px;\n  }\n}\n@media (max-width: 380px) {\n  #panel {\n    padding: 16px;\n  }\n}\n:host {\n  bottom: 20px;\n  font-size: var(--font-body);\n  line-height: 1.5;\n}\n#panel {\n  padding: 16px 18px;\n}\nheader {\n  display: flex;\n  justify-content: space-between;\n  align-items: center;\n  margin: 0 0 18px;\n  margin-bottom: 12px;\n}\nh2 {\n  line-height: 1.5;\n  letter-spacing: 0.2px;\n  margin: 0;\n  font-size: var(--font-heading);\n}\n.body {\n  gap: 12px;\n}\n@media (max-width: 380px) {\n  #panel {\n    padding: 14px;\n  }\n}\n#panel {\n  width: 420px;\n  height: min(82dvh, 760px);\n}\n#panel > header {\n  position: sticky;\n  top: -16px;\n  z-index: 3;\n  background: var(--surface);\n  padding: 10px 0;\n}\n@media (max-width: 460px) {\n  #panel {\n    width: calc(100vw - 24px);\n    height: 86dvh;\n  }\n}\n@media (prefers-reduced-motion: reduce) {\n  #panel {\n    scroll-behavior: auto;\n  }\n}\n#panel {\n  position: fixed;\n  top: auto;\n  left: auto;\n  max-width: calc(100vw - 24px);\n  transform-origin: 0 0;\n  overscroll-behavior: contain;\n  padding-bottom: max(18px, env(safe-area-inset-bottom));\n  overflow: auto;\n  scrollbar-width: thin;\n  background: var(--surface);\n  border: 1px solid #e5e5e5;\n  box-shadow: var(--panel-shadow);\n  bottom: 12px;\n  right: 12px;\n  border-bottom: 1px solid #e5e5e5;\n  border-radius: 20px;\n  max-height: calc(100dvh - 24px);\n}\n.header-actions {\n  display: flex;\n  align-items: center;\n  gap: 12px;\n  margin-left: auto;\n}\n#refresh-countdown {\n  font-size: var(--font-body);\n  line-height: 1.5;\n  color: #595959;\n  font-variant-numeric: tabular-nums;\n  white-space: nowrap;\n}\n';

  // src/ui/forms.css
  var forms_default =
    '/* Input and select base geometry; interactive states remain explicit. */\ninput {\n  font: inherit;\n  color: inherit;\n}\n.label-row,\n.setting-label {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n\n  justify-content: space-between;\n}\ninput:not([type="checkbox"]) {\n  border: 0;\n  border-bottom: 1px solid #a3a3a3;\n  border-radius: 0;\n  background: transparent;\n  min-width: 0;\n  padding: 8px 2px;\n}\ninput:not([type="checkbox"]):focus,\nselect:focus {\n  background: transparent;\n  border-bottom-color: #111;\n  box-shadow: 0 1px 0 #111;\n  outline: none;\n}\n.input-row {\n  display: grid;\n  grid-template-columns: 1fr;\n  gap: 8px;\n}\n.target-wrap {\n  position: relative;\n}\n.target-wrap input {\n  line-height: 1.4;\n  font-weight: 600;\n  width: 100%;\n  height: 46px;\n}\n.suffix {\n  position: absolute;\n  right: 12px;\n  top: 14px;\n  color: #737373;\n}\n.select-wrap {\n  position: relative;\n  min-width: 0;\n  width: 100%;\n}\n.select-wrap > svg {\n  position: absolute;\n  right: 10px;\n  top: 50%;\n  transform: translateY(-50%);\n  pointer-events: none;\n  color: #737373;\n}\n.category-row {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) auto;\n  align-items: center;\n  gap: 12px;\n}\n.category-row:has(#read-next[hidden]) {\n  grid-template-columns: minmax(0, 1fr);\n  gap: 0;\n}\n.category-row button {\n  min-width: 104px;\n  justify-self: stretch;\n  padding: 8px 20px;\n  min-height: var(--field-height);\n  white-space: nowrap;\n  font-size: var(--font-body);\n  color: #656565;\n  border-radius: 8px;\n}\ninput:focus-visible {\n  outline: 2px solid #111;\n  outline-offset: 3px;\n}\n.label-row label {\n  font-weight: 600;\n  font-size: var(--font-body);\n}\ninput:not([type="checkbox"]) {\n  box-shadow: none;\n  min-height: var(--field-height);\n  font-size: var(--font-body);\n}\nselect {\n  border: 0;\n  border-bottom: 1px solid #a3a3a3;\n  border-radius: 0;\n  background: transparent;\n  box-shadow: none;\n  min-width: 0;\n  padding: 8px 2px;\n  font: inherit;\n  color: inherit;\n  min-height: var(--field-height);\n  font-size: var(--font-body);\n}\n.select-wrap select {\n  width: 100%;\n\n  appearance: none;\n  -webkit-appearance: none;\n  padding-right: 32px;\n  min-height: var(--field-height);\n  font-size: var(--font-body);\n}\n.target-wrap input {\n  padding: 5px 64px 5px 2px;\n  font-size: var(--font-stat);\n}\n.suffix {\n  font-size: var(--font-meta);\n}\ninput:not([type="checkbox"]):focus-visible {\n  outline: none;\n  border-bottom-color: #111;\n  box-shadow: 0 1px 0 #111;\n}\nselect:focus-visible {\n  outline-offset: 3px;\n  outline: none;\n  border-bottom-color: #111;\n  box-shadow: 0 1px 0 #111;\n}\n.select-wrap:focus-within select {\n  outline: none;\n  border-bottom-color: #111;\n  box-shadow: 0 1px 0 #111;\n}\n';

  // src/ui/settings-base.css
  var settings_base_default =
    "/* Settings, preferences and exclusion-list base layout. */\n.annual-goals {\n  display: grid;\n  gap: 6px;\n}\n\n.preferences {\n  border-top: 1px solid #ebebeb;\n  padding-top: 12px;\n}\n.preferences > .section-title {\n  margin-bottom: 6px;\n}\n.preference-row {\n  display: flex;\n  justify-content: space-between;\n  align-items: center;\n  gap: 12px;\n}\n.preference-label {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  color: #777777;\n}\n.check {\n  display: flex;\n  gap: 10px;\n  align-items: center;\n}\n.advanced {\n  display: grid;\n  gap: 9px;\n  padding: 8px 0 10px;\n}\n.field {\n  display: grid;\n  gap: 8px;\n  align-items: center;\n}\n.field.time input {\n  font-size: var(--font-body);\n}\n.record-list {\n  list-style: none;\n  padding: 0;\n  margin: 0;\n  max-height: 150px;\n  overflow: auto;\n}\n.record-row {\n  display: flex;\n  gap: 8px;\n  align-items: center;\n  padding: 6px 0;\n  font-size: var(--font-body);\n}\n.record-row span {\n  flex: 1;\n  min-width: 0;\n  overflow-wrap: anywhere;\n}\n.field.time {\n  grid-template-columns: minmax(0, 1fr);\n}\n.field input {\n  width: 100%;\n\n  height: auto;\n}\n.preference-label label {\n  color: #4d4d4d;\n  cursor: pointer;\n  font-size: var(--font-body);\n}\n.check {\n  font-size: var(--font-body);\n}\n.field {\n  grid-template-columns: minmax(0, 1fr) 88px;\n\n  font-size: var(--font-meta);\n}\n.preference-row {\n  min-height: 36px;\n}\n.check {\n  cursor: pointer;\n  min-height: 36px;\n}\n.record-row button {\n  font-size: var(--font-meta);\n  padding: 3px 6px;\n  border-radius: 4px;\n  color: #6b6b6b;\n  background: #f4f4f4;\n  min-height: 30px;\n}\n.preference-label,\n.field {\n  line-height: 1.5;\n}\n.settings-actions {\n  display: grid;\n  grid-template-columns: repeat(2, minmax(0, 1fr));\n  gap: 12px;\n  width: 100%;\n}\n.settings-actions > .reset {\n  width: 100%;\n  min-width: 0;\n  min-height: 42px;\n  border-radius: 24px;\n  padding: 9px 10px;\n  text-align: center;\n  justify-content: center;\n  line-height: 1.5;\n}\n";

  // src/ui/course-list.css
  var course_list_default =
    '/* Course rows, list scrolling and metadata base. */\n.row-actions {\n  grid-column: 1 / -1;\n  margin-bottom: var(--action-shadow-gutter);\n}\n.row-actions button {\n  display: inline-flex;\n}\n#preview:not(:empty) {\n  border-top: 1px solid #ebebeb;\n  padding-top: 12px;\n}\n.list-title {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n\n  justify-content: space-between;\n}\n.course-list {\n  padding: 0;\n  margin: 0;\n  list-style: none;\n  max-height: min(340px, 46dvh);\n  overflow-y: auto;\n  overflow-x: hidden;\n  overscroll-behavior-y: contain;\n  scrollbar-gutter: stable;\n  scrollbar-width: thin;\n}\n.course {\n  display: grid;\n  grid-template-columns: 20px minmax(0, 1fr);\n  gap: 8px;\n  padding: 9px 0;\n  border-bottom: 1px solid #f2f2f2;\n}\n.course:last-child {\n  border-bottom: 0;\n}\n.ordinal {\n  font-variant-numeric: tabular-nums;\n  padding-top: 3px;\n}\n.course-title {\n  color: #474747;\n  line-height: 1.6;\n  -webkit-box-orient: vertical;\n}\n.course-meta {\n  display: flex;\n  flex-wrap: wrap;\n  margin-top: 4px;\n}\n.score {\n  white-space: nowrap;\n}\n.empty {\n  padding: 10px 0;\n}\n#preview:empty {\n  display: none;\n}\n.course.current {\n  border-bottom: 0;\n  background: #edf7ef;\n  border: 0;\n  border-radius: 0;\n  box-shadow: none;\n}\n.course.current.paused {\n  background: transparent;\n}\n.course-current-badge {\n  align-items: center;\n  gap: 5px;\n  margin-bottom: 4px;\n\n  display: block;\n  color: #31563b;\n}\n.course-current-badge::before {\n  width: 5px;\n  height: 5px;\n  border-radius: 50%;\n  background: #6e6e6e;\n\n  content: "";\n  display: none;\n}\n.course-title {\n  display: block;\n}\n.course-content {\n  min-width: 0;\n}\n.course-meta {\n  gap: 4px 12px;\n}\n.course-facts {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 4px 12px;\n}\n.score,\n.course-meta,\n.ordinal,\n.empty {\n  color: #595959;\n}\n.course-title {\n  overflow: visible;\n  -webkit-line-clamp: unset;\n  overflow-wrap: anywhere;\n  font-size: var(--font-body);\n}\n.list-title b {\n  font-weight: 600;\n  color: #737373;\n  font-size: var(--font-body);\n}\n.course-meta,\n.ordinal,\n.score,\n.row-actions button,\n.empty {\n  font-size: var(--font-meta);\n}\n.row-actions button {\n  flex-direction: row-reverse;\n  gap: 4px;\n  min-height: 30px;\n}\n.course {\n  padding-top: 8px;\n  padding-bottom: 8px;\n}\n.course-current-badge {\n  border: 0;\n  border-radius: 0;\n  background: transparent;\n  font-size: var(--font-meta);\n}\n.course-name {\n  line-height: 1.5;\n}\n.course-meta {\n  justify-content: flex-start;\n  line-height: 1.5;\n}\n';

  // src/ui/hours.css
  var hours_default =
    "/* Credit metrics and shared progress geometry. */\n.annual {\n  border-top: 1px solid #ebebeb;\n  padding-top: 12px;\n}\n.annual-grid {\n  display: grid;\n  grid-template-columns: repeat(3, minmax(0, 1fr));\n  gap: 8px;\n  margin: 10px 0 12px;\n}\n.annual-grid strong {\n  display: flex;\n  font-weight: 600;\n  font-variant-numeric: tabular-nums;\n}\n.annual-grid small {\n  color: #717171;\n}\n.official-meta {\n  display: flex;\n  justify-content: space-between;\n  flex-wrap: wrap;\n  gap: 3px 8px;\n}\n.official-meta b {\n  font-weight: 500;\n  color: #616161;\n}\n#dashboard:not(:empty) {\n  border-top: 1px solid #ebebeb;\n  padding-top: 12px;\n}\n.stats {\n  display: grid;\n  grid-template-columns: 1fr 1fr;\n  gap: 16px;\n}\n.stat strong {\n  line-height: 1.6;\n  font-weight: 600;\n}\n.progress-track {\n  width: 100%;\n  height: 6px;\n  overflow: hidden;\n  background: #ededed;\n  border-radius: 3px;\n}\n.progress-fill {\n  width: 0;\n  height: 100%;\n  border-radius: inherit;\n  background: #595959;\n  transition: width 300ms ease-out;\n}\n.round-progress {\n  margin-top: 8px;\n}\n@media (prefers-reduced-motion: reduce) {\n  .progress-fill {\n    transition: none;\n  }\n}\n@media (max-width: 380px) {\n  .annual-grid strong {\n    font-size: 20px;\n  }\n  .annual-grid > div {\n    padding: 2px 0;\n  }\n}\n#dashboard:empty {\n  display: none;\n}\n.annual-grid {\n  column-gap: 12px;\n  row-gap: 12px;\n}\n.annual-grid strong {\n  line-height: 1.4;\n}\n.annual-grid > div {\n  min-width: 0;\n  padding: 0;\n  border: 0;\n  border-radius: 0;\n  background: transparent;\n}\n.official-meta {\n  color: #595959;\n}\n@media (max-width: 380px) {\n  .annual-grid {\n    gap: 8px;\n  }\n  .annual-grid strong {\n    font-size: var(--font-stat);\n  }\n  .annual-grid > div {\n    padding: 0;\n  }\n  .official-meta {\n    flex-direction: column;\n    align-items: flex-start;\n  }\n}\n.annual-grid strong {\n  flex-wrap: wrap;\n  white-space: normal;\n  align-items: baseline;\n  gap: 2px;\n  letter-spacing: -0.6px;\n  font-size: var(--font-stat);\n}\n.annual-grid small {\n  font-weight: 400;\n  letter-spacing: 0;\n  font-size: var(--font-meta);\n}\n.annual-grid > div > span {\n  color: #737373;\n  font-size: var(--font-meta);\n}\n.official-meta {\n  font-size: var(--font-meta);\n}\n.stat span,\n.stat small {\n  color: #717171;\n  font-size: var(--font-meta);\n}\n.stat strong {\n  margin-right: 4px;\n  font-size: 20px;\n}\n@media (max-width: 380px) {\n  .annual-grid strong {\n    font-size: 22px;\n  }\n}\n.official-meta {\n  line-height: 1.5;\n}\n.progress-track {\n  box-shadow:\n    inset 1px 1px 2px rgb(0 0 0 / 8%),\n    inset -1px -1px 1px rgb(255 255 255 / 80%);\n}\n";

  // src/ui/status.css
  var status_default =
    "/* Status and course-progress layout. */\n.status-section {\n  display: grid;\n  gap: 0;\n  background: transparent;\n  border: 0;\n  border-radius: 0;\n  padding: 0;\n  box-shadow: none;\n}\n.status-section:not(\n  :has(\n    #status-line:not([hidden]),\n    #center-progress:not([hidden]),\n    #center-status:not([hidden]):not(:empty),\n    #learned-summary:not(:empty),\n    #history-progress:not(:empty),\n    #progress:not(:empty)\n  )\n) {\n  display: none;\n}\n\n#progress {\n  font-weight: 500;\n}\n#center-status:empty,\n#learned-summary:empty,\n#progress:empty {\n  display: none;\n}\n#progress:not(:empty) {\n  background: transparent;\n  border: 0;\n  border-radius: 0;\n  padding: 0;\n  box-shadow: none;\n}\n.player-panel #progress:not(:empty) {\n  border-radius: var(--compact-card-radius);\n  background: #edf7ef;\n  color: #31563b;\n  padding: 10px 12px;\n}\n.player-panel.is-paused #progress:not(:empty) {\n  background: #f3f3f3;\n  color: #444;\n}\n#state,\n#center-status,\n#learned-summary,\n#progress {\n  font-size: var(--font-body);\n}\n#history-progress {\n  font-size: var(--font-body);\n}\n#history-progress:empty {\n  display: none;\n}\n#state,\n#center-status,\n#learned-summary {\n  line-height: 1.5;\n  white-space: pre-line;\n  color: #626262;\n  margin: 0;\n}\n#history-progress {\n  line-height: 1.5;\n  white-space: pre-line;\n  margin: 0;\n}\n#progress {\n  line-height: 1.5;\n  white-space: pre-line;\n  color: #444444;\n  margin: 0;\n}\n#center-progress {\n  width: 100%;\n  margin: 0;\n}\n.course-progress-head {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 12px;\n  margin-bottom: 8px;\n  color: #595959;\n  font-size: var(--font-body);\n  line-height: 1.5;\n}\n#center-check-time {\n  margin-left: 0;\n  white-space: nowrap;\n  font-variant-numeric: tabular-nums;\n}\n.course-progress-meta {\n  display: flex;\n  align-items: center;\n  flex-wrap: wrap;\n  gap: 4px 12px;\n  min-width: 0;\n  margin-right: auto;\n}\n#check-course-progress {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  border-radius: 50%;\n}\n";

  // src/ui/button-layout.css
  var button_layout_default =
    "/* Action layout, icon geometry and base interaction states. */\nbutton {\n  font: inherit;\n  color: inherit;\n  cursor: pointer;\n  border: 0;\n  background: transparent;\n  padding: 0;\n}\nbutton:disabled {\n  cursor: default;\n  opacity: 0.5;\n}\n.icon-button {\n  display: grid;\n  place-items: center;\n  width: 32px;\n  height: 32px;\n  border-radius: 8px;\n  color: #6e6e6e;\n}\n.icon-button:hover {\n  background: #f4f4f4;\n}\n.actions {\n  display: grid;\n  gap: 8px;\n}\n.actions > button {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  gap: 7px;\n  border-radius: 9px;\n  padding: 8px 10px;\n  font-weight: 550;\n  background: #f2f2f2;\n  color: #444444;\n}\n.worker-actions > button {\n  display: flex;\n  gap: 7px;\n  border-radius: 9px;\n  padding: 8px 10px;\n  font-weight: 550;\n  background: #f2f2f2;\n  color: #444444;\n}\n.worker-actions {\n  display: grid;\n  gap: 8px;\n}\n.quiet-action {\n  display: inline-flex;\n  align-items: center;\n  gap: 5px;\n  padding: 3px 0;\n  background: transparent;\n  border-radius: 4px;\n}\n.quiet-action:hover {\n  color: #4e4e4e;\n}\n.quiet-action:last-child:hover {\n  color: #585858;\n}\n.action-icon {\n  display: inline-flex;\n}\n.refresh {\n  display: inline-flex;\n  align-items: center;\n  gap: 5px;\n  min-height: 26px;\n  padding: 0 3px;\n}\n.refresh:hover {\n  color: #4b4b4b;\n}\n.reset:hover {\n  color: #494949;\n}\n.icon-button {\n  min-width: 32px;\n  min-height: 32px;\n}\n.quiet-action,\n.refresh {\n  color: #595959;\n}\nbutton:focus-visible {\n  outline: 2px solid #111;\n  outline-offset: 3px;\n}\n.actions > button,\n.worker-actions > button {\n  font-size: var(--font-body);\n}\n.quiet-action,\n.reset,\n.refresh {\n  font-size: var(--font-meta);\n}\n.actions > button {\n  min-height: var(--field-height);\n}\n.worker-actions > button {\n  align-items: center;\n  justify-content: center;\n  min-height: var(--field-height);\n}\n.actions {\n  grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr) 38px;\n}\n.actions > .icon-button {\n  padding: 0;\n  width: 38px;\n}\n.quiet-action {\n  min-height: 30px;\n}\n.reset {\n  width: fit-content;\n\n  text-align: left;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  min-height: var(--field-height);\n  padding: 8px 14px;\n  border: 1px solid #b8b8b8;\n  background: #f5f5f5;\n  border-radius: 10px;\n  color: #333;\n}\n.reset:not(:disabled):hover {\n  background: #e9e9e9;\n  border-color: #888;\n}\n.worker-actions {\n  grid-template-columns: 1fr;\n}\n#scheduler-actions {\n  display: flex;\n  gap: 8px;\n}\n#scheduler-actions > #plan {\n  min-width: 0;\n  flex-basis: 0;\n  white-space: nowrap;\n  overflow: hidden;\n}\n#scheduler-actions > #start {\n  flex-basis: 0;\n}\n#scheduler-actions > #plan {\n  flex-grow: 1;\n  transition:\n    flex-grow 360ms cubic-bezier(0.2, 0.8, 0.2, 1),\n    padding 360ms cubic-bezier(0.2, 0.8, 0.2, 1),\n    margin 360ms cubic-bezier(0.2, 0.8, 0.2, 1),\n    opacity 180ms ease-out;\n}\n#scheduler-actions > #start {\n  min-width: 0;\n  white-space: nowrap;\n  overflow: hidden;\n  flex-grow: 1.15;\n}\n#scheduler-actions.has-started > #plan {\n  flex-grow: 0;\n  padding-inline: 0;\n  margin-right: -8px;\n  opacity: 0;\n  pointer-events: none;\n}\n@media (prefers-reduced-motion: reduce) {\n  #scheduler-actions > #plan {\n    transition: none;\n  }\n}\n.worker-actions > .playback-toggle {\n  border-radius: 24px;\n  min-height: 44px;\n  gap: 10px;\n}\n.playback-toggle svg,\n#start svg {\n  flex-shrink: 0;\n}\nbutton:not(#launcher) {\n  border: 0;\n  border-radius: var(--button-radius);\n}\n.icon-actions {\n  display: grid;\n  grid-template-columns: repeat(2, var(--icon-button-size));\n  justify-content: end;\n  gap: var(--action-gap);\n  margin-right: var(--action-shadow-gutter);\n}\nbutton:not(#launcher):not(.info-trigger) {\n  transition:\n    box-shadow 90ms ease-out,\n    background-color 160ms ease-out,\n    transform 80ms ease-out;\n}\n@media (prefers-reduced-motion: reduce) {\n  button:not(#launcher):not(.info-trigger) {\n    transition: none;\n  }\n}\n\n:is(.icon-button, .info-trigger, .icon-actions > button, #refresh-annual) {\n  display: inline-grid;\n  place-items: center;\n  width: var(--icon-button-size);\n  height: var(--icon-button-size);\n  min-width: var(--icon-button-size);\n  min-height: var(--icon-button-size);\n  padding: 0;\n  flex: 0 0 var(--icon-button-size);\n}\n:is(.icon-button, .info-trigger, .icon-actions > button, #refresh-annual) > svg,\n:is(.icon-button, .info-trigger, .icon-actions > button, #refresh-annual) .action-icon > svg {\n  display: block;\n  width: var(--icon-size);\n  height: var(--icon-size);\n}\n\n/* A single centered flex cell for every circular control, including SVG wrappers. */\n:is(.icon-button, .info-trigger, .icon-actions > button, #refresh-annual) {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  flex-direction: row;\n  gap: 0;\n  padding: 0;\n  line-height: 0;\n}\n.icon-actions > button .action-icon {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: var(--icon-size);\n  height: var(--icon-size);\n  margin: 0;\n  padding: 0;\n  line-height: 0;\n}\n:is(.icon-button, .info-trigger, .icon-actions > button, #refresh-annual) svg {\n  flex: 0 0 var(--icon-size);\n  margin: 0;\n  vertical-align: middle;\n}\n\n:is(.icon-button, .icon-actions > button, #refresh-annual) > svg,\n.icon-actions > button .action-icon > svg {\n  transform: translate(0.5px, 0.5px);\n}\n";

  // src/ui/help.css
  var help_default =
    "/* Inline help and popup positioning. */\n.annual .section-title .help {\n  left: 0;\n  right: auto;\n}\n\n.info-wrap {\n  position: relative;\n  display: inline-flex;\n  flex: none;\n}\n.info-trigger {\n  width: 24px;\n  border-radius: 5px;\n  color: #717171;\n}\n.info-trigger:hover {\n  background: #f3f3f3;\n}\n.info-trigger {\n  display: grid;\n  place-items: center;\n  height: 24px;\n  min-width: 32px;\n  min-height: 32px;\n}\n.help {\n  background: #ffffff;\n  color: #5a5a5a;\n  padding: 12px;\n  border: 1px solid #e6e6e6;\n  border-radius: 9px;\n  box-shadow: 0 8px 28px #3737371a;\n  white-space: pre-wrap;\n  overflow: auto;\n\n  font-size: var(--font-meta);\n\n  position: absolute;\n  right: 0;\n  top: calc(100% + 5px);\n  width: 230px;\n  max-width: calc(100vw - 64px);\n  z-index: 2;\n  max-height: 45vh;\n  line-height: 1.5;\n}\nbutton.info-trigger,\nbutton.info-trigger:hover {\n  border: 0;\n  border-radius: 0;\n  background: transparent;\n  box-shadow: none;\n}\n";

  // src/ui/switch.css
  var switch_default =
    '/* Shared switch geometry and state: off is recessed; on is raised.\n   Skins only override the surface/highlight/lowlight variables. */\ninput[type="checkbox"] {\n  appearance: none;\n  -webkit-appearance: none;\n  display: inline-block;\n  position: relative;\n  width: 44px;\n  min-width: 44px;\n  height: 26px;\n  margin: 0;\n  vertical-align: middle;\n  cursor: pointer;\n  border: 0;\n  border-radius: 20px;\n  --switch-surface: #e2e2e2;\n  --switch-lowlight: color-mix(in srgb, var(--switch-surface) 70%, black);\n  --switch-highlight: color-mix(in srgb, var(--switch-surface) 65%, white);\n  --switch-recessed:\n    inset 2px 2px 3px var(--switch-lowlight), inset -2px -2px 3px var(--switch-highlight);\n  --switch-raised:\n    inset 1px 1px 0 var(--switch-highlight), inset -1px -1px 0 var(--switch-lowlight),\n    2px 3px 4px -1px rgb(0 0 0 / 24%);\n  background: var(--switch-surface);\n  box-shadow: var(--switch-recessed);\n  transition:\n    background-color 150ms ease-out,\n    box-shadow 150ms ease-out;\n}\ninput[type="checkbox"]::before {\n  content: "";\n  display: block;\n  position: absolute;\n  width: 20px;\n  height: 20px;\n  left: 3px;\n  top: 3px;\n  background: #ffffff;\n  border-radius: 50%;\n  box-shadow:\n    -1px -1px 2px rgb(255 255 255 / 70%),\n    2px 2px 4px rgb(0 0 0 / 18%);\n  transition: transform 150ms;\n}\ninput[type="checkbox"]:checked {\n  --switch-surface: #606060;\n  box-shadow: var(--switch-raised);\n}\ninput[type="checkbox"]:checked::before {\n  transform: translateX(18px);\n}\n@media (prefers-reduced-motion: reduce) {\n  input[type="checkbox"],\n  input[type="checkbox"]::before {\n    transition: none;\n  }\n}\n@media (forced-colors: active) {\n  input[type="checkbox"] {\n    appearance: auto;\n    -webkit-appearance: auto;\n    background: Canvas;\n    width: auto;\n    height: auto;\n  }\n  input[type="checkbox"]::before {\n    display: none;\n  }\n}\n';

  // src/ui/appearance.css
  var appearance_default =
    '/* Appearance tokens map palette roles to components in one place. */\n:host([data-neumorphic="true"]) {\n  --surface: var(--theme-surface, #f2ebf7);\n  --section-surface: var(--theme-card, #fdf7ff);\n  --section-shadow: var(--theme-shadow, #d0cad5);\n  --panel-shadow:\n    inset 1px 1px 0 color-mix(in srgb, var(--surface) 55%, white), 0 6px 18px rgb(0 0 0 / 12%),\n    0 20px 44px -12px rgb(0 0 0 / 28%);\n  --action-primary-hover: var(--theme-primary-hover);\n  --accent-ink: var(--theme-on-primary-container);\n  --accent-surface: var(--theme-primary-container);\n  --action-ink: var(--theme-on-secondary-container);\n  --action-surface: var(--theme-secondary-container);\n  --text-muted: var(--theme-on-surface-variant);\n  --text-main: var(--theme-on-surface);\n  --action-primary-ink: var(--theme-on-primary);\n  --action-primary: var(--theme-primary);\n  --field-line: var(--theme-outline);\n  --select-surface: var(--action-surface);\n  --select-shadow: var(--card-shadow);\n  --select-ink: var(--action-ink);\n  --select-hover: var(--section-surface);\n  --select-hover-ink: var(--text-main);\n  --select-selected: var(--action-primary);\n  --select-selected-ink: var(--action-primary-ink);\n  --select-focus: var(--action-primary);\n  --primary-surface: var(--action-primary);\n  --primary-surface-hover: var(--action-primary-hover);\n  --primary-ink: var(--action-primary-ink);\n}\n:host([data-neumorphic="true"]) #panel {\n  border-color: transparent;\n}\n:host([data-neumorphic="true"]) .body {\n  gap: 20px;\n  padding: 6px 4px 12px;\n}\n:host([data-neumorphic="true"])\n  .body\n  > :is(\n    #controls,\n    .status-section,\n    .annual,\n    .preferences,\n    #dashboard:not(:empty),\n    #preview:not(:empty),\n    .log-section\n  ) {\n  min-width: 0;\n  padding: var(--card-padding);\n}\n:host([data-neumorphic="true"]) #controls:empty {\n  display: none;\n}\n@media (max-width: 380px) {\n  :host([data-neumorphic="true"])\n    .body\n    > :is(\n      #controls,\n      .status-section,\n      .annual,\n      .preferences,\n      #dashboard:not(:empty),\n      #preview:not(:empty),\n      .log-section\n    ) {\n    padding: 12px;\n  }\n}\n\n/* Current course uses the same raised shell and Material palette as other cards. */\n:host([data-neumorphic="true"])\n  #panel.player-panel\n  .body\n  > .status-section:has(#progress:not([hidden]):not(:empty)) {\n  --card-background: var(--accent-surface);\n}\n:host([data-neumorphic="true"])\n  #panel.player-panel.is-paused\n  .body\n  > .status-section:has(#progress:not([hidden]):not(:empty)) {\n  --card-background: var(--section-surface);\n}\n:host([data-neumorphic="true"]) #panel.player-panel #progress:not(:empty) {\n  background: transparent;\n  color: var(--accent-ink);\n  padding: 0;\n}\n:host([data-neumorphic="true"]) #panel.player-panel.is-paused #progress:not(:empty) {\n  color: var(--text-muted);\n}\n\n/* Google-generated color roles apply only to the optional appearance. */\n:host([data-neumorphic="true"]) {\n  --button-surface: var(--action-surface);\n  --button-surface-hover: color-mix(in srgb, var(--action-surface) 92%, var(--action-primary));\n  --button-surface-pressed: var(--action-surface);\n  color: var(--text-main);\n}\n:host([data-neumorphic="true"]) button:not(.primary):not(.info-trigger) {\n  color: var(--action-ink);\n}\n:host([data-neumorphic="true"]) button.info-trigger,\n:host([data-neumorphic="true"])\n  :is(\n    .section-title,\n    .list-title b,\n    .preference-label,\n    .preference-label label,\n    .course-meta,\n    .course-title,\n    .course-facts,\n    .ordinal,\n    .score,\n    .official-meta,\n    .official-meta b,\n    .annual-grid small,\n    .annual-grid > div > span,\n    .stat span,\n    .stat small,\n    .suffix,\n    summary,\n    .course-progress-head,\n    #refresh-countdown,\n    .auth-entry-label:not(.warning):not(.error),\n    .auth-entry-time,\n    .auth-entry-meta,\n    .auth-entry-level:not(.warning):not(.error)\n  ) {\n  color: var(--text-muted);\n}\n:host([data-neumorphic="true"]) input:not([type="checkbox"]),\n:host([data-neumorphic="true"]) select {\n  border-bottom-color: var(--field-line);\n}\n:host([data-neumorphic="true"]) input:not([type="checkbox"]):focus,\n:host([data-neumorphic="true"]) select:focus,\n:host([data-neumorphic="true"]) .select-wrap:focus-within select {\n  border-bottom-color: var(--action-primary);\n  box-shadow: 0 1px 0 var(--action-primary);\n}\n:host([data-neumorphic="true"]) :is(button, input, select, summary):focus-visible {\n  outline-color: var(--action-primary);\n}\n:host([data-neumorphic="true"]) input[type="checkbox"]:checked {\n  --switch-surface: var(--action-primary);\n  background: var(--action-primary);\n}\n:host([data-neumorphic="true"]) .progress-fill {\n  background: var(--action-primary);\n}\n:host([data-neumorphic="true"]) .progress-track {\n  background: var(--action-surface);\n}\n\n/* Cards and buttons share the same narrow bevel and short directional shadow. */\n:host([data-neumorphic="true"]) {\n  --relief-raised:\n    inset 1px 1px 0 rgb(255 255 255 / 85%),\n    inset -1px -1px 0 color-mix(in srgb, var(--section-shadow) 85%, transparent),\n    -1px -1px 2px rgb(255 255 255 / 75%), 3px 3px 3px -1px var(--section-shadow);\n  --relief-hover:\n    inset 1px 1px 0 rgb(255 255 255 / 90%), inset -1px -1px 0 var(--section-shadow),\n    -1px -1px 2px rgb(255 255 255 / 80%), 4px 4px 4px -1px var(--section-shadow);\n  --relief-pressed:\n    inset 2px 2px 3px var(--section-shadow), inset -1px -1px 2px rgb(255 255 255 / 90%),\n    0 0 0 0 transparent, 0 0 0 0 transparent;\n  --button-shadow: var(--relief-raised);\n  --button-shadow-hover: var(--relief-hover);\n  --button-shadow-pressed: var(--relief-pressed);\n  --primary-shadow: var(--relief-raised);\n  --primary-shadow-hover: var(--relief-hover);\n  --primary-shadow-pressed: var(--relief-pressed);\n}\n/* Explicit properties avoid animating menu motion or dynamic list contents. */\n#panel,\n#panel > header {\n  transition:\n    background-color 280ms cubic-bezier(0.2, 0.8, 0.2, 1),\n    border-color 280ms ease-out;\n}\n.body {\n  transition:\n    gap 280ms cubic-bezier(0.2, 0.8, 0.2, 1),\n    padding 280ms cubic-bezier(0.2, 0.8, 0.2, 1);\n}\n.body > :is(#controls, .status-section, .annual, .preferences, #dashboard, #preview, .log-section) {\n  transition:\n    padding 280ms cubic-bezier(0.2, 0.8, 0.2, 1),\n    border-radius 280ms cubic-bezier(0.2, 0.8, 0.2, 1),\n    background-color 280ms ease-out,\n    box-shadow 90ms ease-out;\n}\n@media (prefers-reduced-motion: reduce) {\n  #panel,\n  #panel > header,\n  .body,\n  .body\n    > :is(#controls, .status-section, .annual, .preferences, #dashboard, #preview, .log-section) {\n    transition: none;\n  }\n}\n\n/* Help disclosures follow the active theme rather than a fixed white surface. */\n:host([data-neumorphic="true"]) .help {\n  background: var(--action-surface);\n  color: var(--action-ink);\n  border: 0;\n  border-radius: 12px;\n  box-shadow: var(--relief-raised);\n}\n\n/* The floating launcher belongs to the same Material surface family. */\n#launcher {\n  transition:\n    background-color 280ms ease-out,\n    color 280ms ease-out,\n    box-shadow 90ms ease-out;\n}\n:host([data-neumorphic="true"]) #launcher {\n  background: var(--action-surface);\n  color: var(--action-ink);\n  box-shadow: var(--relief-raised);\n}\n:host([data-neumorphic="true"]) #launcher:hover {\n  box-shadow: var(--relief-hover);\n}\n:host([data-neumorphic="true"]) #launcher:active {\n  box-shadow: var(--relief-pressed);\n}\n@media (prefers-reduced-motion: reduce) {\n  #launcher {\n    transition: none;\n  }\n}\n\n/* Current course text follows the accent surface contract. */\n:host([data-neumorphic="true"])\n  .course.current:not(.paused)\n  :is(.course-title, .course-meta, .course-facts, .ordinal, .score, .course-current-badge) {\n  color: var(--accent-ink);\n}\n:host([data-neumorphic="true"]) .course.current.paused .course-current-badge {\n  color: var(--text-muted);\n}\n\n/* Resolve pressed shading on each material, not on the pale host surface. */\n:host([data-neumorphic="true"]) :is(button:not(.info-trigger), .surface-card) {\n  --relief-material: var(--action-surface);\n  --relief-pressed:\n    inset 2px 2px 3px color-mix(in srgb, var(--relief-material) 70%, black),\n    inset -2px -2px 3px color-mix(in srgb, var(--relief-material) 75%, white), 0 0 0 0 transparent,\n    0 0 0 0 transparent;\n  --button-shadow-pressed: var(--relief-pressed);\n  --primary-shadow-pressed: var(--relief-pressed);\n}\n:host([data-neumorphic="true"]) button.primary {\n  --relief-material: var(--action-primary);\n}\n:host([data-neumorphic="true"]) button.primary:not(:disabled):hover {\n  --relief-material: var(--action-primary-hover);\n}\n';

  // src/ui/surface-card.css
  var surface_card_default =
    '/* Large and compact cards share bevels, with size-appropriate outer shadows. */\n/* Shared shape, palette and press feedback. Business controls remain independent. */\n:host([data-neumorphic="true"]) #panel .surface-card {\n  min-width: 0;\n  border: 0;\n  border-radius: var(--card-radius);\n  background: var(--card-background, var(--section-surface));\n  --relief-material: var(--card-background, var(--section-surface));\n  box-shadow: var(--card-shadow, var(--relief-raised));\n  transition:\n    padding 280ms cubic-bezier(0.2, 0.8, 0.2, 1),\n    border-radius 280ms cubic-bezier(0.2, 0.8, 0.2, 1),\n    background-color 280ms ease-out,\n    box-shadow 90ms ease-out;\n}\n:host([data-neumorphic="true"]) #panel .surface-card[data-card-tone="accent"] {\n  --card-background: var(--accent-surface);\n}\n:host([data-neumorphic="true"]) #panel .surface-card[data-card-size="compact"] {\n  --card-shadow: var(--relief-raised);\n  border-radius: var(--compact-card-radius);\n  padding: 12px;\n  margin: 4px 4px 8px;\n}\n:host([data-neumorphic="true"]) #panel .surface-card.is-surface-pressed {\n  box-shadow: var(--relief-pressed);\n}\n@media (prefers-reduced-motion: reduce) {\n  :host([data-neumorphic="true"]) #panel .surface-card {\n    transition: none;\n  }\n}\n\n/* Depress the contents with the surface while the outer silhouette stays fixed. */\n:host([data-neumorphic="true"]) #panel .surface-card > * {\n  translate: 0 0;\n  transition: translate 80ms cubic-bezier(0.2, 0.8, 0.2, 1);\n}\n:host([data-neumorphic="true"]) #panel .surface-card.is-surface-pressed > * {\n  translate: 0 var(--card-content-offset, 1.5px);\n}\n@media (prefers-reduced-motion: reduce) {\n  :host([data-neumorphic="true"]) #panel .surface-card > * {\n    transition: none;\n  }\n}\n\n/* Normal-mode current course: inset actions, with room for their lower shadow. */\n:host(:not([data-neumorphic="true"])) #panel .course.current {\n  border-radius: var(--compact-card-radius);\n  padding: 12px;\n  margin: 4px 4px 12px;\n  gap: 10px;\n}\n:host(:not([data-neumorphic="true"])) #panel .course.current .row-actions {\n  margin-bottom: 8px;\n}\n';

  // src/ui/select.css
  var select_default =
    '/* One native-select enhancement for every dropdown; unsupported browsers stay native. */\n:host {\n  --select-surface: #f0f0f0;\n  --select-shadow: 0 2px 4px rgb(0 0 0 / 16%), 6px 10px 18px -5px rgb(0 0 0 / 30%);\n  --select-ink: #2f2f2f;\n  --select-hover: #ededed;\n  --select-hover-ink: #171717;\n  --select-selected: #373737;\n  --select-selected-ink: #fff;\n  --select-focus: #373737;\n}\n@supports (appearance: base-select) {\n  .select-wrap select,\n  .select-wrap select::picker(select) {\n    appearance: base-select;\n  }\n  .select-wrap select::picker-icon {\n    display: none;\n  }\n  .select-wrap select::picker(select) {\n    border: 0;\n    border-radius: 16px;\n    padding: 6px;\n    margin-top: 8px;\n    background: var(--select-surface);\n    color: var(--select-ink);\n    box-shadow: var(--select-shadow);\n    font: inherit;\n  }\n  .select-wrap option {\n    display: flex;\n    align-items: center;\n    gap: 10px;\n    min-height: 40px;\n    padding: 10px 12px;\n    border-radius: 12px;\n    cursor: pointer;\n    background: var(--select-surface);\n    color: var(--select-ink);\n  }\n  .select-wrap option:hover:not(:checked),\n  .select-wrap option:focus:not(:checked) {\n    background: var(--select-hover);\n    color: var(--select-hover-ink);\n  }\n  .select-wrap option:checked {\n    background: var(--select-selected);\n    color: var(--select-selected-ink);\n    font-weight: 600;\n  }\n  .select-wrap option::checkmark {\n    color: currentColor;\n    opacity: 1;\n  }\n  .select-wrap option:focus-visible {\n    outline: 2px solid var(--select-focus);\n    outline-offset: -3px;\n  }\n  .select-wrap option:checked:focus-visible {\n    outline-color: var(--select-selected-ink);\n  }\n}\n@media (forced-colors: active) {\n  .select-wrap select::picker(select) {\n    outline: 1px solid CanvasText;\n  }\n  :host,\n  :host([data-neumorphic="true"]) {\n    --select-surface: Canvas;\n    --select-shadow: none;\n    --select-ink: CanvasText;\n    --select-hover: Canvas;\n    --select-hover-ink: CanvasText;\n    --select-selected: Highlight;\n    --select-selected-ink: HighlightText;\n    --select-focus: CanvasText;\n  }\n}\n';

  // src/ui/action-buttons.css
  var action_buttons_default =
    "/* Current-course and playback-page actions share the same two-column component. */\n#panel .pill-actions {\n  display: grid;\n  grid-template-columns: repeat(2, minmax(0, 1fr));\n  width: 100%;\n  min-width: 0;\n  gap: 12px;\n  padding: 0;\n  margin-right: 0;\n}\n#panel .pill-actions > button {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  flex-direction: row;\n  gap: 0;\n  width: 100%;\n  min-width: 0;\n  height: 42px;\n  min-height: 42px;\n  flex-basis: auto;\n  padding: 9px 12px;\n  border-radius: var(--button-radius);\n  line-height: 1;\n}\n#panel .pill-actions > button svg,\n#panel .pill-actions > button .action-icon {\n  width: var(--icon-size);\n  height: var(--icon-size);\n  flex: 0 0 var(--icon-size);\n}\n#panel .pill-actions > button .action-icon {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n}\n";

  // src/ui/header.css
  var header_default =
    "/* Sticky glass header follows the active surface; opaque fallback stays readable. */\n#panel > header {\n  background: var(--surface);\n}\n@supports (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)) {\n  #panel > header {\n    background: color-mix(in srgb, var(--surface) 82%, transparent);\n    -webkit-backdrop-filter: blur(14px) saturate(115%);\n    backdrop-filter: blur(14px) saturate(115%);\n  }\n}\n@media (prefers-reduced-transparency: reduce), (forced-colors: active) {\n  #panel > header {\n    background: var(--surface);\n    -webkit-backdrop-filter: none;\n    backdrop-filter: none;\n  }\n}\n";

  // src/ui/button-states.css
  var button_states_default =
    "/* All action tones share one state order: rest, hover, then pressed. */\n:host {\n  --primary-surface: #373737;\n  --primary-surface-hover: #4d4d4d;\n  --primary-ink: #fff;\n}\n#panel button.primary {\n  background: var(--primary-surface);\n  color: var(--primary-ink);\n  box-shadow: var(--primary-shadow);\n}\n#panel button.primary:not(:disabled):hover {\n  background: var(--primary-surface-hover);\n  box-shadow: var(--primary-shadow-hover);\n}\n#panel button:not(.primary):not(.info-trigger) {\n  background: var(--button-surface);\n  box-shadow: var(--button-shadow);\n}\n#panel button:not(.primary):not(.info-trigger):not(:disabled):hover {\n  background: var(--button-surface-hover);\n  box-shadow: var(--button-shadow-hover);\n}\n#panel button:not(.primary):not(.info-trigger):not(:disabled):active {\n  background: var(--button-surface-pressed);\n  box-shadow: var(--button-shadow-pressed);\n  transform: translateY(1px);\n}\n#panel button.primary:not(:disabled):active {\n  box-shadow: var(--primary-shadow-pressed);\n  transform: translateY(1px);\n}\n@media (prefers-reduced-motion: reduce) {\n  #panel button:not(:disabled):active {\n    transform: none;\n  }\n}\n";

  // src/ui/elevation.css
  var elevation_default =
    '/* One depth scale: small tools < regular controls < primary actions < large sections. */\n:host([data-neumorphic="true"]) {\n  --elevation-small:\n    inset 1px 1px 0 rgb(255 255 255 / 75%),\n    inset -1px -1px 0 color-mix(in srgb, var(--section-shadow) 65%, transparent),\n    2px 3px 4px -2px var(--section-shadow);\n  --elevation-control:\n    inset 1px 1px 0 rgb(255 255 255 / 85%),\n    inset -1px -1px 0 color-mix(in srgb, var(--section-shadow) 75%, transparent),\n    -1px -1px 2px rgb(255 255 255 / 70%), 3px 4px 6px -2px var(--section-shadow);\n  --elevation-primary:\n    inset 1px 1px 0 rgb(255 255 255 / 90%), inset -1px -1px 0 var(--section-shadow),\n    -2px -2px 3px rgb(255 255 255 / 75%), 5px 7px 10px -3px var(--section-shadow);\n  --elevation-section:\n    inset 1px 1px 0 rgb(255 255 255 / 85%),\n    inset -1px -1px 0 color-mix(in srgb, var(--section-shadow) 85%, transparent),\n    -3px -3px 6px rgb(255 255 255 / 70%), 8px 10px 16px -5px var(--section-shadow);\n  --relief-raised: var(--elevation-control);\n  --button-shadow: var(--elevation-control);\n  --primary-shadow: var(--elevation-primary);\n  --primary-shadow-hover: var(--elevation-section);\n  --card-shadow: var(--elevation-section);\n}\n:host([data-neumorphic="true"]) :is(.icon-button, .icon-actions > button, #refresh-annual) {\n  --button-shadow: var(--elevation-small);\n  --button-shadow-hover: var(--elevation-control);\n}\n:host([data-neumorphic="true"])\n  #panel\n  .surface-card[data-card-importance="high"][data-card-size="compact"] {\n  --card-shadow: var(--elevation-primary);\n}\n:host([data-neumorphic="true"]) #panel .surface-card:not([data-card-size="compact"]) {\n  --card-content-offset: 2px;\n}\n';

  // src/ui/pure-neumorphism.css
  var pure_neumorphism_default =
    '/* Experimental same-material skin. A single surface overrides semantic roles. */\n:host([data-pure-neumorphic="true"]) {\n  --section-surface: var(--surface);\n  --accent-surface: var(--surface);\n  --accent-ink: var(--text-main);\n  --action-surface: var(--surface);\n  --action-ink: var(--text-main);\n  --action-primary: var(--text-main);\n  --action-primary-hover: var(--text-main);\n  --primary-surface: var(--surface);\n  --primary-surface-hover: var(--surface);\n  --primary-ink: var(--text-main);\n  --button-surface: var(--surface);\n  --button-surface-hover: var(--surface);\n  --button-surface-pressed: var(--surface);\n  --select-surface: var(--surface);\n  --select-ink: var(--text-main);\n  --select-hover: var(--surface);\n  --select-hover-ink: var(--text-main);\n  --select-selected: var(--surface);\n  --select-selected-ink: var(--text-main);\n  --select-focus: var(--text-main);\n}\n:host([data-pure-neumorphic="true"]) #panel button,\n:host([data-pure-neumorphic="true"]) #panel button.primary:not(:disabled):hover,\n:host([data-pure-neumorphic="true"]) #panel .surface-card {\n  --relief-material: var(--surface);\n}\n:host([data-pure-neumorphic="true"]) #panel input[type="checkbox"],\n:host([data-pure-neumorphic="true"]) #panel input[type="checkbox"]:checked {\n  --switch-surface: var(--surface);\n  --switch-lowlight: var(--section-shadow);\n  --switch-highlight: rgb(255 255 255 / 85%);\n  background: var(--surface);\n}\n:host([data-pure-neumorphic="true"]) #panel input[type="checkbox"]::before {\n  background: var(--surface);\n  box-shadow:\n    -1px -1px 2px rgb(255 255 255 / 85%),\n    2px 2px 3px var(--section-shadow);\n}\n:host([data-pure-neumorphic="true"]) #panel input:not([type="checkbox"]):not([type="color"]),\n:host([data-pure-neumorphic="true"]) #panel select {\n  --relief-material: var(--surface);\n  border: 0;\n  border-radius: 10px;\n  padding-inline: 10px;\n  background: var(--surface);\n  box-shadow:\n    inset 2px 2px 3px var(--section-shadow),\n    inset -2px -2px 3px rgb(255 255 255 / 85%);\n}\n:host([data-pure-neumorphic="true"]) #panel .target-wrap input {\n  padding-right: 64px;\n}\n:host([data-pure-neumorphic="true"]) #panel .select-wrap select {\n  padding-right: 32px;\n}\n:host([data-pure-neumorphic="true"]) #panel > header {\n  background: var(--surface);\n  -webkit-backdrop-filter: none;\n  backdrop-filter: none;\n}\n:host([data-pure-neumorphic="true"]) #panel input::placeholder {\n  color: var(--text-muted);\n  opacity: 1;\n}\n:host([data-pure-neumorphic="true"]) #panel :is(button, input, select, summary):focus-visible,\n:host([data-pure-neumorphic="true"]) #launcher:focus-visible {\n  outline: 2px solid var(--text-main);\n  outline-offset: 3px;\n}\n@supports (appearance: base-select) {\n  :host([data-pure-neumorphic="true"]) .select-wrap option:hover:not(:checked) {\n    box-shadow: var(--relief-raised);\n  }\n  :host([data-pure-neumorphic="true"]) .select-wrap option:checked {\n    box-shadow: var(--relief-pressed);\n  }\n}\n\n@media (forced-colors: active) {\n  :host([data-pure-neumorphic="true"]) {\n    --surface: Canvas;\n    --text-main: CanvasText;\n    --field-line: CanvasText;\n    --action-primary: Highlight;\n    --action-primary-ink: HighlightText;\n    --select-surface: Canvas;\n    --select-ink: CanvasText;\n    --select-selected: Highlight;\n    --select-selected-ink: HighlightText;\n    --select-focus: CanvasText;\n  }\n}\n';

  // src/ui/typography.css
  var typography_default =
    "/* Shared type hierarchy for panel title, section headings and control labels. */\n#panel h2 {\n  font-size: var(--font-panel);\n  font-weight: 700;\n}\n#panel :is(.section-title, .list-title b) {\n  font-size: var(--font-heading);\n  font-weight: 650;\n}\n#panel :is(.field, .check, .preference-label label, .preference-row > label, .record-row, summary) {\n  font-size: var(--font-body);\n  line-height: 1.5;\n}\n";

  // src/ui/settings-layout.css
  var settings_layout_default =
    '/* A shared right-hand column aligns numeric values, selectors and the HEX field. */\n:host {\n  --settings-value-width: 116px;\n}\n#panel .preference-row {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) auto;\n  align-items: center;\n  column-gap: 12px;\n  min-height: 40px;\n}\n#panel .preference-row > input[type="checkbox"] {\n  justify-self: end;\n}\n#panel .preference-label {\n  min-width: 0;\n  display: flex;\n  align-items: center;\n  gap: 8px;\n}\n#panel .preference-label label {\n  min-width: 0;\n}\n#panel .preference-label .info-wrap {\n  flex: none;\n}\n#panel .field {\n  grid-template-columns: minmax(0, 1fr) var(--settings-value-width);\n  gap: 12px;\n}\n#panel .field.time {\n  grid-template-columns: minmax(0, 1fr);\n}\n#panel .field input {\n  width: 100%;\n  font-size: var(--font-body);\n  font-weight: 400;\n}\n#panel .appearance-picker {\n  width: var(--settings-value-width);\n}\n#panel .custom-color-row {\n  display: grid;\n  align-items: center;\n  margin-top: 8px;\n  grid-template-columns: minmax(0, 1fr) 44px var(--settings-value-width);\n  gap: 10px;\n}\n#panel #appearance-seed-hex {\n  font-size: var(--font-body);\n  font-weight: 400;\n}\n#panel .record-row {\n  gap: 12px;\n  padding: 10px 0;\n}\n#panel .record-row button {\n  flex: 0 0 64px;\n  width: 64px;\n  min-width: 64px;\n  height: 36px;\n  min-height: 36px;\n  padding: 8px 12px;\n  border-radius: 18px;\n  font-size: var(--font-body);\n  line-height: 1;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n}\n\n/* The seed picker stays native and accessible; the generated theme owns its surface. */\n#panel #appearance-seed-color {\n  appearance: auto;\n  width: 44px;\n  height: 38px;\n  min-height: 38px;\n  padding: 3px;\n  border: 0;\n  border-radius: 10px;\n  background: var(--action-surface);\n  box-shadow: var(--relief-raised);\n  cursor: pointer;\n}\n#appearance-seed-color::-webkit-color-swatch-wrapper {\n  padding: 2px;\n}\n#appearance-seed-color::-webkit-color-swatch {\n  border: 0;\n  border-radius: 6px;\n}\n#appearance-seed-color::-moz-color-swatch {\n  border: 0;\n  border-radius: 6px;\n}\n#appearance-seed-hex {\n  width: 100%;\n  font-variant-numeric: tabular-nums;\n}\n#appearance-seed-error {\n  margin-top: 6px;\n  font-size: var(--font-body);\n}\n#appearance-seed-error:empty {\n  display: none;\n}\n\n#panel #appearance-seed-color:focus-visible {\n  outline: 2px solid var(--action-primary);\n  outline-offset: 3px;\n}\n';

  // src/ui/disclosure.css
  var disclosure_default = `/* A fixed SVG marker avoids rotating a font glyph outside its line box. */
#panel :is(.plan-disclosure, .log-disclosure, .auth-entry) > summary::before {
  --log-chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='m6 9 6 6 6-6' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  content: "";
  display: block;
  flex: 0 0 16px;
  width: 16px;
  height: 16px;
  background: currentColor;
  -webkit-mask: var(--log-chevron) center / 16px 16px no-repeat;
  mask: var(--log-chevron) center / 16px 16px no-repeat;
  transform: rotate(-90deg);
  transform-origin: center;
}
#panel :is(.plan-disclosure, .log-disclosure, .auth-entry)[open] > summary::before {
  transform: rotate(0);
}
@media (forced-colors: active) {
  #panel :is(.plan-disclosure, .log-disclosure, .auth-entry) > summary::before {
    background: CanvasText;
  }
}

/* Section accordions share a closed header height and an open content gap. */
#panel :is(.plan-disclosure, .log-disclosure) > summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  margin: 0;
}
#panel :is(.plan-disclosure, .log-disclosure)[open] > summary {
  margin-bottom: 8px;
}
#panel .plan-disclosure > summary > b {
  flex: 1;
}
`;

  // src/ui/log.css
  var log_default =
    "/* Log base layout; compact accordion overrides follow. */\n.log-section {\n  overflow: auto;\n  scrollbar-gutter: stable;\n  scrollbar-width: thin;\n  border-top: 1px solid #ebebeb;\n  padding-top: 12px;\n}\n.log-limit {\n  font-size: var(--font-body);\n  color: #717171;\n  font-weight: 400;\n  margin-left: 3px;\n}\n.log-tools button {\n  color: #717171;\n  border-radius: 5px;\n}\n.log-tools button:hover {\n  background: #f3f3f3;\n  color: #515151;\n}\n#log-result:empty {\n  display: none;\n}\n.log-tools button {\n  display: grid;\n  place-items: center;\n  width: 25px;\n  height: 25px;\n  min-width: 32px;\n  min-height: 32px;\n}\n.auth-entry-meta,\n.auth-entry-time {\n  color: #595959;\n}\n.auth-entry-label,\n.auth-entry-time,\n.auth-entry-meta {\n  font-size: var(--font-meta);\n}\n#log-result {\n  color: #595959;\n  margin-top: 5px;\n  font-size: var(--font-meta);\n}\n#event-log {\n  font-size: var(--font-meta);\n  display: grid;\n  overflow: auto;\n  scrollbar-width: thin;\n  margin-top: 0;\n  color: #858585;\n  line-height: 1.5;\n  max-height: 180px;\n  gap: 8px;\n}\n.auth-entry-meta {\n  line-height: 1.5;\n}\n\n/* Compact accordion headlines; full payloads are available only when expanded. */\n#panel .log-disclosure > summary .section-title {\n  flex: 1;\n}\n#panel .log-disclosure > summary .log-tools {\n  flex: none;\n}\n#panel #event-log {\n  display: grid;\n  gap: 0;\n  max-height: 280px;\n  margin-top: 0;\n}\n#panel .auth-entry {\n  display: block;\n  min-width: 0;\n  margin: 0;\n  border-bottom: 1px solid rgb(100 100 100 / 15%);\n}\n#panel .auth-entry:last-child {\n  border-bottom: 0;\n}\n#panel .auth-entry-head {\n  display: grid;\n  grid-template-columns: 16px minmax(0, 1fr) auto;\n  align-items: center;\n  gap: 8px;\n  padding: 8px 0;\n  min-height: 44px;\n}\n#panel .auth-entry-head::before {\n  grid-column: 1;\n  grid-row: 1;\n}\n#panel .auth-entry-label {\n  grid-column: 2;\n  grid-row: 1;\n  color: var(--text-main, #333);\n  font-size: var(--font-body);\n  font-weight: 500;\n  line-height: 1.4;\n}\n#panel .auth-entry-stamp {\n  grid-column: 3;\n  grid-row: 1;\n  display: flex;\n  flex-direction: column;\n  align-items: flex-end;\n  gap: 0;\n}\n#panel :is(.auth-entry-time, .auth-entry-level) {\n  color: #666;\n  font-variant-numeric: tabular-nums;\n  white-space: nowrap;\n  font-size: var(--font-meta);\n  font-weight: 400;\n  line-height: 1.4;\n}\n#panel .auth-entry-level {\n  text-transform: uppercase;\n  letter-spacing: 0.3px;\n}\n#panel .auth-entry-body {\n  padding: 0 0 10px 24px;\n}\n#panel .auth-entry-meta {\n  margin: 0;\n  color: var(--text-muted, #595959);\n  font-size: var(--font-meta);\n  line-height: 1.5;\n  white-space: pre-wrap;\n  overflow-wrap: anywhere;\n}\n#panel .auth-entry-debug {\n  margin: 8px 0 0;\n  font:\n    var(--font-meta)/1.5 ui-monospace,\n    monospace;\n  color: var(--text-muted, #595959);\n  white-space: pre-wrap;\n  overflow-wrap: anywhere;\n}\n";

  // src/ui/stylesheet.js
  var panelStyles = [
    tokens_default,
    styles_default,
    panel_shell_default,
    forms_default,
    settings_base_default,
    course_list_default,
    hours_default,
    status_default,
    button_layout_default,
    help_default,
    switch_default,
    appearance_default,
    surface_card_default,
    select_default,
    action_buttons_default,
    header_default,
    button_states_default,
    elevation_default,
    pure_neumorphism_default,
    typography_default,
    settings_layout_default,
    disclosure_default,
    log_default,
  ].join("\n");

  // src/ui/info.js
  function bindInfoDisclosures({ ui, $, lifecycle }) {
    let openedInfo = null;
    function closeInfo() {
      if (!openedInfo) return;
      openedInfo.content.hidden = true;
      openedInfo.button.setAttribute("aria-expanded", "false");
      openedInfo = null;
    }
    lifecycle.on(ui, "click", (event) => {
      const button = event.target.closest?.("[data-info]");
      if (!button) return;
      const content = $("#" + button.dataset.info),
        shouldOpen = content.hidden;
      closeInfo();
      if (shouldOpen) {
        content.hidden = false;
        content.style.transform = "";
        const panel = $("#panel");
        if (content.getBoundingClientRect && panel.getBoundingClientRect) {
          const rect = content.getBoundingClientRect(),
            bounds = panel.getBoundingClientRect(),
            pad = 8;
          const dx =
            rect.left < bounds.left + pad
              ? bounds.left + pad - rect.left
              : rect.right > bounds.right - pad
                ? bounds.right - pad - rect.right
                : 0;
          const dy =
            rect.bottom > bounds.bottom - pad
              ? Math.max(bounds.top + pad - rect.top, bounds.bottom - pad - rect.bottom)
              : 0;
          content.style.transform = `translate(${dx}px,${dy}px)`;
        }
        button.setAttribute("aria-expanded", "true");
        openedInfo = { button, content };
      }
    });
    return {
      close: closeInfo,
      get opened() {
        return openedInfo;
      },
    };
  }

  // src/ui/surface-card.js
  function decorateSurfaceCard(
    element,
    { tone = "surface", compact = false, importance = tone === "accent" ? "high" : "normal" } = {},
  ) {
    element.classList.add("surface-card");
    element.dataset.cardTone = tone;
    element.dataset.cardImportance = importance;
    if (compact) element.dataset.cardSize = "compact";
    else delete element.dataset.cardSize;
    return element;
  }
  function bindSurfaceCards({ host, root, lifecycle }) {
    const body = root.querySelector(".body");
    for (const element of body.children) decorateSurfaceCard(element);
    let pressed = null,
      pointerId = null,
      x = 0,
      y = 0,
      timer = null;
    const clear = () => {
      clearTimeout(timer);
      pressed?.classList.remove("is-surface-pressed");
      pressed = null;
      pointerId = null;
    };
    const down = (event) => {
      if (host.getAttribute("data-neumorphic") !== "true" || !event.isPrimary || event.button !== 0)
        return;
      if (
        event.target.closest(
          'button,input,select,textarea,a,label,summary,[role="button"],#event-log,.help',
        )
      )
        return;
      const card = event.target.closest(".surface-card");
      const list = event.target.closest(".course-list");
      if (!card || !body.contains(card) || (list && !list.contains(card))) return;
      clear();
      pressed = card;
      pointerId = event.pointerId;
      x = event.clientX;
      y = event.clientY;
      card.classList.add("is-surface-pressed");
    };
    const move = (event) => {
      if (
        pressed &&
        event.pointerId === pointerId &&
        Math.hypot(event.clientX - x, event.clientY - y) > 8
      )
        clear();
    };
    const up = (event) => {
      if (!pressed || event.pointerId !== pointerId) return;
      clearTimeout(timer);
      timer = setTimeout(clear, 40);
    };
    lifecycle.on(body, "pointerdown", down);
    lifecycle.on(body, "scroll", clear, true);
    lifecycle.on(window, "pointermove", move);
    lifecycle.on(window, "pointerup", up);
    lifecycle.on(window, "pointercancel", clear);
    lifecycle.on(window, "blur", clear);
    lifecycle.defer(clear);
  }

  // node_modules/@material/material-color-utilities/utils/math_utils.js
  /**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  function signum(num) {
    if (num < 0) {
      return -1;
    } else if (num === 0) {
      return 0;
    } else {
      return 1;
    }
  }
  function lerp(start, stop, amount) {
    return (1 - amount) * start + amount * stop;
  }
  function clampInt(min, max, input) {
    if (input < min) {
      return min;
    } else if (input > max) {
      return max;
    }
    return input;
  }
  function clampDouble(min, max, input) {
    if (input < min) {
      return min;
    } else if (input > max) {
      return max;
    }
    return input;
  }
  function sanitizeDegreesInt(degrees) {
    degrees = degrees % 360;
    if (degrees < 0) {
      degrees = degrees + 360;
    }
    return degrees;
  }
  function sanitizeDegreesDouble(degrees) {
    degrees = degrees % 360;
    if (degrees < 0) {
      degrees = degrees + 360;
    }
    return degrees;
  }
  function differenceDegrees(a, b) {
    return 180 - Math.abs(Math.abs(a - b) - 180);
  }
  function matrixMultiply(row, matrix) {
    const a = row[0] * matrix[0][0] + row[1] * matrix[0][1] + row[2] * matrix[0][2];
    const b = row[0] * matrix[1][0] + row[1] * matrix[1][1] + row[2] * matrix[1][2];
    const c = row[0] * matrix[2][0] + row[1] * matrix[2][1] + row[2] * matrix[2][2];
    return [a, b, c];
  }

  // node_modules/@material/material-color-utilities/utils/color_utils.js
  /**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  var SRGB_TO_XYZ = [
    [0.41233895, 0.35762064, 0.18051042],
    [0.2126, 0.7152, 0.0722],
    [0.01932141, 0.11916382, 0.95034478],
  ];
  var XYZ_TO_SRGB = [
    [3.2413774792388685, -1.5376652402851851, -0.49885366846268053],
    [-0.9691452513005321, 1.8758853451067872, 0.04156585616912061],
    [0.05562093689691305, -0.20395524564742123, 1.0571799111220335],
  ];
  var WHITE_POINT_D65 = [95.047, 100, 108.883];
  function argbFromRgb(red, green, blue) {
    return ((255 << 24) | ((red & 255) << 16) | ((green & 255) << 8) | (blue & 255)) >>> 0;
  }
  function argbFromLinrgb(linrgb) {
    const r = delinearized(linrgb[0]);
    const g = delinearized(linrgb[1]);
    const b = delinearized(linrgb[2]);
    return argbFromRgb(r, g, b);
  }
  function redFromArgb(argb) {
    return (argb >> 16) & 255;
  }
  function greenFromArgb(argb) {
    return (argb >> 8) & 255;
  }
  function blueFromArgb(argb) {
    return argb & 255;
  }
  function argbFromXyz(x, y, z) {
    const matrix = XYZ_TO_SRGB;
    const linearR = matrix[0][0] * x + matrix[0][1] * y + matrix[0][2] * z;
    const linearG = matrix[1][0] * x + matrix[1][1] * y + matrix[1][2] * z;
    const linearB = matrix[2][0] * x + matrix[2][1] * y + matrix[2][2] * z;
    const r = delinearized(linearR);
    const g = delinearized(linearG);
    const b = delinearized(linearB);
    return argbFromRgb(r, g, b);
  }
  function xyzFromArgb(argb) {
    const r = linearized(redFromArgb(argb));
    const g = linearized(greenFromArgb(argb));
    const b = linearized(blueFromArgb(argb));
    return matrixMultiply([r, g, b], SRGB_TO_XYZ);
  }
  function labFromArgb(argb) {
    const linearR = linearized(redFromArgb(argb));
    const linearG = linearized(greenFromArgb(argb));
    const linearB = linearized(blueFromArgb(argb));
    const matrix = SRGB_TO_XYZ;
    const x = matrix[0][0] * linearR + matrix[0][1] * linearG + matrix[0][2] * linearB;
    const y = matrix[1][0] * linearR + matrix[1][1] * linearG + matrix[1][2] * linearB;
    const z = matrix[2][0] * linearR + matrix[2][1] * linearG + matrix[2][2] * linearB;
    const whitePoint = WHITE_POINT_D65;
    const xNormalized = x / whitePoint[0];
    const yNormalized = y / whitePoint[1];
    const zNormalized = z / whitePoint[2];
    const fx = labF(xNormalized);
    const fy = labF(yNormalized);
    const fz = labF(zNormalized);
    const l = 116 * fy - 16;
    const a = 500 * (fx - fy);
    const b = 200 * (fy - fz);
    return [l, a, b];
  }
  function argbFromLstar(lstar) {
    const y = yFromLstar(lstar);
    const component = delinearized(y);
    return argbFromRgb(component, component, component);
  }
  function lstarFromArgb(argb) {
    const y = xyzFromArgb(argb)[1];
    return 116 * labF(y / 100) - 16;
  }
  function yFromLstar(lstar) {
    return 100 * labInvf((lstar + 16) / 116);
  }
  function lstarFromY(y) {
    return labF(y / 100) * 116 - 16;
  }
  function linearized(rgbComponent) {
    const normalized = rgbComponent / 255;
    if (normalized <= 0.040449936) {
      return (normalized / 12.92) * 100;
    } else {
      return Math.pow((normalized + 0.055) / 1.055, 2.4) * 100;
    }
  }
  function delinearized(rgbComponent) {
    const normalized = rgbComponent / 100;
    let delinearized2 = 0;
    if (normalized <= 31308e-7) {
      delinearized2 = normalized * 12.92;
    } else {
      delinearized2 = 1.055 * Math.pow(normalized, 1 / 2.4) - 0.055;
    }
    return clampInt(0, 255, Math.round(delinearized2 * 255));
  }
  function whitePointD65() {
    return WHITE_POINT_D65;
  }
  function labF(t) {
    const e = 216 / 24389;
    const kappa = 24389 / 27;
    if (t > e) {
      return Math.pow(t, 1 / 3);
    } else {
      return (kappa * t + 16) / 116;
    }
  }
  function labInvf(ft) {
    const e = 216 / 24389;
    const kappa = 24389 / 27;
    const ft3 = ft * ft * ft;
    if (ft3 > e) {
      return ft3;
    } else {
      return (116 * ft - 16) / kappa;
    }
  }

  // node_modules/@material/material-color-utilities/hct/viewing_conditions.js
  /**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  var ViewingConditions = class _ViewingConditions {
    /**
     * Create ViewingConditions from a simple, physically relevant, set of
     * parameters.
     *
     * @param whitePoint White point, measured in the XYZ color space.
     *     default = D65, or sunny day afternoon
     * @param adaptingLuminance The luminance of the adapting field. Informally,
     *     how bright it is in the room where the color is viewed. Can be
     *     calculated from lux by multiplying lux by 0.0586. default = 11.72,
     *     or 200 lux.
     * @param backgroundLstar The lightness of the area surrounding the color.
     *     measured by L* in L*a*b*. default = 50.0
     * @param surround A general description of the lighting surrounding the
     *     color. 0 is pitch dark, like watching a movie in a theater. 1.0 is a
     *     dimly light room, like watching TV at home at night. 2.0 means there
     *     is no difference between the lighting on the color and around it.
     *     default = 2.0
     * @param discountingIlluminant Whether the eye accounts for the tint of the
     *     ambient lighting, such as knowing an apple is still red in green light.
     *     default = false, the eye does not perform this process on
     *       self-luminous objects like displays.
     */
    static make(
      whitePoint = whitePointD65(),
      adaptingLuminance = ((200 / Math.PI) * yFromLstar(50)) / 100,
      backgroundLstar = 50,
      surround = 2,
      discountingIlluminant = false,
    ) {
      const xyz = whitePoint;
      const rW = xyz[0] * 0.401288 + xyz[1] * 0.650173 + xyz[2] * -0.051461;
      const gW = xyz[0] * -0.250268 + xyz[1] * 1.204414 + xyz[2] * 0.045854;
      const bW = xyz[0] * -2079e-6 + xyz[1] * 0.048952 + xyz[2] * 0.953127;
      const f = 0.8 + surround / 10;
      const c = f >= 0.9 ? lerp(0.59, 0.69, (f - 0.9) * 10) : lerp(0.525, 0.59, (f - 0.8) * 10);
      let d = discountingIlluminant
        ? 1
        : f * (1 - (1 / 3.6) * Math.exp((-adaptingLuminance - 42) / 92));
      d = d > 1 ? 1 : d < 0 ? 0 : d;
      const nc = f;
      const rgbD = [d * (100 / rW) + 1 - d, d * (100 / gW) + 1 - d, d * (100 / bW) + 1 - d];
      const k = 1 / (5 * adaptingLuminance + 1);
      const k4 = k * k * k * k;
      const k4F = 1 - k4;
      const fl = k4 * adaptingLuminance + 0.1 * k4F * k4F * Math.cbrt(5 * adaptingLuminance);
      const n = yFromLstar(backgroundLstar) / whitePoint[1];
      const z = 1.48 + Math.sqrt(n);
      const nbb = 0.725 / Math.pow(n, 0.2);
      const ncb = nbb;
      const rgbAFactors = [
        Math.pow((fl * rgbD[0] * rW) / 100, 0.42),
        Math.pow((fl * rgbD[1] * gW) / 100, 0.42),
        Math.pow((fl * rgbD[2] * bW) / 100, 0.42),
      ];
      const rgbA = [
        (400 * rgbAFactors[0]) / (rgbAFactors[0] + 27.13),
        (400 * rgbAFactors[1]) / (rgbAFactors[1] + 27.13),
        (400 * rgbAFactors[2]) / (rgbAFactors[2] + 27.13),
      ];
      const aw = (2 * rgbA[0] + rgbA[1] + 0.05 * rgbA[2]) * nbb;
      return new _ViewingConditions(n, aw, nbb, ncb, c, nc, rgbD, fl, Math.pow(fl, 0.25), z);
    }
    /**
     * Parameters are intermediate values of the CAM16 conversion process. Their
     * names are shorthand for technical color science terminology, this class
     * would not benefit from documenting them individually. A brief overview
     * is available in the CAM16 specification, and a complete overview requires
     * a color science textbook, such as Fairchild's Color Appearance Models.
     */
    constructor(n, aw, nbb, ncb, c, nc, rgbD, fl, fLRoot, z) {
      this.n = n;
      this.aw = aw;
      this.nbb = nbb;
      this.ncb = ncb;
      this.c = c;
      this.nc = nc;
      this.rgbD = rgbD;
      this.fl = fl;
      this.fLRoot = fLRoot;
      this.z = z;
    }
  };
  ViewingConditions.DEFAULT = ViewingConditions.make();

  // node_modules/@material/material-color-utilities/hct/cam16.js
  /**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  var Cam16 = class _Cam16 {
    /**
     * All of the CAM16 dimensions can be calculated from 3 of the dimensions, in
     * the following combinations:
     *      -  {j or q} and {c, m, or s} and hue
     *      - jstar, astar, bstar
     * Prefer using a static method that constructs from 3 of those dimensions.
     * This constructor is intended for those methods to use to return all
     * possible dimensions.
     *
     * @param hue
     * @param chroma informally, colorfulness / color intensity. like saturation
     *     in HSL, except perceptually accurate.
     * @param j lightness
     * @param q brightness; ratio of lightness to white point's lightness
     * @param m colorfulness
     * @param s saturation; ratio of chroma to white point's chroma
     * @param jstar CAM16-UCS J coordinate
     * @param astar CAM16-UCS a coordinate
     * @param bstar CAM16-UCS b coordinate
     */
    constructor(hue, chroma, j, q, m, s, jstar, astar, bstar) {
      this.hue = hue;
      this.chroma = chroma;
      this.j = j;
      this.q = q;
      this.m = m;
      this.s = s;
      this.jstar = jstar;
      this.astar = astar;
      this.bstar = bstar;
    }
    /**
     * CAM16 instances also have coordinates in the CAM16-UCS space, called J*,
     * a*, b*, or jstar, astar, bstar in code. CAM16-UCS is included in the CAM16
     * specification, and is used to measure distances between colors.
     */
    distance(other) {
      const dJ = this.jstar - other.jstar;
      const dA = this.astar - other.astar;
      const dB = this.bstar - other.bstar;
      const dEPrime = Math.sqrt(dJ * dJ + dA * dA + dB * dB);
      const dE = 1.41 * Math.pow(dEPrime, 0.63);
      return dE;
    }
    /**
     * @param argb ARGB representation of a color.
     * @return CAM16 color, assuming the color was viewed in default viewing
     *     conditions.
     */
    static fromInt(argb) {
      return _Cam16.fromIntInViewingConditions(argb, ViewingConditions.DEFAULT);
    }
    /**
     * @param argb ARGB representation of a color.
     * @param viewingConditions Information about the environment where the color
     *     was observed.
     * @return CAM16 color.
     */
    static fromIntInViewingConditions(argb, viewingConditions) {
      const red = (argb & 16711680) >> 16;
      const green = (argb & 65280) >> 8;
      const blue = argb & 255;
      const redL = linearized(red);
      const greenL = linearized(green);
      const blueL = linearized(blue);
      const x = 0.41233895 * redL + 0.35762064 * greenL + 0.18051042 * blueL;
      const y = 0.2126 * redL + 0.7152 * greenL + 0.0722 * blueL;
      const z = 0.01932141 * redL + 0.11916382 * greenL + 0.95034478 * blueL;
      const rC = 0.401288 * x + 0.650173 * y - 0.051461 * z;
      const gC = -0.250268 * x + 1.204414 * y + 0.045854 * z;
      const bC = -2079e-6 * x + 0.048952 * y + 0.953127 * z;
      const rD = viewingConditions.rgbD[0] * rC;
      const gD = viewingConditions.rgbD[1] * gC;
      const bD = viewingConditions.rgbD[2] * bC;
      const rAF = Math.pow((viewingConditions.fl * Math.abs(rD)) / 100, 0.42);
      const gAF = Math.pow((viewingConditions.fl * Math.abs(gD)) / 100, 0.42);
      const bAF = Math.pow((viewingConditions.fl * Math.abs(bD)) / 100, 0.42);
      const rA = (signum(rD) * 400 * rAF) / (rAF + 27.13);
      const gA = (signum(gD) * 400 * gAF) / (gAF + 27.13);
      const bA = (signum(bD) * 400 * bAF) / (bAF + 27.13);
      const a = (11 * rA + -12 * gA + bA) / 11;
      const b = (rA + gA - 2 * bA) / 9;
      const u = (20 * rA + 20 * gA + 21 * bA) / 20;
      const p2 = (40 * rA + 20 * gA + bA) / 20;
      const atan2 = Math.atan2(b, a);
      const atanDegrees = (atan2 * 180) / Math.PI;
      const hue = sanitizeDegreesDouble(atanDegrees);
      const hueRadians = (hue * Math.PI) / 180;
      const ac = p2 * viewingConditions.nbb;
      const j =
        100 * Math.pow(ac / viewingConditions.aw, viewingConditions.c * viewingConditions.z);
      const q =
        (4 / viewingConditions.c) *
        Math.sqrt(j / 100) *
        (viewingConditions.aw + 4) *
        viewingConditions.fLRoot;
      const huePrime = hue < 20.14 ? hue + 360 : hue;
      const eHue = 0.25 * (Math.cos((huePrime * Math.PI) / 180 + 2) + 3.8);
      const p1 = (5e4 / 13) * eHue * viewingConditions.nc * viewingConditions.ncb;
      const t = (p1 * Math.sqrt(a * a + b * b)) / (u + 0.305);
      const alpha = Math.pow(t, 0.9) * Math.pow(1.64 - Math.pow(0.29, viewingConditions.n), 0.73);
      const c = alpha * Math.sqrt(j / 100);
      const m = c * viewingConditions.fLRoot;
      const s = 50 * Math.sqrt((alpha * viewingConditions.c) / (viewingConditions.aw + 4));
      const jstar = ((1 + 100 * 7e-3) * j) / (1 + 7e-3 * j);
      const mstar = (1 / 0.0228) * Math.log(1 + 0.0228 * m);
      const astar = mstar * Math.cos(hueRadians);
      const bstar = mstar * Math.sin(hueRadians);
      return new _Cam16(hue, c, j, q, m, s, jstar, astar, bstar);
    }
    /**
     * @param j CAM16 lightness
     * @param c CAM16 chroma
     * @param h CAM16 hue
     */
    static fromJch(j, c, h) {
      return _Cam16.fromJchInViewingConditions(j, c, h, ViewingConditions.DEFAULT);
    }
    /**
     * @param j CAM16 lightness
     * @param c CAM16 chroma
     * @param h CAM16 hue
     * @param viewingConditions Information about the environment where the color
     *     was observed.
     */
    static fromJchInViewingConditions(j, c, h, viewingConditions) {
      const q =
        (4 / viewingConditions.c) *
        Math.sqrt(j / 100) *
        (viewingConditions.aw + 4) *
        viewingConditions.fLRoot;
      const m = c * viewingConditions.fLRoot;
      const alpha = c / Math.sqrt(j / 100);
      const s = 50 * Math.sqrt((alpha * viewingConditions.c) / (viewingConditions.aw + 4));
      const hueRadians = (h * Math.PI) / 180;
      const jstar = ((1 + 100 * 7e-3) * j) / (1 + 7e-3 * j);
      const mstar = (1 / 0.0228) * Math.log(1 + 0.0228 * m);
      const astar = mstar * Math.cos(hueRadians);
      const bstar = mstar * Math.sin(hueRadians);
      return new _Cam16(h, c, j, q, m, s, jstar, astar, bstar);
    }
    /**
     * @param jstar CAM16-UCS lightness.
     * @param astar CAM16-UCS a dimension. Like a* in L*a*b*, it is a Cartesian
     *     coordinate on the Y axis.
     * @param bstar CAM16-UCS b dimension. Like a* in L*a*b*, it is a Cartesian
     *     coordinate on the X axis.
     */
    static fromUcs(jstar, astar, bstar) {
      return _Cam16.fromUcsInViewingConditions(jstar, astar, bstar, ViewingConditions.DEFAULT);
    }
    /**
     * @param jstar CAM16-UCS lightness.
     * @param astar CAM16-UCS a dimension. Like a* in L*a*b*, it is a Cartesian
     *     coordinate on the Y axis.
     * @param bstar CAM16-UCS b dimension. Like a* in L*a*b*, it is a Cartesian
     *     coordinate on the X axis.
     * @param viewingConditions Information about the environment where the color
     *     was observed.
     */
    static fromUcsInViewingConditions(jstar, astar, bstar, viewingConditions) {
      const a = astar;
      const b = bstar;
      const m = Math.sqrt(a * a + b * b);
      const M = (Math.exp(m * 0.0228) - 1) / 0.0228;
      const c = M / viewingConditions.fLRoot;
      let h = Math.atan2(b, a) * (180 / Math.PI);
      if (h < 0) {
        h += 360;
      }
      const j = jstar / (1 - (jstar - 100) * 7e-3);
      return _Cam16.fromJchInViewingConditions(j, c, h, viewingConditions);
    }
    /**
     *  @return ARGB representation of color, assuming the color was viewed in
     *     default viewing conditions, which are near-identical to the default
     *     viewing conditions for sRGB.
     */
    toInt() {
      return this.viewed(ViewingConditions.DEFAULT);
    }
    /**
     * @param viewingConditions Information about the environment where the color
     *     will be viewed.
     * @return ARGB representation of color
     */
    viewed(viewingConditions) {
      const alpha = this.chroma === 0 || this.j === 0 ? 0 : this.chroma / Math.sqrt(this.j / 100);
      const t = Math.pow(
        alpha / Math.pow(1.64 - Math.pow(0.29, viewingConditions.n), 0.73),
        1 / 0.9,
      );
      const hRad = (this.hue * Math.PI) / 180;
      const eHue = 0.25 * (Math.cos(hRad + 2) + 3.8);
      const ac =
        viewingConditions.aw *
        Math.pow(this.j / 100, 1 / viewingConditions.c / viewingConditions.z);
      const p1 = eHue * (5e4 / 13) * viewingConditions.nc * viewingConditions.ncb;
      const p2 = ac / viewingConditions.nbb;
      const hSin = Math.sin(hRad);
      const hCos = Math.cos(hRad);
      const gamma = (23 * (p2 + 0.305) * t) / (23 * p1 + 11 * t * hCos + 108 * t * hSin);
      const a = gamma * hCos;
      const b = gamma * hSin;
      const rA = (460 * p2 + 451 * a + 288 * b) / 1403;
      const gA = (460 * p2 - 891 * a - 261 * b) / 1403;
      const bA = (460 * p2 - 220 * a - 6300 * b) / 1403;
      const rCBase = Math.max(0, (27.13 * Math.abs(rA)) / (400 - Math.abs(rA)));
      const rC = signum(rA) * (100 / viewingConditions.fl) * Math.pow(rCBase, 1 / 0.42);
      const gCBase = Math.max(0, (27.13 * Math.abs(gA)) / (400 - Math.abs(gA)));
      const gC = signum(gA) * (100 / viewingConditions.fl) * Math.pow(gCBase, 1 / 0.42);
      const bCBase = Math.max(0, (27.13 * Math.abs(bA)) / (400 - Math.abs(bA)));
      const bC = signum(bA) * (100 / viewingConditions.fl) * Math.pow(bCBase, 1 / 0.42);
      const rF = rC / viewingConditions.rgbD[0];
      const gF = gC / viewingConditions.rgbD[1];
      const bF = bC / viewingConditions.rgbD[2];
      const x = 1.86206786 * rF - 1.01125463 * gF + 0.14918677 * bF;
      const y = 0.38752654 * rF + 0.62144744 * gF - 897398e-8 * bF;
      const z = -0.0158415 * rF - 0.03412294 * gF + 1.04996444 * bF;
      const argb = argbFromXyz(x, y, z);
      return argb;
    }
    /// Given color expressed in XYZ and viewed in [viewingConditions], convert to
    /// CAM16.
    static fromXyzInViewingConditions(x, y, z, viewingConditions) {
      const rC = 0.401288 * x + 0.650173 * y - 0.051461 * z;
      const gC = -0.250268 * x + 1.204414 * y + 0.045854 * z;
      const bC = -2079e-6 * x + 0.048952 * y + 0.953127 * z;
      const rD = viewingConditions.rgbD[0] * rC;
      const gD = viewingConditions.rgbD[1] * gC;
      const bD = viewingConditions.rgbD[2] * bC;
      const rAF = Math.pow((viewingConditions.fl * Math.abs(rD)) / 100, 0.42);
      const gAF = Math.pow((viewingConditions.fl * Math.abs(gD)) / 100, 0.42);
      const bAF = Math.pow((viewingConditions.fl * Math.abs(bD)) / 100, 0.42);
      const rA = (signum(rD) * 400 * rAF) / (rAF + 27.13);
      const gA = (signum(gD) * 400 * gAF) / (gAF + 27.13);
      const bA = (signum(bD) * 400 * bAF) / (bAF + 27.13);
      const a = (11 * rA + -12 * gA + bA) / 11;
      const b = (rA + gA - 2 * bA) / 9;
      const u = (20 * rA + 20 * gA + 21 * bA) / 20;
      const p2 = (40 * rA + 20 * gA + bA) / 20;
      const atan2 = Math.atan2(b, a);
      const atanDegrees = (atan2 * 180) / Math.PI;
      const hue =
        atanDegrees < 0 ? atanDegrees + 360 : atanDegrees >= 360 ? atanDegrees - 360 : atanDegrees;
      const hueRadians = (hue * Math.PI) / 180;
      const ac = p2 * viewingConditions.nbb;
      const J =
        100 * Math.pow(ac / viewingConditions.aw, viewingConditions.c * viewingConditions.z);
      const Q =
        (4 / viewingConditions.c) *
        Math.sqrt(J / 100) *
        (viewingConditions.aw + 4) *
        viewingConditions.fLRoot;
      const huePrime = hue < 20.14 ? hue + 360 : hue;
      const eHue = (1 / 4) * (Math.cos((huePrime * Math.PI) / 180 + 2) + 3.8);
      const p1 = (5e4 / 13) * eHue * viewingConditions.nc * viewingConditions.ncb;
      const t = (p1 * Math.sqrt(a * a + b * b)) / (u + 0.305);
      const alpha = Math.pow(t, 0.9) * Math.pow(1.64 - Math.pow(0.29, viewingConditions.n), 0.73);
      const C = alpha * Math.sqrt(J / 100);
      const M = C * viewingConditions.fLRoot;
      const s = 50 * Math.sqrt((alpha * viewingConditions.c) / (viewingConditions.aw + 4));
      const jstar = ((1 + 100 * 7e-3) * J) / (1 + 7e-3 * J);
      const mstar = Math.log(1 + 0.0228 * M) / 0.0228;
      const astar = mstar * Math.cos(hueRadians);
      const bstar = mstar * Math.sin(hueRadians);
      return new _Cam16(hue, C, J, Q, M, s, jstar, astar, bstar);
    }
    /// XYZ representation of CAM16 seen in [viewingConditions].
    xyzInViewingConditions(viewingConditions) {
      const alpha = this.chroma === 0 || this.j === 0 ? 0 : this.chroma / Math.sqrt(this.j / 100);
      const t = Math.pow(
        alpha / Math.pow(1.64 - Math.pow(0.29, viewingConditions.n), 0.73),
        1 / 0.9,
      );
      const hRad = (this.hue * Math.PI) / 180;
      const eHue = 0.25 * (Math.cos(hRad + 2) + 3.8);
      const ac =
        viewingConditions.aw *
        Math.pow(this.j / 100, 1 / viewingConditions.c / viewingConditions.z);
      const p1 = eHue * (5e4 / 13) * viewingConditions.nc * viewingConditions.ncb;
      const p2 = ac / viewingConditions.nbb;
      const hSin = Math.sin(hRad);
      const hCos = Math.cos(hRad);
      const gamma = (23 * (p2 + 0.305) * t) / (23 * p1 + 11 * t * hCos + 108 * t * hSin);
      const a = gamma * hCos;
      const b = gamma * hSin;
      const rA = (460 * p2 + 451 * a + 288 * b) / 1403;
      const gA = (460 * p2 - 891 * a - 261 * b) / 1403;
      const bA = (460 * p2 - 220 * a - 6300 * b) / 1403;
      const rCBase = Math.max(0, (27.13 * Math.abs(rA)) / (400 - Math.abs(rA)));
      const rC = signum(rA) * (100 / viewingConditions.fl) * Math.pow(rCBase, 1 / 0.42);
      const gCBase = Math.max(0, (27.13 * Math.abs(gA)) / (400 - Math.abs(gA)));
      const gC = signum(gA) * (100 / viewingConditions.fl) * Math.pow(gCBase, 1 / 0.42);
      const bCBase = Math.max(0, (27.13 * Math.abs(bA)) / (400 - Math.abs(bA)));
      const bC = signum(bA) * (100 / viewingConditions.fl) * Math.pow(bCBase, 1 / 0.42);
      const rF = rC / viewingConditions.rgbD[0];
      const gF = gC / viewingConditions.rgbD[1];
      const bF = bC / viewingConditions.rgbD[2];
      const x = 1.86206786 * rF - 1.01125463 * gF + 0.14918677 * bF;
      const y = 0.38752654 * rF + 0.62144744 * gF - 897398e-8 * bF;
      const z = -0.0158415 * rF - 0.03412294 * gF + 1.04996444 * bF;
      return [x, y, z];
    }
  };

  // node_modules/@material/material-color-utilities/hct/hct_solver.js
  /**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  var HctSolver = class _HctSolver {
    /**
     * Sanitizes a small enough angle in radians.
     *
     * @param angle An angle in radians; must not deviate too much
     * from 0.
     * @return A coterminal angle between 0 and 2pi.
     */
    static sanitizeRadians(angle) {
      return (angle + Math.PI * 8) % (Math.PI * 2);
    }
    /**
     * Delinearizes an RGB component, returning a floating-point
     * number.
     *
     * @param rgbComponent 0.0 <= rgb_component <= 100.0, represents
     * linear R/G/B channel
     * @return 0.0 <= output <= 255.0, color channel converted to
     * regular RGB space
     */
    static trueDelinearized(rgbComponent) {
      const normalized = rgbComponent / 100;
      let delinearized2 = 0;
      if (normalized <= 31308e-7) {
        delinearized2 = normalized * 12.92;
      } else {
        delinearized2 = 1.055 * Math.pow(normalized, 1 / 2.4) - 0.055;
      }
      return delinearized2 * 255;
    }
    static chromaticAdaptation(component) {
      const af = Math.pow(Math.abs(component), 0.42);
      return (signum(component) * 400 * af) / (af + 27.13);
    }
    /**
     * Returns the hue of a linear RGB color in CAM16.
     *
     * @param linrgb The linear RGB coordinates of a color.
     * @return The hue of the color in CAM16, in radians.
     */
    static hueOf(linrgb) {
      const scaledDiscount = matrixMultiply(linrgb, _HctSolver.SCALED_DISCOUNT_FROM_LINRGB);
      const rA = _HctSolver.chromaticAdaptation(scaledDiscount[0]);
      const gA = _HctSolver.chromaticAdaptation(scaledDiscount[1]);
      const bA = _HctSolver.chromaticAdaptation(scaledDiscount[2]);
      const a = (11 * rA + -12 * gA + bA) / 11;
      const b = (rA + gA - 2 * bA) / 9;
      return Math.atan2(b, a);
    }
    static areInCyclicOrder(a, b, c) {
      const deltaAB = _HctSolver.sanitizeRadians(b - a);
      const deltaAC = _HctSolver.sanitizeRadians(c - a);
      return deltaAB < deltaAC;
    }
    /**
     * Solves the lerp equation.
     *
     * @param source The starting number.
     * @param mid The number in the middle.
     * @param target The ending number.
     * @return A number t such that lerp(source, target, t) = mid.
     */
    static intercept(source, mid, target) {
      return (mid - source) / (target - source);
    }
    static lerpPoint(source, t, target) {
      return [
        source[0] + (target[0] - source[0]) * t,
        source[1] + (target[1] - source[1]) * t,
        source[2] + (target[2] - source[2]) * t,
      ];
    }
    /**
     * Intersects a segment with a plane.
     *
     * @param source The coordinates of point A.
     * @param coordinate The R-, G-, or B-coordinate of the plane.
     * @param target The coordinates of point B.
     * @param axis The axis the plane is perpendicular with. (0: R, 1:
     * G, 2: B)
     * @return The intersection point of the segment AB with the plane
     * R=coordinate, G=coordinate, or B=coordinate
     */
    static setCoordinate(source, coordinate, target, axis) {
      const t = _HctSolver.intercept(source[axis], coordinate, target[axis]);
      return _HctSolver.lerpPoint(source, t, target);
    }
    static isBounded(x) {
      return 0 <= x && x <= 100;
    }
    /**
     * Returns the nth possible vertex of the polygonal intersection.
     *
     * @param y The Y value of the plane.
     * @param n The zero-based index of the point. 0 <= n <= 11.
     * @return The nth possible vertex of the polygonal intersection
     * of the y plane and the RGB cube, in linear RGB coordinates, if
     * it exists. If this possible vertex lies outside of the cube,
     * [-1.0, -1.0, -1.0] is returned.
     */
    static nthVertex(y, n) {
      const kR = _HctSolver.Y_FROM_LINRGB[0];
      const kG = _HctSolver.Y_FROM_LINRGB[1];
      const kB = _HctSolver.Y_FROM_LINRGB[2];
      const coordA = n % 4 <= 1 ? 0 : 100;
      const coordB = n % 2 === 0 ? 0 : 100;
      if (n < 4) {
        const g = coordA;
        const b = coordB;
        const r = (y - g * kG - b * kB) / kR;
        if (_HctSolver.isBounded(r)) {
          return [r, g, b];
        } else {
          return [-1, -1, -1];
        }
      } else if (n < 8) {
        const b = coordA;
        const r = coordB;
        const g = (y - r * kR - b * kB) / kG;
        if (_HctSolver.isBounded(g)) {
          return [r, g, b];
        } else {
          return [-1, -1, -1];
        }
      } else {
        const r = coordA;
        const g = coordB;
        const b = (y - r * kR - g * kG) / kB;
        if (_HctSolver.isBounded(b)) {
          return [r, g, b];
        } else {
          return [-1, -1, -1];
        }
      }
    }
    /**
     * Finds the segment containing the desired color.
     *
     * @param y The Y value of the color.
     * @param targetHue The hue of the color.
     * @return A list of two sets of linear RGB coordinates, each
     * corresponding to an endpoint of the segment containing the
     * desired color.
     */
    static bisectToSegment(y, targetHue) {
      let left = [-1, -1, -1];
      let right = left;
      let leftHue = 0;
      let rightHue = 0;
      let initialized = false;
      let uncut = true;
      for (let n = 0; n < 12; n++) {
        const mid = _HctSolver.nthVertex(y, n);
        if (mid[0] < 0) {
          continue;
        }
        const midHue = _HctSolver.hueOf(mid);
        if (!initialized) {
          left = mid;
          right = mid;
          leftHue = midHue;
          rightHue = midHue;
          initialized = true;
          continue;
        }
        if (uncut || _HctSolver.areInCyclicOrder(leftHue, midHue, rightHue)) {
          uncut = false;
          if (_HctSolver.areInCyclicOrder(leftHue, targetHue, midHue)) {
            right = mid;
            rightHue = midHue;
          } else {
            left = mid;
            leftHue = midHue;
          }
        }
      }
      return [left, right];
    }
    static midpoint(a, b) {
      return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    }
    static criticalPlaneBelow(x) {
      return Math.floor(x - 0.5);
    }
    static criticalPlaneAbove(x) {
      return Math.ceil(x - 0.5);
    }
    /**
     * Finds a color with the given Y and hue on the boundary of the
     * cube.
     *
     * @param y The Y value of the color.
     * @param targetHue The hue of the color.
     * @return The desired color, in linear RGB coordinates.
     */
    static bisectToLimit(y, targetHue) {
      const segment = _HctSolver.bisectToSegment(y, targetHue);
      let left = segment[0];
      let leftHue = _HctSolver.hueOf(left);
      let right = segment[1];
      for (let axis = 0; axis < 3; axis++) {
        if (left[axis] !== right[axis]) {
          let lPlane = -1;
          let rPlane = 255;
          if (left[axis] < right[axis]) {
            lPlane = _HctSolver.criticalPlaneBelow(_HctSolver.trueDelinearized(left[axis]));
            rPlane = _HctSolver.criticalPlaneAbove(_HctSolver.trueDelinearized(right[axis]));
          } else {
            lPlane = _HctSolver.criticalPlaneAbove(_HctSolver.trueDelinearized(left[axis]));
            rPlane = _HctSolver.criticalPlaneBelow(_HctSolver.trueDelinearized(right[axis]));
          }
          for (let i = 0; i < 8; i++) {
            if (Math.abs(rPlane - lPlane) <= 1) {
              break;
            } else {
              const mPlane = Math.floor((lPlane + rPlane) / 2);
              const midPlaneCoordinate = _HctSolver.CRITICAL_PLANES[mPlane];
              const mid = _HctSolver.setCoordinate(left, midPlaneCoordinate, right, axis);
              const midHue = _HctSolver.hueOf(mid);
              if (_HctSolver.areInCyclicOrder(leftHue, targetHue, midHue)) {
                right = mid;
                rPlane = mPlane;
              } else {
                left = mid;
                leftHue = midHue;
                lPlane = mPlane;
              }
            }
          }
        }
      }
      return _HctSolver.midpoint(left, right);
    }
    static inverseChromaticAdaptation(adapted) {
      const adaptedAbs = Math.abs(adapted);
      const base = Math.max(0, (27.13 * adaptedAbs) / (400 - adaptedAbs));
      return signum(adapted) * Math.pow(base, 1 / 0.42);
    }
    /**
     * Finds a color with the given hue, chroma, and Y.
     *
     * @param hueRadians The desired hue in radians.
     * @param chroma The desired chroma.
     * @param y The desired Y.
     * @return The desired color as a hexadecimal integer, if found; 0
     * otherwise.
     */
    static findResultByJ(hueRadians, chroma, y) {
      let j = Math.sqrt(y) * 11;
      const viewingConditions = ViewingConditions.DEFAULT;
      const tInnerCoeff = 1 / Math.pow(1.64 - Math.pow(0.29, viewingConditions.n), 0.73);
      const eHue = 0.25 * (Math.cos(hueRadians + 2) + 3.8);
      const p1 = eHue * (5e4 / 13) * viewingConditions.nc * viewingConditions.ncb;
      const hSin = Math.sin(hueRadians);
      const hCos = Math.cos(hueRadians);
      for (let iterationRound = 0; iterationRound < 5; iterationRound++) {
        const jNormalized = j / 100;
        const alpha = chroma === 0 || j === 0 ? 0 : chroma / Math.sqrt(jNormalized);
        const t = Math.pow(alpha * tInnerCoeff, 1 / 0.9);
        const ac =
          viewingConditions.aw *
          Math.pow(jNormalized, 1 / viewingConditions.c / viewingConditions.z);
        const p2 = ac / viewingConditions.nbb;
        const gamma = (23 * (p2 + 0.305) * t) / (23 * p1 + 11 * t * hCos + 108 * t * hSin);
        const a = gamma * hCos;
        const b = gamma * hSin;
        const rA = (460 * p2 + 451 * a + 288 * b) / 1403;
        const gA = (460 * p2 - 891 * a - 261 * b) / 1403;
        const bA = (460 * p2 - 220 * a - 6300 * b) / 1403;
        const rCScaled = _HctSolver.inverseChromaticAdaptation(rA);
        const gCScaled = _HctSolver.inverseChromaticAdaptation(gA);
        const bCScaled = _HctSolver.inverseChromaticAdaptation(bA);
        const linrgb = matrixMultiply(
          [rCScaled, gCScaled, bCScaled],
          _HctSolver.LINRGB_FROM_SCALED_DISCOUNT,
        );
        if (linrgb[0] < 0 || linrgb[1] < 0 || linrgb[2] < 0) {
          return 0;
        }
        const kR = _HctSolver.Y_FROM_LINRGB[0];
        const kG = _HctSolver.Y_FROM_LINRGB[1];
        const kB = _HctSolver.Y_FROM_LINRGB[2];
        const fnj = kR * linrgb[0] + kG * linrgb[1] + kB * linrgb[2];
        if (fnj <= 0) {
          return 0;
        }
        if (iterationRound === 4 || Math.abs(fnj - y) < 2e-3) {
          if (linrgb[0] > 100.01 || linrgb[1] > 100.01 || linrgb[2] > 100.01) {
            return 0;
          }
          return argbFromLinrgb(linrgb);
        }
        j = j - ((fnj - y) * j) / (2 * fnj);
      }
      return 0;
    }
    /**
     * Finds an sRGB color with the given hue, chroma, and L*, if
     * possible.
     *
     * @param hueDegrees The desired hue, in degrees.
     * @param chroma The desired chroma.
     * @param lstar The desired L*.
     * @return A hexadecimal representing the sRGB color. The color
     * has sufficiently close hue, chroma, and L* to the desired
     * values, if possible; otherwise, the hue and L* will be
     * sufficiently close, and chroma will be maximized.
     */
    static solveToInt(hueDegrees, chroma, lstar) {
      if (chroma < 1e-4 || lstar < 1e-4 || lstar > 99.9999) {
        return argbFromLstar(lstar);
      }
      hueDegrees = sanitizeDegreesDouble(hueDegrees);
      const hueRadians = (hueDegrees / 180) * Math.PI;
      const y = yFromLstar(lstar);
      const exactAnswer = _HctSolver.findResultByJ(hueRadians, chroma, y);
      if (exactAnswer !== 0) {
        return exactAnswer;
      }
      const linrgb = _HctSolver.bisectToLimit(y, hueRadians);
      return argbFromLinrgb(linrgb);
    }
    /**
     * Finds an sRGB color with the given hue, chroma, and L*, if
     * possible.
     *
     * @param hueDegrees The desired hue, in degrees.
     * @param chroma The desired chroma.
     * @param lstar The desired L*.
     * @return An CAM16 object representing the sRGB color. The color
     * has sufficiently close hue, chroma, and L* to the desired
     * values, if possible; otherwise, the hue and L* will be
     * sufficiently close, and chroma will be maximized.
     */
    static solveToCam(hueDegrees, chroma, lstar) {
      return Cam16.fromInt(_HctSolver.solveToInt(hueDegrees, chroma, lstar));
    }
  };
  HctSolver.SCALED_DISCOUNT_FROM_LINRGB = [
    [0.001200833568784504, 0.002389694492170889, 2795742885861124e-19],
    [5891086651375999e-19, 0.0029785502573438758, 3270666104008398e-19],
    [10146692491640572e-20, 5364214359186694e-19, 0.0032979401770712076],
  ];
  HctSolver.LINRGB_FROM_SCALED_DISCOUNT = [
    [1373.2198709594231, -1100.4251190754821, -7.278681089101213],
    [-271.815969077903, 559.6580465940733, -32.46047482791194],
    [1.9622899599665666, -57.173814538844006, 308.7233197812385],
  ];
  HctSolver.Y_FROM_LINRGB = [0.2126, 0.7152, 0.0722];
  HctSolver.CRITICAL_PLANES = [
    0.015176349177441876, 0.045529047532325624, 0.07588174588720938, 0.10623444424209313,
    0.13658714259697685, 0.16693984095186062, 0.19729253930674434, 0.2276452376616281,
    0.2579979360165119, 0.28835063437139563, 0.3188300904430532, 0.350925934958123,
    0.3848314933096426, 0.42057480301049466, 0.458183274052838, 0.4976837250274023,
    0.5391024159806381, 0.5824650784040898, 0.6277969426914107, 0.6751227633498623,
    0.7244668422128921, 0.775853049866786, 0.829304845476233, 0.8848452951698498, 0.942497089126609,
    1.0022825574869039, 1.0642236851973577, 1.1283421258858297, 1.1946592148522128,
    1.2631959812511864, 1.3339731595349034, 1.407011200216447, 1.4823302800086415,
    1.5599503113873272, 1.6398909516233677, 1.7221716113234105, 1.8068114625156377,
    1.8938294463134073, 1.9832442801866852, 2.075074464868551, 2.1693382909216234,
    2.2660538449872063, 2.36523901573795, 2.4669114995532007, 2.5710888059345764,
    2.6777882626779785, 2.7870270208169257, 2.898822059350997, 3.0131901897720907,
    3.1301480604002863, 3.2497121605402226, 3.3718988244681087, 3.4967242352587946,
    3.624204428461639, 3.754355295633311, 3.887192587735158, 4.022731918402185, 4.160988767090289,
    4.301978482107941, 4.445716283538092, 4.592217266055746, 4.741496401646282, 4.893568542229298,
    5.048448422192488, 5.20615066083972, 5.3666897647573375, 5.5300801301023865, 5.696336044816294,
    5.865471690767354, 6.037501145825082, 6.212438385869475, 6.390297286737924, 6.571091626112461,
    6.7548350853498045, 6.941541251256611, 7.131223617812143, 7.323895587840543, 7.5195704746346665,
    7.7182615035334345, 7.919981813454504, 8.124744458384042, 8.332562408825165, 8.543448553206703,
    8.757415699253682, 8.974476575321063, 9.194643831691977, 9.417930041841839, 9.644347703669503,
    9.873909240696694, 10.106627003236781, 10.342513269534024, 10.58158024687427, 10.8238400726681,
    11.069304815507364, 11.317986476196008, 11.569896988756009, 11.825048221409341,
    12.083451977536606, 12.345119996613247, 12.610063955123938, 12.878295467455942,
    13.149826086772048, 13.42466730586372, 13.702830557985108, 13.984327217668513,
    14.269168601521828, 14.55736596900856, 14.848930523210871, 15.143873411576273,
    15.44220572664832, 15.743938506781891, 16.04908273684337, 16.35764934889634, 16.66964922287304,
    16.985093187232053, 17.30399201960269, 17.62635644741625, 17.95219714852476, 18.281524751807332,
    18.614349837764564, 18.95068293910138, 19.290534541298456, 19.633915083172692,
    19.98083495742689, 20.331304511189067, 20.685334046541502, 21.042933821039977,
    21.404114048223256, 21.76888489811322, 22.137256497705877, 22.50923893145328,
    22.884842241736916, 23.264076429332462, 23.6469514538663, 24.033477234264016, 24.42366364919083,
    24.817520537484558, 25.21505769858089, 25.61628489293138, 26.021211842414342,
    26.429848230738664, 26.842203703840827, 27.258287870275353, 27.678110301598522,
    28.10168053274597, 28.529008062403893, 28.96010235337422, 29.39497283293396, 29.83362889318845,
    30.276079891419332, 30.722335150426627, 31.172403958865512, 31.62629557157785,
    32.08401920991837, 32.54558406207592, 33.010999283389665, 33.4802739966603, 33.953417292456834,
    34.430438229418264, 34.911345834551085, 35.39614910352207, 35.88485700094671, 36.37747846067349,
    36.87402238606382, 37.37449765026789, 37.87891309649659, 38.38727753828926, 38.89959975977785,
    39.41588851594697, 39.93615253289054, 40.460400508064545, 40.98864111053629, 41.520882981230194,
    42.05713473317016, 42.597404951718396, 43.141702194811224, 43.6900349931913, 44.24241185063697,
    44.798841244188324, 45.35933162437017, 45.92389141541209, 46.49252901546552, 47.065252796817916,
    47.64207110610409, 48.22299226451468, 48.808024568002054, 49.3971762874833, 49.9904556690408,
    50.587870934119984, 51.189430279724725, 51.79514187861014, 52.40501387947288, 53.0190544071392,
    53.637271562750364, 54.259673423945976, 54.88626804504493, 55.517063457223934,
    56.15206766869424, 56.79128866487574, 57.43473440856916, 58.08241284012621, 58.734331877617365,
    59.39049941699807, 60.05092333227251, 60.715611475655585, 61.38457167773311, 62.057811747619894,
    62.7353394731159, 63.417162620860914, 64.10328893648692, 64.79372614476921, 65.48848194977529,
    66.18756403501224, 66.89098006357258, 67.59873767827808, 68.31084450182222, 69.02730813691093,
    69.74813616640164, 70.47333615344107, 71.20291564160104, 71.93688215501312, 72.67524319850172,
    73.41800625771542, 74.16517879925733, 74.9167682708136, 75.67278210128072, 76.43322770089146,
    77.1981124613393, 77.96744375590167, 78.74122893956174, 79.51947534912904, 80.30219030335869,
    81.08938110306934, 81.88105503125999, 82.67721935322541, 83.4778813166706, 84.28304815182372,
    85.09272707154808, 85.90692527145302, 86.72564993000343, 87.54890820862819, 88.3767072518277,
    89.2090541872801, 90.04595612594655, 90.88742016217518, 91.73345337380438, 92.58406282226491,
    93.43925555268066, 94.29903859396902, 95.16341895893969, 96.03240364439274, 96.9059996312159,
    97.78421388448044, 98.6670533535366, 99.55452497210776,
  ];

  // node_modules/@material/material-color-utilities/hct/hct.js
  /**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  var Hct = class _Hct {
    static from(hue, chroma, tone) {
      return new _Hct(HctSolver.solveToInt(hue, chroma, tone));
    }
    /**
     * @param argb ARGB representation of a color.
     * @return HCT representation of a color in default viewing conditions
     */
    static fromInt(argb) {
      return new _Hct(argb);
    }
    toInt() {
      return this.argb;
    }
    /**
     * A number, in degrees, representing ex. red, orange, yellow, etc.
     * Ranges from 0 <= hue < 360.
     */
    get hue() {
      return this.internalHue;
    }
    /**
     * @param newHue 0 <= newHue < 360; invalid values are corrected.
     * Chroma may decrease because chroma has a different maximum for any given
     * hue and tone.
     */
    set hue(newHue) {
      this.setInternalState(HctSolver.solveToInt(newHue, this.internalChroma, this.internalTone));
    }
    get chroma() {
      return this.internalChroma;
    }
    /**
     * @param newChroma 0 <= newChroma < ?
     * Chroma may decrease because chroma has a different maximum for any given
     * hue and tone.
     */
    set chroma(newChroma) {
      this.setInternalState(HctSolver.solveToInt(this.internalHue, newChroma, this.internalTone));
    }
    /** Lightness. Ranges from 0 to 100. */
    get tone() {
      return this.internalTone;
    }
    /**
     * @param newTone 0 <= newTone <= 100; invalid valids are corrected.
     * Chroma may decrease because chroma has a different maximum for any given
     * hue and tone.
     */
    set tone(newTone) {
      this.setInternalState(HctSolver.solveToInt(this.internalHue, this.internalChroma, newTone));
    }
    /** Sets a property of the Hct object. */
    setValue(propertyName, value) {
      this[propertyName] = value;
    }
    toString() {
      return `HCT(${this.hue.toFixed(0)}, ${this.chroma.toFixed(0)}, ${this.tone.toFixed(0)})`;
    }
    static isBlue(hue) {
      return hue >= 250 && hue < 270;
    }
    static isYellow(hue) {
      return hue >= 105 && hue < 125;
    }
    static isCyan(hue) {
      return hue >= 170 && hue < 207;
    }
    constructor(argb) {
      this.argb = argb;
      const cam = Cam16.fromInt(argb);
      this.internalHue = cam.hue;
      this.internalChroma = cam.chroma;
      this.internalTone = lstarFromArgb(argb);
      this.argb = argb;
    }
    setInternalState(argb) {
      const cam = Cam16.fromInt(argb);
      this.internalHue = cam.hue;
      this.internalChroma = cam.chroma;
      this.internalTone = lstarFromArgb(argb);
      this.argb = argb;
    }
    /**
     * Translates a color into different [ViewingConditions].
     *
     * Colors change appearance. They look different with lights on versus off,
     * the same color, as in hex code, on white looks different when on black.
     * This is called color relativity, most famously explicated by Josef Albers
     * in Interaction of Color.
     *
     * In color science, color appearance models can account for this and
     * calculate the appearance of a color in different settings. HCT is based on
     * CAM16, a color appearance model, and uses it to make these calculations.
     *
     * See [ViewingConditions.make] for parameters affecting color appearance.
     */
    inViewingConditions(vc) {
      const cam = Cam16.fromInt(this.toInt());
      const viewedInVc = cam.xyzInViewingConditions(vc);
      const recastInVc = Cam16.fromXyzInViewingConditions(
        viewedInVc[0],
        viewedInVc[1],
        viewedInVc[2],
        ViewingConditions.make(),
      );
      const recastHct = _Hct.from(recastInVc.hue, recastInVc.chroma, lstarFromY(viewedInVc[1]));
      return recastHct;
    }
  };

  // node_modules/@material/material-color-utilities/blend/blend.js
  /**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */

  // node_modules/@material/material-color-utilities/contrast/contrast.js
  /**
   * @license
   * Copyright 2022 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  var Contrast = class _Contrast {
    /**
     * Returns a contrast ratio, which ranges from 1 to 21.
     *
     * @param toneA Tone between 0 and 100. Values outside will be clamped.
     * @param toneB Tone between 0 and 100. Values outside will be clamped.
     */
    static ratioOfTones(toneA, toneB) {
      toneA = clampDouble(0, 100, toneA);
      toneB = clampDouble(0, 100, toneB);
      return _Contrast.ratioOfYs(yFromLstar(toneA), yFromLstar(toneB));
    }
    static ratioOfYs(y1, y2) {
      const lighter = y1 > y2 ? y1 : y2;
      const darker = lighter === y2 ? y1 : y2;
      return (lighter + 5) / (darker + 5);
    }
    /**
     * Returns a tone >= tone parameter that ensures ratio parameter.
     * Return value is between 0 and 100.
     * Returns -1 if ratio cannot be achieved with tone parameter.
     *
     * @param tone Tone return value must contrast with.
     * Range is 0 to 100. Invalid values will result in -1 being returned.
     * @param ratio Contrast ratio of return value and tone.
     * Range is 1 to 21, invalid values have undefined behavior.
     */
    static lighter(tone, ratio) {
      if (tone < 0 || tone > 100) {
        return -1;
      }
      const darkY = yFromLstar(tone);
      const lightY = ratio * (darkY + 5) - 5;
      const realContrast = _Contrast.ratioOfYs(lightY, darkY);
      const delta = Math.abs(realContrast - ratio);
      if (realContrast < ratio && delta > 0.04) {
        return -1;
      }
      const returnValue = lstarFromY(lightY) + 0.4;
      if (returnValue < 0 || returnValue > 100) {
        return -1;
      }
      return returnValue;
    }
    /**
     * Returns a tone <= tone parameter that ensures ratio parameter.
     * Return value is between 0 and 100.
     * Returns -1 if ratio cannot be achieved with tone parameter.
     *
     * @param tone Tone return value must contrast with.
     * Range is 0 to 100. Invalid values will result in -1 being returned.
     * @param ratio Contrast ratio of return value and tone.
     * Range is 1 to 21, invalid values have undefined behavior.
     */
    static darker(tone, ratio) {
      if (tone < 0 || tone > 100) {
        return -1;
      }
      const lightY = yFromLstar(tone);
      const darkY = (lightY + 5) / ratio - 5;
      const realContrast = _Contrast.ratioOfYs(lightY, darkY);
      const delta = Math.abs(realContrast - ratio);
      if (realContrast < ratio && delta > 0.04) {
        return -1;
      }
      const returnValue = lstarFromY(darkY) - 0.4;
      if (returnValue < 0 || returnValue > 100) {
        return -1;
      }
      return returnValue;
    }
    /**
     * Returns a tone >= tone parameter that ensures ratio parameter.
     * Return value is between 0 and 100.
     * Returns 100 if ratio cannot be achieved with tone parameter.
     *
     * This method is unsafe because the returned value is guaranteed to be in
     * bounds for tone, i.e. between 0 and 100. However, that value may not reach
     * the ratio with tone. For example, there is no color lighter than T100.
     *
     * @param tone Tone return value must contrast with.
     * Range is 0 to 100. Invalid values will result in 100 being returned.
     * @param ratio Desired contrast ratio of return value and tone parameter.
     * Range is 1 to 21, invalid values have undefined behavior.
     */
    static lighterUnsafe(tone, ratio) {
      const lighterSafe = _Contrast.lighter(tone, ratio);
      return lighterSafe < 0 ? 100 : lighterSafe;
    }
    /**
     * Returns a tone >= tone parameter that ensures ratio parameter.
     * Return value is between 0 and 100.
     * Returns 100 if ratio cannot be achieved with tone parameter.
     *
     * This method is unsafe because the returned value is guaranteed to be in
     * bounds for tone, i.e. between 0 and 100. However, that value may not reach
     * the [ratio with [tone]. For example, there is no color darker than T0.
     *
     * @param tone Tone return value must contrast with.
     * Range is 0 to 100. Invalid values will result in 0 being returned.
     * @param ratio Desired contrast ratio of return value and tone parameter.
     * Range is 1 to 21, invalid values have undefined behavior.
     */
    static darkerUnsafe(tone, ratio) {
      const darkerSafe = _Contrast.darker(tone, ratio);
      return darkerSafe < 0 ? 0 : darkerSafe;
    }
  };

  // node_modules/@material/material-color-utilities/dislike/dislike_analyzer.js
  /**
   * @license
   * Copyright 2023 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  var DislikeAnalyzer = class _DislikeAnalyzer {
    /**
     * Returns true if a color is disliked.
     *
     * @param hct A color to be judged.
     * @return Whether the color is disliked.
     *
     * Disliked is defined as a dark yellow-green that is not neutral.
     */
    static isDisliked(hct) {
      const huePasses = Math.round(hct.hue) >= 90 && Math.round(hct.hue) <= 111;
      const chromaPasses = Math.round(hct.chroma) > 16;
      const tonePasses = Math.round(hct.tone) < 65;
      return huePasses && chromaPasses && tonePasses;
    }
    /**
     * If a color is disliked, lighten it to make it likable.
     *
     * @param hct A color to be judged.
     * @return A new color if the original color is disliked, or the original
     *   color if it is acceptable.
     */
    static fixIfDisliked(hct) {
      if (_DislikeAnalyzer.isDisliked(hct)) {
        return Hct.from(hct.hue, hct.chroma, 70);
      }
      return hct;
    }
  };

  // node_modules/@material/material-color-utilities/dynamiccolor/dynamic_color.js
  /**
   * @license
   * Copyright 2022 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  function validateExtendedColor(originalColor, specVersion, extendedColor) {
    if (originalColor.name !== extendedColor.name) {
      throw new Error(
        `Attempting to extend color ${originalColor.name} with color ${extendedColor.name} of different name for spec version ${specVersion}.`,
      );
    }
    if (originalColor.isBackground !== extendedColor.isBackground) {
      throw new Error(
        `Attempting to extend color ${originalColor.name} as a ${originalColor.isBackground ? "background" : "foreground"} with color ${extendedColor.name} as a ${extendedColor.isBackground ? "background" : "foreground"} for spec version ${specVersion}.`,
      );
    }
  }
  function extendSpecVersion(originlColor, specVersion, extendedColor) {
    validateExtendedColor(originlColor, specVersion, extendedColor);
    return DynamicColor.fromPalette({
      name: originlColor.name,
      palette: (s) =>
        s.specVersion === specVersion ? extendedColor.palette(s) : originlColor.palette(s),
      tone: (s) => (s.specVersion === specVersion ? extendedColor.tone(s) : originlColor.tone(s)),
      isBackground: originlColor.isBackground,
      chromaMultiplier: (s) => {
        const chromaMultiplier =
          s.specVersion === specVersion
            ? extendedColor.chromaMultiplier
            : originlColor.chromaMultiplier;
        return chromaMultiplier !== void 0 ? chromaMultiplier(s) : 1;
      },
      background: (s) => {
        const background =
          s.specVersion === specVersion ? extendedColor.background : originlColor.background;
        return background !== void 0 ? background(s) : void 0;
      },
      secondBackground: (s) => {
        const secondBackground =
          s.specVersion === specVersion
            ? extendedColor.secondBackground
            : originlColor.secondBackground;
        return secondBackground !== void 0 ? secondBackground(s) : void 0;
      },
      contrastCurve: (s) => {
        const contrastCurve =
          s.specVersion === specVersion ? extendedColor.contrastCurve : originlColor.contrastCurve;
        return contrastCurve !== void 0 ? contrastCurve(s) : void 0;
      },
      toneDeltaPair: (s) => {
        const toneDeltaPair =
          s.specVersion === specVersion ? extendedColor.toneDeltaPair : originlColor.toneDeltaPair;
        return toneDeltaPair !== void 0 ? toneDeltaPair(s) : void 0;
      },
    });
  }
  var DynamicColor = class _DynamicColor {
    /**
     * Create a DynamicColor defined by a TonalPalette and HCT tone.
     *
     * @param args Functions with DynamicScheme as input. Must provide a palette
     *     and tone. May provide a background DynamicColor and ToneDeltaPair.
     */
    static fromPalette(args) {
      return new _DynamicColor(
        args.name ?? "",
        args.palette,
        args.tone ?? _DynamicColor.getInitialToneFromBackground(args.background),
        args.isBackground ?? false,
        args.chromaMultiplier,
        args.background,
        args.secondBackground,
        args.contrastCurve,
        args.toneDeltaPair,
      );
    }
    static getInitialToneFromBackground(background) {
      if (background === void 0) {
        return (s) => 50;
      }
      return (s) => (background(s) ? background(s).getTone(s) : 50);
    }
    /**
     * The base constructor for DynamicColor.
     *
     * _Strongly_ prefer using one of the convenience constructors. This class is
     * arguably too flexible to ensure it can support any scenario. Functional
     * arguments allow  overriding without risks that come with subclasses.
     *
     * For example, the default behavior of adjust tone at max contrast
     * to be at a 7.0 ratio with its background is principled and
     * matches accessibility guidance. That does not mean it's the desired
     * approach for _every_ design system, and every color pairing,
     * always, in every case.
     *
     * @param name The name of the dynamic color. Defaults to empty.
     * @param palette Function that provides a TonalPalette given DynamicScheme. A
     *     TonalPalette is defined by a hue and chroma, so this replaces the need
     *     to specify hue/chroma. By providing a tonal palette, when contrast
     *     adjustments are made, intended chroma can be preserved.
     * @param tone Function that provides a tone, given a DynamicScheme.
     * @param isBackground Whether this dynamic color is a background, with some
     *     other color as the foreground. Defaults to false.
     * @param chromaMultiplier A factor that multiplies the chroma for this color.
     * @param background The background of the dynamic color (as a function of a
     *     `DynamicScheme`), if it exists.
     * @param secondBackground A second background of the dynamic color (as a
     *     function of a `DynamicScheme`), if it exists.
     * @param contrastCurve A `ContrastCurve` object specifying how its contrast
     *     against its background should behave in various contrast levels
     *     options.
     * @param toneDeltaPair A `ToneDeltaPair` object specifying a tone delta
     *     constraint between two colors. One of them must be the color being
     *     constructed.
     */
    constructor(
      name,
      palette,
      tone,
      isBackground,
      chromaMultiplier,
      background,
      secondBackground,
      contrastCurve,
      toneDeltaPair,
    ) {
      this.name = name;
      this.palette = palette;
      this.tone = tone;
      this.isBackground = isBackground;
      this.chromaMultiplier = chromaMultiplier;
      this.background = background;
      this.secondBackground = secondBackground;
      this.contrastCurve = contrastCurve;
      this.toneDeltaPair = toneDeltaPair;
      this.hctCache = /* @__PURE__ */ new Map();
      if (!background && secondBackground) {
        throw new Error(
          `Color ${name} has secondBackgrounddefined, but background is not defined.`,
        );
      }
      if (!background && contrastCurve) {
        throw new Error(`Color ${name} has contrastCurvedefined, but background is not defined.`);
      }
      if (background && !contrastCurve) {
        throw new Error(`Color ${name} has backgrounddefined, but contrastCurve is not defined.`);
      }
    }
    /**
     * Returns a deep copy of this DynamicColor.
     */
    clone() {
      return _DynamicColor.fromPalette({
        name: this.name,
        palette: this.palette,
        tone: this.tone,
        isBackground: this.isBackground,
        chromaMultiplier: this.chromaMultiplier,
        background: this.background,
        secondBackground: this.secondBackground,
        contrastCurve: this.contrastCurve,
        toneDeltaPair: this.toneDeltaPair,
      });
    }
    /**
     * Clears the cache of HCT values for this color. For testing or debugging
     * purposes.
     */
    clearCache() {
      this.hctCache.clear();
    }
    /**
     * Returns a ARGB integer (i.e. a hex code).
     *
     * @param scheme Defines the conditions of the user interface, for example,
     *     whether or not it is dark mode or light mode, and what the desired
     *     contrast level is.
     */
    getArgb(scheme) {
      return this.getHct(scheme).toInt();
    }
    /**
     * Returns a color, expressed in the HCT color space, that this
     * DynamicColor is under the conditions in scheme.
     *
     * @param scheme Defines the conditions of the user interface, for example,
     *     whether or not it is dark mode or light mode, and what the desired
     *     contrast level is.
     */
    getHct(scheme) {
      const cachedAnswer = this.hctCache.get(scheme);
      if (cachedAnswer != null) {
        return cachedAnswer;
      }
      const answer = getSpec(scheme.specVersion).getHct(scheme, this);
      if (this.hctCache.size > 4) {
        this.hctCache.clear();
      }
      this.hctCache.set(scheme, answer);
      return answer;
    }
    /**
     * Returns a tone, T in the HCT color space, that this DynamicColor is under
     * the conditions in scheme.
     *
     * @param scheme Defines the conditions of the user interface, for example,
     *     whether or not it is dark mode or light mode, and what the desired
     *     contrast level is.
     */
    getTone(scheme) {
      return getSpec(scheme.specVersion).getTone(scheme, this);
    }
    /**
     * Given a background tone, finds a foreground tone, while ensuring they reach
     * a contrast ratio that is as close to [ratio] as possible.
     *
     * @param bgTone Tone in HCT. Range is 0 to 100, undefined behavior when it
     *     falls outside that range.
     * @param ratio The contrast ratio desired between bgTone and the return
     *     value.
     */
    static foregroundTone(bgTone, ratio) {
      const lighterTone = Contrast.lighterUnsafe(bgTone, ratio);
      const darkerTone = Contrast.darkerUnsafe(bgTone, ratio);
      const lighterRatio = Contrast.ratioOfTones(lighterTone, bgTone);
      const darkerRatio = Contrast.ratioOfTones(darkerTone, bgTone);
      const preferLighter = _DynamicColor.tonePrefersLightForeground(bgTone);
      if (preferLighter) {
        const negligibleDifference =
          Math.abs(lighterRatio - darkerRatio) < 0.1 && lighterRatio < ratio && darkerRatio < ratio;
        return lighterRatio >= ratio || lighterRatio >= darkerRatio || negligibleDifference
          ? lighterTone
          : darkerTone;
      } else {
        return darkerRatio >= ratio || darkerRatio >= lighterRatio ? darkerTone : lighterTone;
      }
    }
    /**
     * Returns whether [tone] prefers a light foreground.
     *
     * People prefer white foregrounds on ~T60-70. Observed over time, and also
     * by Andrew Somers during research for APCA.
     *
     * T60 used as to create the smallest discontinuity possible when skipping
     * down to T49 in order to ensure light foregrounds.
     * Since `tertiaryContainer` in dark monochrome scheme requires a tone of
     * 60, it should not be adjusted. Therefore, 60 is excluded here.
     */
    static tonePrefersLightForeground(tone) {
      return Math.round(tone) < 60;
    }
    /**
     * Returns whether [tone] can reach a contrast ratio of 4.5 with a lighter
     * color.
     */
    static toneAllowsLightForeground(tone) {
      return Math.round(tone) <= 49;
    }
    /**
     * Adjusts a tone such that white has 4.5 contrast, if the tone is
     * reasonably close to supporting it.
     */
    static enableLightForeground(tone) {
      if (
        _DynamicColor.tonePrefersLightForeground(tone) &&
        !_DynamicColor.toneAllowsLightForeground(tone)
      ) {
        return 49;
      }
      return tone;
    }
  };
  var ColorCalculationDelegateImpl2021 = class {
    getHct(scheme, color) {
      const tone = color.getTone(scheme);
      const palette = color.palette(scheme);
      return palette.getHct(tone);
    }
    getTone(scheme, color) {
      const decreasingContrast = scheme.contrastLevel < 0;
      const toneDeltaPair = color.toneDeltaPair ? color.toneDeltaPair(scheme) : void 0;
      if (toneDeltaPair) {
        const roleA = toneDeltaPair.roleA;
        const roleB = toneDeltaPair.roleB;
        const delta = toneDeltaPair.delta;
        const polarity = toneDeltaPair.polarity;
        const stayTogether = toneDeltaPair.stayTogether;
        const aIsNearer =
          polarity === "nearer" ||
          (polarity === "lighter" && !scheme.isDark) ||
          (polarity === "darker" && scheme.isDark);
        const nearer = aIsNearer ? roleA : roleB;
        const farther = aIsNearer ? roleB : roleA;
        const amNearer = color.name === nearer.name;
        const expansionDir = scheme.isDark ? 1 : -1;
        let nTone = nearer.tone(scheme);
        let fTone = farther.tone(scheme);
        if (color.background && nearer.contrastCurve && farther.contrastCurve) {
          const bg = color.background(scheme);
          const nContrastCurve = nearer.contrastCurve(scheme);
          const fContrastCurve = farther.contrastCurve(scheme);
          if (bg && nContrastCurve && fContrastCurve) {
            const bgTone = bg.getTone(scheme);
            const nContrast = nContrastCurve.get(scheme.contrastLevel);
            const fContrast = fContrastCurve.get(scheme.contrastLevel);
            if (Contrast.ratioOfTones(bgTone, nTone) < nContrast) {
              nTone = DynamicColor.foregroundTone(bgTone, nContrast);
            }
            if (Contrast.ratioOfTones(bgTone, fTone) < fContrast) {
              fTone = DynamicColor.foregroundTone(bgTone, fContrast);
            }
            if (decreasingContrast) {
              nTone = DynamicColor.foregroundTone(bgTone, nContrast);
              fTone = DynamicColor.foregroundTone(bgTone, fContrast);
            }
          }
        }
        if ((fTone - nTone) * expansionDir < delta) {
          fTone = clampDouble(0, 100, nTone + delta * expansionDir);
          if ((fTone - nTone) * expansionDir >= delta) {
          } else {
            nTone = clampDouble(0, 100, fTone - delta * expansionDir);
          }
        }
        if (50 <= nTone && nTone < 60) {
          if (expansionDir > 0) {
            nTone = 60;
            fTone = Math.max(fTone, nTone + delta * expansionDir);
          } else {
            nTone = 49;
            fTone = Math.min(fTone, nTone + delta * expansionDir);
          }
        } else if (50 <= fTone && fTone < 60) {
          if (stayTogether) {
            if (expansionDir > 0) {
              nTone = 60;
              fTone = Math.max(fTone, nTone + delta * expansionDir);
            } else {
              nTone = 49;
              fTone = Math.min(fTone, nTone + delta * expansionDir);
            }
          } else {
            if (expansionDir > 0) {
              fTone = 60;
            } else {
              fTone = 49;
            }
          }
        }
        return amNearer ? nTone : fTone;
      } else {
        let answer = color.tone(scheme);
        if (
          color.background == void 0 ||
          color.background(scheme) === void 0 ||
          color.contrastCurve == void 0 ||
          color.contrastCurve(scheme) === void 0
        ) {
          return answer;
        }
        const bgTone = color.background(scheme).getTone(scheme);
        const desiredRatio = color.contrastCurve(scheme).get(scheme.contrastLevel);
        if (Contrast.ratioOfTones(bgTone, answer) >= desiredRatio) {
        } else {
          answer = DynamicColor.foregroundTone(bgTone, desiredRatio);
        }
        if (decreasingContrast) {
          answer = DynamicColor.foregroundTone(bgTone, desiredRatio);
        }
        if (color.isBackground && 50 <= answer && answer < 60) {
          if (Contrast.ratioOfTones(49, bgTone) >= desiredRatio) {
            answer = 49;
          } else {
            answer = 60;
          }
        }
        if (color.secondBackground == void 0 || color.secondBackground(scheme) === void 0) {
          return answer;
        }
        const [bg1, bg2] = [color.background, color.secondBackground];
        const [bgTone1, bgTone2] = [bg1(scheme).getTone(scheme), bg2(scheme).getTone(scheme)];
        const [upper, lower] = [Math.max(bgTone1, bgTone2), Math.min(bgTone1, bgTone2)];
        if (
          Contrast.ratioOfTones(upper, answer) >= desiredRatio &&
          Contrast.ratioOfTones(lower, answer) >= desiredRatio
        ) {
          return answer;
        }
        const lightOption = Contrast.lighter(upper, desiredRatio);
        const darkOption = Contrast.darker(lower, desiredRatio);
        const availables = [];
        if (lightOption !== -1) availables.push(lightOption);
        if (darkOption !== -1) availables.push(darkOption);
        const prefersLight =
          DynamicColor.tonePrefersLightForeground(bgTone1) ||
          DynamicColor.tonePrefersLightForeground(bgTone2);
        if (prefersLight) {
          return lightOption < 0 ? 100 : lightOption;
        }
        if (availables.length === 1) {
          return availables[0];
        }
        return darkOption < 0 ? 0 : darkOption;
      }
    }
  };
  var ColorCalculationDelegateImpl2025 = class {
    getHct(scheme, color) {
      const palette = color.palette(scheme);
      const tone = color.getTone(scheme);
      const hue = palette.hue;
      const chroma = palette.chroma * (color.chromaMultiplier ? color.chromaMultiplier(scheme) : 1);
      return Hct.from(hue, chroma, tone);
    }
    getTone(scheme, color) {
      const toneDeltaPair = color.toneDeltaPair ? color.toneDeltaPair(scheme) : void 0;
      if (toneDeltaPair) {
        const roleA = toneDeltaPair.roleA;
        const roleB = toneDeltaPair.roleB;
        const polarity = toneDeltaPair.polarity;
        const constraint = toneDeltaPair.constraint;
        const absoluteDelta =
          polarity === "darker" ||
          (polarity === "relative_lighter" && scheme.isDark) ||
          (polarity === "relative_darker" && !scheme.isDark)
            ? -toneDeltaPair.delta
            : toneDeltaPair.delta;
        const amRoleA = color.name === roleA.name;
        const selfRole = amRoleA ? roleA : roleB;
        const refRole = amRoleA ? roleB : roleA;
        let selfTone = selfRole.tone(scheme);
        let refTone = refRole.getTone(scheme);
        const relativeDelta = absoluteDelta * (amRoleA ? 1 : -1);
        if (constraint === "exact") {
          selfTone = clampDouble(0, 100, refTone + relativeDelta);
        } else if (constraint === "nearer") {
          if (relativeDelta > 0) {
            selfTone = clampDouble(0, 100, clampDouble(refTone, refTone + relativeDelta, selfTone));
          } else {
            selfTone = clampDouble(0, 100, clampDouble(refTone + relativeDelta, refTone, selfTone));
          }
        } else if (constraint === "farther") {
          if (relativeDelta > 0) {
            selfTone = clampDouble(refTone + relativeDelta, 100, selfTone);
          } else {
            selfTone = clampDouble(0, refTone + relativeDelta, selfTone);
          }
        }
        if (color.background && color.contrastCurve) {
          const background = color.background(scheme);
          const contrastCurve = color.contrastCurve(scheme);
          if (background && contrastCurve) {
            const bgTone = background.getTone(scheme);
            const selfContrast = contrastCurve.get(scheme.contrastLevel);
            selfTone =
              Contrast.ratioOfTones(bgTone, selfTone) >= selfContrast && scheme.contrastLevel >= 0
                ? selfTone
                : DynamicColor.foregroundTone(bgTone, selfContrast);
          }
        }
        if (color.isBackground && !color.name.endsWith("_fixed_dim")) {
          if (selfTone >= 57) {
            selfTone = clampDouble(65, 100, selfTone);
          } else {
            selfTone = clampDouble(0, 49, selfTone);
          }
        }
        return selfTone;
      } else {
        let answer = color.tone(scheme);
        if (
          color.background == void 0 ||
          color.background(scheme) === void 0 ||
          color.contrastCurve == void 0 ||
          color.contrastCurve(scheme) === void 0
        ) {
          return answer;
        }
        const bgTone = color.background(scheme).getTone(scheme);
        const desiredRatio = color.contrastCurve(scheme).get(scheme.contrastLevel);
        answer =
          Contrast.ratioOfTones(bgTone, answer) >= desiredRatio && scheme.contrastLevel >= 0
            ? answer
            : DynamicColor.foregroundTone(bgTone, desiredRatio);
        if (color.isBackground && !color.name.endsWith("_fixed_dim")) {
          if (answer >= 57) {
            answer = clampDouble(65, 100, answer);
          } else {
            answer = clampDouble(0, 49, answer);
          }
        }
        if (color.secondBackground == void 0 || color.secondBackground(scheme) === void 0) {
          return answer;
        }
        const [bg1, bg2] = [color.background, color.secondBackground];
        const [bgTone1, bgTone2] = [bg1(scheme).getTone(scheme), bg2(scheme).getTone(scheme)];
        const [upper, lower] = [Math.max(bgTone1, bgTone2), Math.min(bgTone1, bgTone2)];
        if (
          Contrast.ratioOfTones(upper, answer) >= desiredRatio &&
          Contrast.ratioOfTones(lower, answer) >= desiredRatio
        ) {
          return answer;
        }
        const lightOption = Contrast.lighter(upper, desiredRatio);
        const darkOption = Contrast.darker(lower, desiredRatio);
        const availables = [];
        if (lightOption !== -1) availables.push(lightOption);
        if (darkOption !== -1) availables.push(darkOption);
        const prefersLight =
          DynamicColor.tonePrefersLightForeground(bgTone1) ||
          DynamicColor.tonePrefersLightForeground(bgTone2);
        if (prefersLight) {
          return lightOption < 0 ? 100 : lightOption;
        }
        if (availables.length === 1) {
          return availables[0];
        }
        return darkOption < 0 ? 0 : darkOption;
      }
    }
  };
  var spec2021 = new ColorCalculationDelegateImpl2021();
  var spec2025 = new ColorCalculationDelegateImpl2025();
  function getSpec(specVersion) {
    return specVersion === "2025" ? spec2025 : spec2021;
  }

  // node_modules/@material/material-color-utilities/palettes/tonal_palette.js
  /**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  var TonalPalette = class _TonalPalette {
    /**
     * @param argb ARGB representation of a color
     * @return Tones matching that color's hue and chroma.
     */
    static fromInt(argb) {
      const hct = Hct.fromInt(argb);
      return _TonalPalette.fromHct(hct);
    }
    /**
     * @param hct Hct
     * @return Tones matching that color's hue and chroma.
     */
    static fromHct(hct) {
      return new _TonalPalette(hct.hue, hct.chroma, hct);
    }
    /**
     * @param hue HCT hue
     * @param chroma HCT chroma
     * @return Tones matching hue and chroma.
     */
    static fromHueAndChroma(hue, chroma) {
      const keyColor = new KeyColor(hue, chroma).create();
      return new _TonalPalette(hue, chroma, keyColor);
    }
    constructor(hue, chroma, keyColor) {
      this.hue = hue;
      this.chroma = chroma;
      this.keyColor = keyColor;
      this.cache = /* @__PURE__ */ new Map();
    }
    /**
     * @param tone HCT tone, measured from 0 to 100.
     * @return ARGB representation of a color with that tone.
     */
    tone(tone) {
      let argb = this.cache.get(tone);
      if (argb === void 0) {
        if (tone == 99 && Hct.isYellow(this.hue)) {
          argb = this.averageArgb(this.tone(98), this.tone(100));
        } else {
          argb = Hct.from(this.hue, this.chroma, tone).toInt();
        }
        this.cache.set(tone, argb);
      }
      return argb;
    }
    /**
     * @param tone HCT tone.
     * @return HCT representation of a color with that tone.
     */
    getHct(tone) {
      return Hct.fromInt(this.tone(tone));
    }
    averageArgb(argb1, argb2) {
      const red1 = (argb1 >>> 16) & 255;
      const green1 = (argb1 >>> 8) & 255;
      const blue1 = argb1 & 255;
      const red2 = (argb2 >>> 16) & 255;
      const green2 = (argb2 >>> 8) & 255;
      const blue2 = argb2 & 255;
      const red = Math.round((red1 + red2) / 2);
      const green = Math.round((green1 + green2) / 2);
      const blue = Math.round((blue1 + blue2) / 2);
      return ((255 << 24) | ((red & 255) << 16) | ((green & 255) << 8) | (blue & 255)) >>> 0;
    }
  };
  var KeyColor = class {
    constructor(hue, requestedChroma) {
      this.hue = hue;
      this.requestedChroma = requestedChroma;
      this.chromaCache = /* @__PURE__ */ new Map();
      this.maxChromaValue = 200;
    }
    /**
     * Creates a key color from a [hue] and a [chroma].
     * The key color is the first tone, starting from T50, matching the given hue
     * and chroma.
     *
     * @return Key color [Hct]
     */
    create() {
      const pivotTone = 50;
      const toneStepSize = 1;
      const epsilon = 0.01;
      let lowerTone = 0;
      let upperTone = 100;
      while (lowerTone < upperTone) {
        const midTone = Math.floor((lowerTone + upperTone) / 2);
        const isAscending = this.maxChroma(midTone) < this.maxChroma(midTone + toneStepSize);
        const sufficientChroma = this.maxChroma(midTone) >= this.requestedChroma - epsilon;
        if (sufficientChroma) {
          if (Math.abs(lowerTone - pivotTone) < Math.abs(upperTone - pivotTone)) {
            upperTone = midTone;
          } else {
            if (lowerTone === midTone) {
              return Hct.from(this.hue, this.requestedChroma, lowerTone);
            }
            lowerTone = midTone;
          }
        } else {
          if (isAscending) {
            lowerTone = midTone + toneStepSize;
          } else {
            upperTone = midTone;
          }
        }
      }
      return Hct.from(this.hue, this.requestedChroma, lowerTone);
    }
    // Find the maximum chroma for a given tone
    maxChroma(tone) {
      if (this.chromaCache.has(tone)) {
        return this.chromaCache.get(tone);
      }
      const chroma = Hct.from(this.hue, this.maxChromaValue, tone).chroma;
      this.chromaCache.set(tone, chroma);
      return chroma;
    }
  };

  // node_modules/@material/material-color-utilities/temperature/temperature_cache.js
  /**
   * @license
   * Copyright 2023 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  var TemperatureCache = class _TemperatureCache {
    constructor(input) {
      this.input = input;
      this.hctsByTempCache = [];
      this.hctsByHueCache = [];
      this.tempsByHctCache = /* @__PURE__ */ new Map();
      this.inputRelativeTemperatureCache = -1;
      this.complementCache = null;
    }
    get hctsByTemp() {
      if (this.hctsByTempCache.length > 0) {
        return this.hctsByTempCache;
      }
      const hcts = this.hctsByHue.concat([this.input]);
      const temperaturesByHct = this.tempsByHct;
      hcts.sort((a, b) => temperaturesByHct.get(a) - temperaturesByHct.get(b));
      this.hctsByTempCache = hcts;
      return hcts;
    }
    get warmest() {
      return this.hctsByTemp[this.hctsByTemp.length - 1];
    }
    get coldest() {
      return this.hctsByTemp[0];
    }
    /**
     * A set of colors with differing hues, equidistant in temperature.
     *
     * In art, this is usually described as a set of 5 colors on a color wheel
     * divided into 12 sections. This method allows provision of either of those
     * values.
     *
     * Behavior is undefined when [count] or [divisions] is 0.
     * When divisions < count, colors repeat.
     *
     * [count] The number of colors to return, includes the input color.
     * [divisions] The number of divisions on the color wheel.
     */
    analogous(count = 5, divisions = 12) {
      const startHue = Math.round(this.input.hue);
      const startHct = this.hctsByHue[startHue];
      let lastTemp = this.relativeTemperature(startHct);
      const allColors = [startHct];
      let absoluteTotalTempDelta = 0;
      for (let i = 0; i < 360; i++) {
        const hue = sanitizeDegreesInt(startHue + i);
        const hct = this.hctsByHue[hue];
        const temp = this.relativeTemperature(hct);
        const tempDelta = Math.abs(temp - lastTemp);
        lastTemp = temp;
        absoluteTotalTempDelta += tempDelta;
      }
      let hueAddend = 1;
      const tempStep = absoluteTotalTempDelta / divisions;
      let totalTempDelta = 0;
      lastTemp = this.relativeTemperature(startHct);
      while (allColors.length < divisions) {
        const hue = sanitizeDegreesInt(startHue + hueAddend);
        const hct = this.hctsByHue[hue];
        const temp = this.relativeTemperature(hct);
        const tempDelta = Math.abs(temp - lastTemp);
        totalTempDelta += tempDelta;
        const desiredTotalTempDeltaForIndex = allColors.length * tempStep;
        let indexSatisfied = totalTempDelta >= desiredTotalTempDeltaForIndex;
        let indexAddend = 1;
        while (indexSatisfied && allColors.length < divisions) {
          allColors.push(hct);
          const desiredTotalTempDeltaForIndex2 = (allColors.length + indexAddend) * tempStep;
          indexSatisfied = totalTempDelta >= desiredTotalTempDeltaForIndex2;
          indexAddend++;
        }
        lastTemp = temp;
        hueAddend++;
        if (hueAddend > 360) {
          while (allColors.length < divisions) {
            allColors.push(hct);
          }
          break;
        }
      }
      const answers = [this.input];
      const increaseHueCount = Math.floor((count - 1) / 2);
      for (let i = 1; i < increaseHueCount + 1; i++) {
        let index = 0 - i;
        while (index < 0) {
          index = allColors.length + index;
        }
        if (index >= allColors.length) {
          index = index % allColors.length;
        }
        answers.splice(0, 0, allColors[index]);
      }
      const decreaseHueCount = count - increaseHueCount - 1;
      for (let i = 1; i < decreaseHueCount + 1; i++) {
        let index = i;
        while (index < 0) {
          index = allColors.length + index;
        }
        if (index >= allColors.length) {
          index = index % allColors.length;
        }
        answers.push(allColors[index]);
      }
      return answers;
    }
    /**
     * A color that complements the input color aesthetically.
     *
     * In art, this is usually described as being across the color wheel.
     * History of this shows intent as a color that is just as cool-warm as the
     * input color is warm-cool.
     */
    get complement() {
      if (this.complementCache != null) {
        return this.complementCache;
      }
      const coldestHue = this.coldest.hue;
      const coldestTemp = this.tempsByHct.get(this.coldest);
      const warmestHue = this.warmest.hue;
      const warmestTemp = this.tempsByHct.get(this.warmest);
      const range = warmestTemp - coldestTemp;
      const startHueIsColdestToWarmest = _TemperatureCache.isBetween(
        this.input.hue,
        coldestHue,
        warmestHue,
      );
      const startHue = startHueIsColdestToWarmest ? warmestHue : coldestHue;
      const endHue = startHueIsColdestToWarmest ? coldestHue : warmestHue;
      const directionOfRotation = 1;
      let smallestError = 1e3;
      let answer = this.hctsByHue[Math.round(this.input.hue)];
      const complementRelativeTemp = 1 - this.inputRelativeTemperature;
      for (let hueAddend = 0; hueAddend <= 360; hueAddend += 1) {
        const hue = sanitizeDegreesDouble(startHue + directionOfRotation * hueAddend);
        if (!_TemperatureCache.isBetween(hue, startHue, endHue)) {
          continue;
        }
        const possibleAnswer = this.hctsByHue[Math.round(hue)];
        const relativeTemp = (this.tempsByHct.get(possibleAnswer) - coldestTemp) / range;
        const error = Math.abs(complementRelativeTemp - relativeTemp);
        if (error < smallestError) {
          smallestError = error;
          answer = possibleAnswer;
        }
      }
      this.complementCache = answer;
      return this.complementCache;
    }
    /**
     * Temperature relative to all colors with the same chroma and tone.
     * Value on a scale from 0 to 1.
     */
    relativeTemperature(hct) {
      const range = this.tempsByHct.get(this.warmest) - this.tempsByHct.get(this.coldest);
      const differenceFromColdest = this.tempsByHct.get(hct) - this.tempsByHct.get(this.coldest);
      if (range === 0) {
        return 0.5;
      }
      return differenceFromColdest / range;
    }
    /** Relative temperature of the input color. See [relativeTemperature]. */
    get inputRelativeTemperature() {
      if (this.inputRelativeTemperatureCache >= 0) {
        return this.inputRelativeTemperatureCache;
      }
      this.inputRelativeTemperatureCache = this.relativeTemperature(this.input);
      return this.inputRelativeTemperatureCache;
    }
    /** A Map with keys of HCTs in [hctsByTemp], values of raw temperature. */
    get tempsByHct() {
      if (this.tempsByHctCache.size > 0) {
        return this.tempsByHctCache;
      }
      const allHcts = this.hctsByHue.concat([this.input]);
      const temperaturesByHct = /* @__PURE__ */ new Map();
      for (const e of allHcts) {
        temperaturesByHct.set(e, _TemperatureCache.rawTemperature(e));
      }
      this.tempsByHctCache = temperaturesByHct;
      return temperaturesByHct;
    }
    /**
     * HCTs for all hues, with the same chroma/tone as the input.
     * Sorted ascending, hue 0 to 360.
     */
    get hctsByHue() {
      if (this.hctsByHueCache.length > 0) {
        return this.hctsByHueCache;
      }
      const hcts = [];
      for (let hue = 0; hue <= 360; hue += 1) {
        const colorAtHue = Hct.from(hue, this.input.chroma, this.input.tone);
        hcts.push(colorAtHue);
      }
      this.hctsByHueCache = hcts;
      return this.hctsByHueCache;
    }
    /** Determines if an angle is between two other angles, rotating clockwise. */
    static isBetween(angle, a, b) {
      if (a < b) {
        return a <= angle && angle <= b;
      }
      return a <= angle || angle <= b;
    }
    /**
     * Value representing cool-warm factor of a color.
     * Values below 0 are considered cool, above, warm.
     *
     * Color science has researched emotion and harmony, which art uses to select
     * colors. Warm-cool is the foundation of analogous and complementary colors.
     * See:
     * - Li-Chen Ou's Chapter 19 in Handbook of Color Psychology (2015).
     * - Josef Albers' Interaction of Color chapters 19 and 21.
     *
     * Implementation of Ou, Woodcock and Wright's algorithm, which uses
     * L*a*b* / LCH color space.
     * Return value has these properties:
     * - Values below 0 are cool, above 0 are warm.
     * - Lower bound: -0.52 - (chroma ^ 1.07 / 20). L*a*b* chroma is infinite.
     *   Assuming max of 130 chroma, -9.66.
     * - Upper bound: -0.52 + (chroma ^ 1.07 / 20). L*a*b* chroma is infinite.
     *   Assuming max of 130 chroma, 8.61.
     */
    static rawTemperature(color) {
      const lab = labFromArgb(color.toInt());
      const hue = sanitizeDegreesDouble((Math.atan2(lab[2], lab[1]) * 180) / Math.PI);
      const chroma = Math.sqrt(lab[1] * lab[1] + lab[2] * lab[2]);
      const temperature =
        -0.5 +
        0.02 * Math.pow(chroma, 1.07) * Math.cos((sanitizeDegreesDouble(hue - 50) * Math.PI) / 180);
      return temperature;
    }
  };

  // node_modules/@material/material-color-utilities/dynamiccolor/contrast_curve.js
  /**
   * @license
   * Copyright 2023 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  var ContrastCurve = class {
    /**
     * Creates a `ContrastCurve` object.
     *
     * @param low Value for contrast level -1.0
     * @param normal Value for contrast level 0.0
     * @param medium Value for contrast level 0.5
     * @param high Value for contrast level 1.0
     */
    constructor(low, normal, medium, high) {
      this.low = low;
      this.normal = normal;
      this.medium = medium;
      this.high = high;
    }
    /**
     * Returns the value at a given contrast level.
     *
     * @param contrastLevel The contrast level. 0.0 is the default (normal); -1.0
     *     is the lowest; 1.0 is the highest.
     * @return The value. For contrast ratios, a number between 1.0 and 21.0.
     */
    get(contrastLevel) {
      if (contrastLevel <= -1) {
        return this.low;
      } else if (contrastLevel < 0) {
        return lerp(this.low, this.normal, (contrastLevel - -1) / 1);
      } else if (contrastLevel < 0.5) {
        return lerp(this.normal, this.medium, (contrastLevel - 0) / 0.5);
      } else if (contrastLevel < 1) {
        return lerp(this.medium, this.high, (contrastLevel - 0.5) / 0.5);
      } else {
        return this.high;
      }
    }
  };

  // node_modules/@material/material-color-utilities/dynamiccolor/tone_delta_pair.js
  /**
   * @license
   * Copyright 2023 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  var ToneDeltaPair = class {
    /**
     * Documents a constraint in tone distance between two DynamicColors.
     *
     * The polarity is an adjective that describes "A", compared to "B".
     *
     * For instance, ToneDeltaPair(A, B, 15, 'darker', 'exact') states that
     * A's tone should be exactly 15 darker than B's.
     *
     * 'relative_darker' and 'relative_lighter' describes the tone adjustment
     * relative to the surface color trend (white in light mode; black in dark
     * mode). For instance, ToneDeltaPair(A, B, 10, 'relative_lighter',
     * 'farther') states that A should be at least 10 lighter than B in light
     * mode, and at least 10 darker than B in dark mode.
     *
     * @param roleA The first role in a pair.
     * @param roleB The second role in a pair.
     * @param delta Required difference between tones. Absolute value, negative
     * values have undefined behavior.
     * @param polarity The relative relation between tones of roleA and roleB,
     * as described above.
     * @param constraint How to fulfill the tone delta pair constraint.
     * @param stayTogether Whether these two roles should stay on the same side
     * of the "awkward zone" (T50-59). This is necessary for certain cases where
     * one role has two backgrounds.
     */
    constructor(roleA, roleB, delta, polarity, stayTogether, constraint) {
      this.roleA = roleA;
      this.roleB = roleB;
      this.delta = delta;
      this.polarity = polarity;
      this.stayTogether = stayTogether;
      this.constraint = constraint;
      this.constraint = constraint ?? "exact";
    }
  };

  // node_modules/@material/material-color-utilities/dynamiccolor/variant.js
  /**
   * @license
   * Copyright 2022 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  var Variant;
  (function (Variant2) {
    Variant2[(Variant2["MONOCHROME"] = 0)] = "MONOCHROME";
    Variant2[(Variant2["NEUTRAL"] = 1)] = "NEUTRAL";
    Variant2[(Variant2["TONAL_SPOT"] = 2)] = "TONAL_SPOT";
    Variant2[(Variant2["VIBRANT"] = 3)] = "VIBRANT";
    Variant2[(Variant2["EXPRESSIVE"] = 4)] = "EXPRESSIVE";
    Variant2[(Variant2["FIDELITY"] = 5)] = "FIDELITY";
    Variant2[(Variant2["CONTENT"] = 6)] = "CONTENT";
    Variant2[(Variant2["RAINBOW"] = 7)] = "RAINBOW";
    Variant2[(Variant2["FRUIT_SALAD"] = 8)] = "FRUIT_SALAD";
  })(Variant || (Variant = {}));

  // node_modules/@material/material-color-utilities/dynamiccolor/color_spec_2021.js
  /**
   * @license
   * Copyright 2025 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  function isFidelity(scheme) {
    return scheme.variant === Variant.FIDELITY || scheme.variant === Variant.CONTENT;
  }
  function isMonochrome(scheme) {
    return scheme.variant === Variant.MONOCHROME;
  }
  function findDesiredChromaByTone(hue, chroma, tone, byDecreasingTone) {
    let answer = tone;
    let closestToChroma = Hct.from(hue, chroma, tone);
    if (closestToChroma.chroma < chroma) {
      let chromaPeak = closestToChroma.chroma;
      while (closestToChroma.chroma < chroma) {
        answer += byDecreasingTone ? -1 : 1;
        const potentialSolution = Hct.from(hue, chroma, answer);
        if (chromaPeak > potentialSolution.chroma) {
          break;
        }
        if (Math.abs(potentialSolution.chroma - chroma) < 0.4) {
          break;
        }
        const potentialDelta = Math.abs(potentialSolution.chroma - chroma);
        const currentDelta = Math.abs(closestToChroma.chroma - chroma);
        if (potentialDelta < currentDelta) {
          closestToChroma = potentialSolution;
        }
        chromaPeak = Math.max(chromaPeak, potentialSolution.chroma);
      }
    }
    return answer;
  }
  var ColorSpecDelegateImpl2021 = class {
    ////////////////////////////////////////////////////////////////
    // Main Palettes                                              //
    ////////////////////////////////////////////////////////////////
    primaryPaletteKeyColor() {
      return DynamicColor.fromPalette({
        name: "primary_palette_key_color",
        palette: (s) => s.primaryPalette,
        tone: (s) => s.primaryPalette.keyColor.tone,
      });
    }
    secondaryPaletteKeyColor() {
      return DynamicColor.fromPalette({
        name: "secondary_palette_key_color",
        palette: (s) => s.secondaryPalette,
        tone: (s) => s.secondaryPalette.keyColor.tone,
      });
    }
    tertiaryPaletteKeyColor() {
      return DynamicColor.fromPalette({
        name: "tertiary_palette_key_color",
        palette: (s) => s.tertiaryPalette,
        tone: (s) => s.tertiaryPalette.keyColor.tone,
      });
    }
    neutralPaletteKeyColor() {
      return DynamicColor.fromPalette({
        name: "neutral_palette_key_color",
        palette: (s) => s.neutralPalette,
        tone: (s) => s.neutralPalette.keyColor.tone,
      });
    }
    neutralVariantPaletteKeyColor() {
      return DynamicColor.fromPalette({
        name: "neutral_variant_palette_key_color",
        palette: (s) => s.neutralVariantPalette,
        tone: (s) => s.neutralVariantPalette.keyColor.tone,
      });
    }
    errorPaletteKeyColor() {
      return DynamicColor.fromPalette({
        name: "error_palette_key_color",
        palette: (s) => s.errorPalette,
        tone: (s) => s.errorPalette.keyColor.tone,
      });
    }
    ////////////////////////////////////////////////////////////////
    // Surfaces [S]                                               //
    ////////////////////////////////////////////////////////////////
    background() {
      return DynamicColor.fromPalette({
        name: "background",
        palette: (s) => s.neutralPalette,
        tone: (s) => (s.isDark ? 6 : 98),
        isBackground: true,
      });
    }
    onBackground() {
      return DynamicColor.fromPalette({
        name: "on_background",
        palette: (s) => s.neutralPalette,
        tone: (s) => (s.isDark ? 90 : 10),
        background: (s) => this.background(),
        contrastCurve: (s) => new ContrastCurve(3, 3, 4.5, 7),
      });
    }
    surface() {
      return DynamicColor.fromPalette({
        name: "surface",
        palette: (s) => s.neutralPalette,
        tone: (s) => (s.isDark ? 6 : 98),
        isBackground: true,
      });
    }
    surfaceDim() {
      return DynamicColor.fromPalette({
        name: "surface_dim",
        palette: (s) => s.neutralPalette,
        tone: (s) => (s.isDark ? 6 : new ContrastCurve(87, 87, 80, 75).get(s.contrastLevel)),
        isBackground: true,
      });
    }
    surfaceBright() {
      return DynamicColor.fromPalette({
        name: "surface_bright",
        palette: (s) => s.neutralPalette,
        tone: (s) => (s.isDark ? new ContrastCurve(24, 24, 29, 34).get(s.contrastLevel) : 98),
        isBackground: true,
      });
    }
    surfaceContainerLowest() {
      return DynamicColor.fromPalette({
        name: "surface_container_lowest",
        palette: (s) => s.neutralPalette,
        tone: (s) => (s.isDark ? new ContrastCurve(4, 4, 2, 0).get(s.contrastLevel) : 100),
        isBackground: true,
      });
    }
    surfaceContainerLow() {
      return DynamicColor.fromPalette({
        name: "surface_container_low",
        palette: (s) => s.neutralPalette,
        tone: (s) =>
          s.isDark
            ? new ContrastCurve(10, 10, 11, 12).get(s.contrastLevel)
            : new ContrastCurve(96, 96, 96, 95).get(s.contrastLevel),
        isBackground: true,
      });
    }
    surfaceContainer() {
      return DynamicColor.fromPalette({
        name: "surface_container",
        palette: (s) => s.neutralPalette,
        tone: (s) =>
          s.isDark
            ? new ContrastCurve(12, 12, 16, 20).get(s.contrastLevel)
            : new ContrastCurve(94, 94, 92, 90).get(s.contrastLevel),
        isBackground: true,
      });
    }
    surfaceContainerHigh() {
      return DynamicColor.fromPalette({
        name: "surface_container_high",
        palette: (s) => s.neutralPalette,
        tone: (s) =>
          s.isDark
            ? new ContrastCurve(17, 17, 21, 25).get(s.contrastLevel)
            : new ContrastCurve(92, 92, 88, 85).get(s.contrastLevel),
        isBackground: true,
      });
    }
    surfaceContainerHighest() {
      return DynamicColor.fromPalette({
        name: "surface_container_highest",
        palette: (s) => s.neutralPalette,
        tone: (s) =>
          s.isDark
            ? new ContrastCurve(22, 22, 26, 30).get(s.contrastLevel)
            : new ContrastCurve(90, 90, 84, 80).get(s.contrastLevel),
        isBackground: true,
      });
    }
    onSurface() {
      return DynamicColor.fromPalette({
        name: "on_surface",
        palette: (s) => s.neutralPalette,
        tone: (s) => (s.isDark ? 90 : 10),
        background: (s) => this.highestSurface(s),
        contrastCurve: (s) => new ContrastCurve(4.5, 7, 11, 21),
      });
    }
    surfaceVariant() {
      return DynamicColor.fromPalette({
        name: "surface_variant",
        palette: (s) => s.neutralVariantPalette,
        tone: (s) => (s.isDark ? 30 : 90),
        isBackground: true,
      });
    }
    onSurfaceVariant() {
      return DynamicColor.fromPalette({
        name: "on_surface_variant",
        palette: (s) => s.neutralVariantPalette,
        tone: (s) => (s.isDark ? 80 : 30),
        background: (s) => this.highestSurface(s),
        contrastCurve: (s) => new ContrastCurve(3, 4.5, 7, 11),
      });
    }
    inverseSurface() {
      return DynamicColor.fromPalette({
        name: "inverse_surface",
        palette: (s) => s.neutralPalette,
        tone: (s) => (s.isDark ? 90 : 20),
        isBackground: true,
      });
    }
    inverseOnSurface() {
      return DynamicColor.fromPalette({
        name: "inverse_on_surface",
        palette: (s) => s.neutralPalette,
        tone: (s) => (s.isDark ? 20 : 95),
        background: (s) => this.inverseSurface(),
        contrastCurve: (s) => new ContrastCurve(4.5, 7, 11, 21),
      });
    }
    outline() {
      return DynamicColor.fromPalette({
        name: "outline",
        palette: (s) => s.neutralVariantPalette,
        tone: (s) => (s.isDark ? 60 : 50),
        background: (s) => this.highestSurface(s),
        contrastCurve: (s) => new ContrastCurve(1.5, 3, 4.5, 7),
      });
    }
    outlineVariant() {
      return DynamicColor.fromPalette({
        name: "outline_variant",
        palette: (s) => s.neutralVariantPalette,
        tone: (s) => (s.isDark ? 30 : 80),
        background: (s) => this.highestSurface(s),
        contrastCurve: (s) => new ContrastCurve(1, 1, 3, 4.5),
      });
    }
    shadow() {
      return DynamicColor.fromPalette({
        name: "shadow",
        palette: (s) => s.neutralPalette,
        tone: (s) => 0,
      });
    }
    scrim() {
      return DynamicColor.fromPalette({
        name: "scrim",
        palette: (s) => s.neutralPalette,
        tone: (s) => 0,
      });
    }
    surfaceTint() {
      return DynamicColor.fromPalette({
        name: "surface_tint",
        palette: (s) => s.primaryPalette,
        tone: (s) => (s.isDark ? 80 : 40),
        isBackground: true,
      });
    }
    ////////////////////////////////////////////////////////////////
    // Primary [P].                                               //
    ////////////////////////////////////////////////////////////////
    primary() {
      return DynamicColor.fromPalette({
        name: "primary",
        palette: (s) => s.primaryPalette,
        tone: (s) => {
          if (isMonochrome(s)) {
            return s.isDark ? 100 : 0;
          }
          return s.isDark ? 80 : 40;
        },
        isBackground: true,
        background: (s) => this.highestSurface(s),
        contrastCurve: (s) => new ContrastCurve(3, 4.5, 7, 7),
        toneDeltaPair: (s) =>
          new ToneDeltaPair(this.primaryContainer(), this.primary(), 10, "nearer", false),
      });
    }
    primaryDim() {
      return void 0;
    }
    onPrimary() {
      return DynamicColor.fromPalette({
        name: "on_primary",
        palette: (s) => s.primaryPalette,
        tone: (s) => {
          if (isMonochrome(s)) {
            return s.isDark ? 10 : 90;
          }
          return s.isDark ? 20 : 100;
        },
        background: (s) => this.primary(),
        contrastCurve: (s) => new ContrastCurve(4.5, 7, 11, 21),
      });
    }
    primaryContainer() {
      return DynamicColor.fromPalette({
        name: "primary_container",
        palette: (s) => s.primaryPalette,
        tone: (s) => {
          if (isFidelity(s)) {
            return s.sourceColorHct.tone;
          }
          if (isMonochrome(s)) {
            return s.isDark ? 85 : 25;
          }
          return s.isDark ? 30 : 90;
        },
        isBackground: true,
        background: (s) => this.highestSurface(s),
        contrastCurve: (s) => new ContrastCurve(1, 1, 3, 4.5),
        toneDeltaPair: (s) =>
          new ToneDeltaPair(this.primaryContainer(), this.primary(), 10, "nearer", false),
      });
    }
    onPrimaryContainer() {
      return DynamicColor.fromPalette({
        name: "on_primary_container",
        palette: (s) => s.primaryPalette,
        tone: (s) => {
          if (isFidelity(s)) {
            return DynamicColor.foregroundTone(this.primaryContainer().tone(s), 4.5);
          }
          if (isMonochrome(s)) {
            return s.isDark ? 0 : 100;
          }
          return s.isDark ? 90 : 30;
        },
        background: (s) => this.primaryContainer(),
        contrastCurve: (s) => new ContrastCurve(3, 4.5, 7, 11),
      });
    }
    inversePrimary() {
      return DynamicColor.fromPalette({
        name: "inverse_primary",
        palette: (s) => s.primaryPalette,
        tone: (s) => (s.isDark ? 40 : 80),
        background: (s) => this.inverseSurface(),
        contrastCurve: (s) => new ContrastCurve(3, 4.5, 7, 7),
      });
    }
    /////////////////////////////////////////////////////////////////
    // Secondary [Q].                                              //
    /////////////////////////////////////////////////////////////////
    secondary() {
      return DynamicColor.fromPalette({
        name: "secondary",
        palette: (s) => s.secondaryPalette,
        tone: (s) => (s.isDark ? 80 : 40),
        isBackground: true,
        background: (s) => this.highestSurface(s),
        contrastCurve: (s) => new ContrastCurve(3, 4.5, 7, 7),
        toneDeltaPair: (s) =>
          new ToneDeltaPair(this.secondaryContainer(), this.secondary(), 10, "nearer", false),
      });
    }
    secondaryDim() {
      return void 0;
    }
    onSecondary() {
      return DynamicColor.fromPalette({
        name: "on_secondary",
        palette: (s) => s.secondaryPalette,
        tone: (s) => {
          if (isMonochrome(s)) {
            return s.isDark ? 10 : 100;
          } else {
            return s.isDark ? 20 : 100;
          }
        },
        background: (s) => this.secondary(),
        contrastCurve: (s) => new ContrastCurve(4.5, 7, 11, 21),
      });
    }
    secondaryContainer() {
      return DynamicColor.fromPalette({
        name: "secondary_container",
        palette: (s) => s.secondaryPalette,
        tone: (s) => {
          const initialTone = s.isDark ? 30 : 90;
          if (isMonochrome(s)) {
            return s.isDark ? 30 : 85;
          }
          if (!isFidelity(s)) {
            return initialTone;
          }
          return findDesiredChromaByTone(
            s.secondaryPalette.hue,
            s.secondaryPalette.chroma,
            initialTone,
            s.isDark ? false : true,
          );
        },
        isBackground: true,
        background: (s) => this.highestSurface(s),
        contrastCurve: (s) => new ContrastCurve(1, 1, 3, 4.5),
        toneDeltaPair: (s) =>
          new ToneDeltaPair(this.secondaryContainer(), this.secondary(), 10, "nearer", false),
      });
    }
    onSecondaryContainer() {
      return DynamicColor.fromPalette({
        name: "on_secondary_container",
        palette: (s) => s.secondaryPalette,
        tone: (s) => {
          if (isMonochrome(s)) {
            return s.isDark ? 90 : 10;
          }
          if (!isFidelity(s)) {
            return s.isDark ? 90 : 30;
          }
          return DynamicColor.foregroundTone(this.secondaryContainer().tone(s), 4.5);
        },
        background: (s) => this.secondaryContainer(),
        contrastCurve: (s) => new ContrastCurve(3, 4.5, 7, 11),
      });
    }
    /////////////////////////////////////////////////////////////////
    // Tertiary [T].                                               //
    /////////////////////////////////////////////////////////////////
    tertiary() {
      return DynamicColor.fromPalette({
        name: "tertiary",
        palette: (s) => s.tertiaryPalette,
        tone: (s) => {
          if (isMonochrome(s)) {
            return s.isDark ? 90 : 25;
          }
          return s.isDark ? 80 : 40;
        },
        isBackground: true,
        background: (s) => this.highestSurface(s),
        contrastCurve: (s) => new ContrastCurve(3, 4.5, 7, 7),
        toneDeltaPair: (s) =>
          new ToneDeltaPair(this.tertiaryContainer(), this.tertiary(), 10, "nearer", false),
      });
    }
    tertiaryDim() {
      return void 0;
    }
    onTertiary() {
      return DynamicColor.fromPalette({
        name: "on_tertiary",
        palette: (s) => s.tertiaryPalette,
        tone: (s) => {
          if (isMonochrome(s)) {
            return s.isDark ? 10 : 90;
          }
          return s.isDark ? 20 : 100;
        },
        background: (s) => this.tertiary(),
        contrastCurve: (s) => new ContrastCurve(4.5, 7, 11, 21),
      });
    }
    tertiaryContainer() {
      return DynamicColor.fromPalette({
        name: "tertiary_container",
        palette: (s) => s.tertiaryPalette,
        tone: (s) => {
          if (isMonochrome(s)) {
            return s.isDark ? 60 : 49;
          }
          if (!isFidelity(s)) {
            return s.isDark ? 30 : 90;
          }
          const proposedHct = s.tertiaryPalette.getHct(s.sourceColorHct.tone);
          return DislikeAnalyzer.fixIfDisliked(proposedHct).tone;
        },
        isBackground: true,
        background: (s) => this.highestSurface(s),
        contrastCurve: (s) => new ContrastCurve(1, 1, 3, 4.5),
        toneDeltaPair: (s) =>
          new ToneDeltaPair(this.tertiaryContainer(), this.tertiary(), 10, "nearer", false),
      });
    }
    onTertiaryContainer() {
      return DynamicColor.fromPalette({
        name: "on_tertiary_container",
        palette: (s) => s.tertiaryPalette,
        tone: (s) => {
          if (isMonochrome(s)) {
            return s.isDark ? 0 : 100;
          }
          if (!isFidelity(s)) {
            return s.isDark ? 90 : 30;
          }
          return DynamicColor.foregroundTone(this.tertiaryContainer().tone(s), 4.5);
        },
        background: (s) => this.tertiaryContainer(),
        contrastCurve: (s) => new ContrastCurve(3, 4.5, 7, 11),
      });
    }
    //////////////////////////////////////////////////////////////////
    // Error [E].                                                   //
    //////////////////////////////////////////////////////////////////
    error() {
      return DynamicColor.fromPalette({
        name: "error",
        palette: (s) => s.errorPalette,
        tone: (s) => (s.isDark ? 80 : 40),
        isBackground: true,
        background: (s) => this.highestSurface(s),
        contrastCurve: (s) => new ContrastCurve(3, 4.5, 7, 7),
        toneDeltaPair: (s) =>
          new ToneDeltaPair(this.errorContainer(), this.error(), 10, "nearer", false),
      });
    }
    errorDim() {
      return void 0;
    }
    onError() {
      return DynamicColor.fromPalette({
        name: "on_error",
        palette: (s) => s.errorPalette,
        tone: (s) => (s.isDark ? 20 : 100),
        background: (s) => this.error(),
        contrastCurve: (s) => new ContrastCurve(4.5, 7, 11, 21),
      });
    }
    errorContainer() {
      return DynamicColor.fromPalette({
        name: "error_container",
        palette: (s) => s.errorPalette,
        tone: (s) => (s.isDark ? 30 : 90),
        isBackground: true,
        background: (s) => this.highestSurface(s),
        contrastCurve: (s) => new ContrastCurve(1, 1, 3, 4.5),
        toneDeltaPair: (s) =>
          new ToneDeltaPair(this.errorContainer(), this.error(), 10, "nearer", false),
      });
    }
    onErrorContainer() {
      return DynamicColor.fromPalette({
        name: "on_error_container",
        palette: (s) => s.errorPalette,
        tone: (s) => {
          if (isMonochrome(s)) {
            return s.isDark ? 90 : 10;
          }
          return s.isDark ? 90 : 30;
        },
        background: (s) => this.errorContainer(),
        contrastCurve: (s) => new ContrastCurve(3, 4.5, 7, 11),
      });
    }
    //////////////////////////////////////////////////////////////////
    // Primary Fixed [PF]                                           //
    //////////////////////////////////////////////////////////////////
    primaryFixed() {
      return DynamicColor.fromPalette({
        name: "primary_fixed",
        palette: (s) => s.primaryPalette,
        tone: (s) => (isMonochrome(s) ? 40 : 90),
        isBackground: true,
        background: (s) => this.highestSurface(s),
        contrastCurve: (s) => new ContrastCurve(1, 1, 3, 4.5),
        toneDeltaPair: (s) =>
          new ToneDeltaPair(this.primaryFixed(), this.primaryFixedDim(), 10, "lighter", true),
      });
    }
    primaryFixedDim() {
      return DynamicColor.fromPalette({
        name: "primary_fixed_dim",
        palette: (s) => s.primaryPalette,
        tone: (s) => (isMonochrome(s) ? 30 : 80),
        isBackground: true,
        background: (s) => this.highestSurface(s),
        contrastCurve: (s) => new ContrastCurve(1, 1, 3, 4.5),
        toneDeltaPair: (s) =>
          new ToneDeltaPair(this.primaryFixed(), this.primaryFixedDim(), 10, "lighter", true),
      });
    }
    onPrimaryFixed() {
      return DynamicColor.fromPalette({
        name: "on_primary_fixed",
        palette: (s) => s.primaryPalette,
        tone: (s) => (isMonochrome(s) ? 100 : 10),
        background: (s) => this.primaryFixedDim(),
        secondBackground: (s) => this.primaryFixed(),
        contrastCurve: (s) => new ContrastCurve(4.5, 7, 11, 21),
      });
    }
    onPrimaryFixedVariant() {
      return DynamicColor.fromPalette({
        name: "on_primary_fixed_variant",
        palette: (s) => s.primaryPalette,
        tone: (s) => (isMonochrome(s) ? 90 : 30),
        background: (s) => this.primaryFixedDim(),
        secondBackground: (s) => this.primaryFixed(),
        contrastCurve: (s) => new ContrastCurve(3, 4.5, 7, 11),
      });
    }
    ///////////////////////////////////////////////////////////////////
    // Secondary Fixed [QF]                                          //
    ///////////////////////////////////////////////////////////////////
    secondaryFixed() {
      return DynamicColor.fromPalette({
        name: "secondary_fixed",
        palette: (s) => s.secondaryPalette,
        tone: (s) => (isMonochrome(s) ? 80 : 90),
        isBackground: true,
        background: (s) => this.highestSurface(s),
        contrastCurve: (s) => new ContrastCurve(1, 1, 3, 4.5),
        toneDeltaPair: (s) =>
          new ToneDeltaPair(this.secondaryFixed(), this.secondaryFixedDim(), 10, "lighter", true),
      });
    }
    secondaryFixedDim() {
      return DynamicColor.fromPalette({
        name: "secondary_fixed_dim",
        palette: (s) => s.secondaryPalette,
        tone: (s) => (isMonochrome(s) ? 70 : 80),
        isBackground: true,
        background: (s) => this.highestSurface(s),
        contrastCurve: (s) => new ContrastCurve(1, 1, 3, 4.5),
        toneDeltaPair: (s) =>
          new ToneDeltaPair(this.secondaryFixed(), this.secondaryFixedDim(), 10, "lighter", true),
      });
    }
    onSecondaryFixed() {
      return DynamicColor.fromPalette({
        name: "on_secondary_fixed",
        palette: (s) => s.secondaryPalette,
        tone: (s) => 10,
        background: (s) => this.secondaryFixedDim(),
        secondBackground: (s) => this.secondaryFixed(),
        contrastCurve: (s) => new ContrastCurve(4.5, 7, 11, 21),
      });
    }
    onSecondaryFixedVariant() {
      return DynamicColor.fromPalette({
        name: "on_secondary_fixed_variant",
        palette: (s) => s.secondaryPalette,
        tone: (s) => (isMonochrome(s) ? 25 : 30),
        background: (s) => this.secondaryFixedDim(),
        secondBackground: (s) => this.secondaryFixed(),
        contrastCurve: (s) => new ContrastCurve(3, 4.5, 7, 11),
      });
    }
    /////////////////////////////////////////////////////////////////
    // Tertiary Fixed [TF]                                         //
    /////////////////////////////////////////////////////////////////
    tertiaryFixed() {
      return DynamicColor.fromPalette({
        name: "tertiary_fixed",
        palette: (s) => s.tertiaryPalette,
        tone: (s) => (isMonochrome(s) ? 40 : 90),
        isBackground: true,
        background: (s) => this.highestSurface(s),
        contrastCurve: (s) => new ContrastCurve(1, 1, 3, 4.5),
        toneDeltaPair: (s) =>
          new ToneDeltaPair(this.tertiaryFixed(), this.tertiaryFixedDim(), 10, "lighter", true),
      });
    }
    tertiaryFixedDim() {
      return DynamicColor.fromPalette({
        name: "tertiary_fixed_dim",
        palette: (s) => s.tertiaryPalette,
        tone: (s) => (isMonochrome(s) ? 30 : 80),
        isBackground: true,
        background: (s) => this.highestSurface(s),
        contrastCurve: (s) => new ContrastCurve(1, 1, 3, 4.5),
        toneDeltaPair: (s) =>
          new ToneDeltaPair(this.tertiaryFixed(), this.tertiaryFixedDim(), 10, "lighter", true),
      });
    }
    onTertiaryFixed() {
      return DynamicColor.fromPalette({
        name: "on_tertiary_fixed",
        palette: (s) => s.tertiaryPalette,
        tone: (s) => (isMonochrome(s) ? 100 : 10),
        background: (s) => this.tertiaryFixedDim(),
        secondBackground: (s) => this.tertiaryFixed(),
        contrastCurve: (s) => new ContrastCurve(4.5, 7, 11, 21),
      });
    }
    onTertiaryFixedVariant() {
      return DynamicColor.fromPalette({
        name: "on_tertiary_fixed_variant",
        palette: (s) => s.tertiaryPalette,
        tone: (s) => (isMonochrome(s) ? 90 : 30),
        background: (s) => this.tertiaryFixedDim(),
        secondBackground: (s) => this.tertiaryFixed(),
        contrastCurve: (s) => new ContrastCurve(3, 4.5, 7, 11),
      });
    }
    ////////////////////////////////////////////////////////////////
    // Other                                                      //
    ////////////////////////////////////////////////////////////////
    highestSurface(s) {
      return s.isDark ? this.surfaceBright() : this.surfaceDim();
    }
  };

  // node_modules/@material/material-color-utilities/dynamiccolor/color_spec_2025.js
  /**
   * @license
   * Copyright 2025 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  function tMaxC(palette, lowerBound = 0, upperBound = 100, chromaMultiplier = 1) {
    let answer = findBestToneForChroma(palette.hue, palette.chroma * chromaMultiplier, 100, true);
    return clampDouble(lowerBound, upperBound, answer);
  }
  function tMinC(palette, lowerBound = 0, upperBound = 100) {
    let answer = findBestToneForChroma(palette.hue, palette.chroma, 0, false);
    return clampDouble(lowerBound, upperBound, answer);
  }
  function findBestToneForChroma(hue, chroma, tone, byDecreasingTone) {
    let answer = tone;
    let bestCandidate = Hct.from(hue, chroma, answer);
    while (bestCandidate.chroma < chroma) {
      if (tone < 0 || tone > 100) {
        break;
      }
      tone += byDecreasingTone ? -1 : 1;
      const newCandidate = Hct.from(hue, chroma, tone);
      if (bestCandidate.chroma < newCandidate.chroma) {
        bestCandidate = newCandidate;
        answer = tone;
      }
    }
    return answer;
  }
  function getCurve(defaultContrast) {
    if (defaultContrast === 1.5) {
      return new ContrastCurve(1.5, 1.5, 3, 5.5);
    } else if (defaultContrast === 3) {
      return new ContrastCurve(3, 3, 4.5, 7);
    } else if (defaultContrast === 4.5) {
      return new ContrastCurve(4.5, 4.5, 7, 11);
    } else if (defaultContrast === 6) {
      return new ContrastCurve(6, 6, 7, 11);
    } else if (defaultContrast === 7) {
      return new ContrastCurve(7, 7, 11, 21);
    } else if (defaultContrast === 9) {
      return new ContrastCurve(9, 9, 11, 21);
    } else if (defaultContrast === 11) {
      return new ContrastCurve(11, 11, 21, 21);
    } else if (defaultContrast === 21) {
      return new ContrastCurve(21, 21, 21, 21);
    } else {
      return new ContrastCurve(defaultContrast, defaultContrast, 7, 21);
    }
  }
  var ColorSpecDelegateImpl2025 = class extends ColorSpecDelegateImpl2021 {
    ////////////////////////////////////////////////////////////////
    // Surfaces [S]                                               //
    ////////////////////////////////////////////////////////////////
    surface() {
      const color2025 = DynamicColor.fromPalette({
        name: "surface",
        palette: (s) => s.neutralPalette,
        tone: (s) => {
          super.surface().tone(s);
          if (s.platform === "phone") {
            if (s.isDark) {
              return 4;
            } else {
              if (Hct.isYellow(s.neutralPalette.hue)) {
                return 99;
              } else if (s.variant === Variant.VIBRANT) {
                return 97;
              } else {
                return 98;
              }
            }
          } else {
            return 0;
          }
        },
        isBackground: true,
      });
      return extendSpecVersion(super.surface(), "2025", color2025);
    }
    surfaceDim() {
      const color2025 = DynamicColor.fromPalette({
        name: "surface_dim",
        palette: (s) => s.neutralPalette,
        tone: (s) => {
          if (s.isDark) {
            return 4;
          } else {
            if (Hct.isYellow(s.neutralPalette.hue)) {
              return 90;
            } else if (s.variant === Variant.VIBRANT) {
              return 85;
            } else {
              return 87;
            }
          }
        },
        isBackground: true,
        chromaMultiplier: (s) => {
          if (!s.isDark) {
            if (s.variant === Variant.NEUTRAL) {
              return 2.5;
            } else if (s.variant === Variant.TONAL_SPOT) {
              return 1.7;
            } else if (s.variant === Variant.EXPRESSIVE) {
              return Hct.isYellow(s.neutralPalette.hue) ? 2.7 : 1.75;
            } else if (s.variant === Variant.VIBRANT) {
              return 1.36;
            }
          }
          return 1;
        },
      });
      return extendSpecVersion(super.surfaceDim(), "2025", color2025);
    }
    surfaceBright() {
      const color2025 = DynamicColor.fromPalette({
        name: "surface_bright",
        palette: (s) => s.neutralPalette,
        tone: (s) => {
          if (s.isDark) {
            return 18;
          } else {
            if (Hct.isYellow(s.neutralPalette.hue)) {
              return 99;
            } else if (s.variant === Variant.VIBRANT) {
              return 97;
            } else {
              return 98;
            }
          }
        },
        isBackground: true,
        chromaMultiplier: (s) => {
          if (s.isDark) {
            if (s.variant === Variant.NEUTRAL) {
              return 2.5;
            } else if (s.variant === Variant.TONAL_SPOT) {
              return 1.7;
            } else if (s.variant === Variant.EXPRESSIVE) {
              return Hct.isYellow(s.neutralPalette.hue) ? 2.7 : 1.75;
            } else if (s.variant === Variant.VIBRANT) {
              return 1.36;
            }
          }
          return 1;
        },
      });
      return extendSpecVersion(super.surfaceBright(), "2025", color2025);
    }
    surfaceContainerLowest() {
      const color2025 = DynamicColor.fromPalette({
        name: "surface_container_lowest",
        palette: (s) => s.neutralPalette,
        tone: (s) => (s.isDark ? 0 : 100),
        isBackground: true,
      });
      return extendSpecVersion(super.surfaceContainerLowest(), "2025", color2025);
    }
    surfaceContainerLow() {
      const color2025 = DynamicColor.fromPalette({
        name: "surface_container_low",
        palette: (s) => s.neutralPalette,
        tone: (s) => {
          if (s.platform === "phone") {
            if (s.isDark) {
              return 6;
            } else {
              if (Hct.isYellow(s.neutralPalette.hue)) {
                return 98;
              } else if (s.variant === Variant.VIBRANT) {
                return 95;
              } else {
                return 96;
              }
            }
          } else {
            return 15;
          }
        },
        isBackground: true,
        chromaMultiplier: (s) => {
          if (s.platform === "phone") {
            if (s.variant === Variant.NEUTRAL) {
              return 1.3;
            } else if (s.variant === Variant.TONAL_SPOT) {
              return 1.25;
            } else if (s.variant === Variant.EXPRESSIVE) {
              return Hct.isYellow(s.neutralPalette.hue) ? 1.3 : 1.15;
            } else if (s.variant === Variant.VIBRANT) {
              return 1.08;
            }
          }
          return 1;
        },
      });
      return extendSpecVersion(super.surfaceContainerLow(), "2025", color2025);
    }
    surfaceContainer() {
      const color2025 = DynamicColor.fromPalette({
        name: "surface_container",
        palette: (s) => s.neutralPalette,
        tone: (s) => {
          if (s.platform === "phone") {
            if (s.isDark) {
              return 9;
            } else {
              if (Hct.isYellow(s.neutralPalette.hue)) {
                return 96;
              } else if (s.variant === Variant.VIBRANT) {
                return 92;
              } else {
                return 94;
              }
            }
          } else {
            return 20;
          }
        },
        isBackground: true,
        chromaMultiplier: (s) => {
          if (s.platform === "phone") {
            if (s.variant === Variant.NEUTRAL) {
              return 1.6;
            } else if (s.variant === Variant.TONAL_SPOT) {
              return 1.4;
            } else if (s.variant === Variant.EXPRESSIVE) {
              return Hct.isYellow(s.neutralPalette.hue) ? 1.6 : 1.3;
            } else if (s.variant === Variant.VIBRANT) {
              return 1.15;
            }
          }
          return 1;
        },
      });
      return extendSpecVersion(super.surfaceContainer(), "2025", color2025);
    }
    surfaceContainerHigh() {
      const color2025 = DynamicColor.fromPalette({
        name: "surface_container_high",
        palette: (s) => s.neutralPalette,
        tone: (s) => {
          if (s.platform === "phone") {
            if (s.isDark) {
              return 12;
            } else {
              if (Hct.isYellow(s.neutralPalette.hue)) {
                return 94;
              } else if (s.variant === Variant.VIBRANT) {
                return 90;
              } else {
                return 92;
              }
            }
          } else {
            return 25;
          }
        },
        isBackground: true,
        chromaMultiplier: (s) => {
          if (s.platform === "phone") {
            if (s.variant === Variant.NEUTRAL) {
              return 1.9;
            } else if (s.variant === Variant.TONAL_SPOT) {
              return 1.5;
            } else if (s.variant === Variant.EXPRESSIVE) {
              return Hct.isYellow(s.neutralPalette.hue) ? 1.95 : 1.45;
            } else if (s.variant === Variant.VIBRANT) {
              return 1.22;
            }
          }
          return 1;
        },
      });
      return extendSpecVersion(super.surfaceContainerHigh(), "2025", color2025);
    }
    surfaceContainerHighest() {
      const color2025 = DynamicColor.fromPalette({
        name: "surface_container_highest",
        palette: (s) => s.neutralPalette,
        tone: (s) => {
          if (s.isDark) {
            return 15;
          } else {
            if (Hct.isYellow(s.neutralPalette.hue)) {
              return 92;
            } else if (s.variant === Variant.VIBRANT) {
              return 88;
            } else {
              return 90;
            }
          }
        },
        isBackground: true,
        chromaMultiplier: (s) => {
          if (s.variant === Variant.NEUTRAL) {
            return 2.2;
          } else if (s.variant === Variant.TONAL_SPOT) {
            return 1.7;
          } else if (s.variant === Variant.EXPRESSIVE) {
            return Hct.isYellow(s.neutralPalette.hue) ? 2.3 : 1.6;
          } else if (s.variant === Variant.VIBRANT) {
            return 1.29;
          } else {
            return 1;
          }
        },
      });
      return extendSpecVersion(super.surfaceContainerHighest(), "2025", color2025);
    }
    onSurface() {
      const color2025 = DynamicColor.fromPalette({
        name: "on_surface",
        palette: (s) => s.neutralPalette,
        tone: (s) => {
          if (s.variant === Variant.VIBRANT) {
            return tMaxC(s.neutralPalette, 0, 100, 1.1);
          } else {
            return DynamicColor.getInitialToneFromBackground((s2) =>
              s2.platform === "phone" ? this.highestSurface(s2) : this.surfaceContainerHigh(),
            )(s);
          }
        },
        chromaMultiplier: (s) => {
          if (s.platform === "phone") {
            if (s.variant === Variant.NEUTRAL) {
              return 2.2;
            } else if (s.variant === Variant.TONAL_SPOT) {
              return 1.7;
            } else if (s.variant === Variant.EXPRESSIVE) {
              return Hct.isYellow(s.neutralPalette.hue) ? (s.isDark ? 3 : 2.3) : 1.6;
            }
          }
          return 1;
        },
        background: (s) =>
          s.platform === "phone" ? this.highestSurface(s) : this.surfaceContainerHigh(),
        contrastCurve: (s) => (s.isDark && s.platform === "phone" ? getCurve(11) : getCurve(9)),
      });
      return extendSpecVersion(super.onSurface(), "2025", color2025);
    }
    onSurfaceVariant() {
      const color2025 = DynamicColor.fromPalette({
        name: "on_surface_variant",
        palette: (s) => s.neutralPalette,
        chromaMultiplier: (s) => {
          if (s.platform === "phone") {
            if (s.variant === Variant.NEUTRAL) {
              return 2.2;
            } else if (s.variant === Variant.TONAL_SPOT) {
              return 1.7;
            } else if (s.variant === Variant.EXPRESSIVE) {
              return Hct.isYellow(s.neutralPalette.hue) ? (s.isDark ? 3 : 2.3) : 1.6;
            }
          }
          return 1;
        },
        background: (s) =>
          s.platform === "phone" ? this.highestSurface(s) : this.surfaceContainerHigh(),
        contrastCurve: (s) =>
          s.platform === "phone" ? (s.isDark ? getCurve(6) : getCurve(4.5)) : getCurve(7),
      });
      return extendSpecVersion(super.onSurfaceVariant(), "2025", color2025);
    }
    outline() {
      const color2025 = DynamicColor.fromPalette({
        name: "outline",
        palette: (s) => s.neutralPalette,
        chromaMultiplier: (s) => {
          if (s.platform === "phone") {
            if (s.variant === Variant.NEUTRAL) {
              return 2.2;
            } else if (s.variant === Variant.TONAL_SPOT) {
              return 1.7;
            } else if (s.variant === Variant.EXPRESSIVE) {
              return Hct.isYellow(s.neutralPalette.hue) ? (s.isDark ? 3 : 2.3) : 1.6;
            }
          }
          return 1;
        },
        background: (s) =>
          s.platform === "phone" ? this.highestSurface(s) : this.surfaceContainerHigh(),
        contrastCurve: (s) => (s.platform === "phone" ? getCurve(3) : getCurve(4.5)),
      });
      return extendSpecVersion(super.outline(), "2025", color2025);
    }
    outlineVariant() {
      const color2025 = DynamicColor.fromPalette({
        name: "outline_variant",
        palette: (s) => s.neutralPalette,
        chromaMultiplier: (s) => {
          if (s.platform === "phone") {
            if (s.variant === Variant.NEUTRAL) {
              return 2.2;
            } else if (s.variant === Variant.TONAL_SPOT) {
              return 1.7;
            } else if (s.variant === Variant.EXPRESSIVE) {
              return Hct.isYellow(s.neutralPalette.hue) ? (s.isDark ? 3 : 2.3) : 1.6;
            }
          }
          return 1;
        },
        background: (s) =>
          s.platform === "phone" ? this.highestSurface(s) : this.surfaceContainerHigh(),
        contrastCurve: (s) => (s.platform === "phone" ? getCurve(1.5) : getCurve(3)),
      });
      return extendSpecVersion(super.outlineVariant(), "2025", color2025);
    }
    inverseSurface() {
      const color2025 = DynamicColor.fromPalette({
        name: "inverse_surface",
        palette: (s) => s.neutralPalette,
        tone: (s) => (s.isDark ? 98 : 4),
        isBackground: true,
      });
      return extendSpecVersion(super.inverseSurface(), "2025", color2025);
    }
    inverseOnSurface() {
      const color2025 = DynamicColor.fromPalette({
        name: "inverse_on_surface",
        palette: (s) => s.neutralPalette,
        background: (s) => this.inverseSurface(),
        contrastCurve: (s) => getCurve(7),
      });
      return extendSpecVersion(super.inverseOnSurface(), "2025", color2025);
    }
    ////////////////////////////////////////////////////////////////
    // Primaries [P]                                              //
    ////////////////////////////////////////////////////////////////
    primary() {
      const color2025 = DynamicColor.fromPalette({
        name: "primary",
        palette: (s) => s.primaryPalette,
        tone: (s) => {
          if (s.variant === Variant.NEUTRAL) {
            if (s.platform === "phone") {
              return s.isDark ? 80 : 40;
            } else {
              return 90;
            }
          } else if (s.variant === Variant.TONAL_SPOT) {
            if (s.platform === "phone") {
              if (s.isDark) {
                return 80;
              } else {
                return tMaxC(s.primaryPalette);
              }
            } else {
              return tMaxC(s.primaryPalette, 0, 90);
            }
          } else if (s.variant === Variant.EXPRESSIVE) {
            if (s.platform === "phone") {
              return tMaxC(
                s.primaryPalette,
                0,
                Hct.isYellow(s.primaryPalette.hue)
                  ? 25
                  : Hct.isCyan(s.primaryPalette.hue)
                    ? 88
                    : 98,
              );
            } else {
              return tMaxC(s.primaryPalette);
            }
          } else {
            if (s.platform === "phone") {
              return tMaxC(s.primaryPalette, 0, Hct.isCyan(s.primaryPalette.hue) ? 88 : 98);
            } else {
              return tMaxC(s.primaryPalette);
            }
          }
        },
        isBackground: true,
        background: (s) =>
          s.platform === "phone" ? this.highestSurface(s) : this.surfaceContainerHigh(),
        contrastCurve: (s) => (s.platform === "phone" ? getCurve(4.5) : getCurve(7)),
        toneDeltaPair: (s) =>
          s.platform === "phone"
            ? new ToneDeltaPair(
                this.primaryContainer(),
                this.primary(),
                5,
                "relative_lighter",
                true,
                "farther",
              )
            : void 0,
      });
      return extendSpecVersion(super.primary(), "2025", color2025);
    }
    primaryDim() {
      return DynamicColor.fromPalette({
        name: "primary_dim",
        palette: (s) => s.primaryPalette,
        tone: (s) => {
          if (s.variant === Variant.NEUTRAL) {
            return 85;
          } else if (s.variant === Variant.TONAL_SPOT) {
            return tMaxC(s.primaryPalette, 0, 90);
          } else {
            return tMaxC(s.primaryPalette);
          }
        },
        isBackground: true,
        background: (s) => this.surfaceContainerHigh(),
        contrastCurve: (s) => getCurve(4.5),
        toneDeltaPair: (s) =>
          new ToneDeltaPair(this.primaryDim(), this.primary(), 5, "darker", true, "farther"),
      });
    }
    onPrimary() {
      const color2025 = DynamicColor.fromPalette({
        name: "on_primary",
        palette: (s) => s.primaryPalette,
        background: (s) => (s.platform === "phone" ? this.primary() : this.primaryDim()),
        contrastCurve: (s) => (s.platform === "phone" ? getCurve(6) : getCurve(7)),
      });
      return extendSpecVersion(super.onPrimary(), "2025", color2025);
    }
    primaryContainer() {
      const color2025 = DynamicColor.fromPalette({
        name: "primary_container",
        palette: (s) => s.primaryPalette,
        tone: (s) => {
          if (s.platform === "watch") {
            return 30;
          } else if (s.variant === Variant.NEUTRAL) {
            return s.isDark ? 30 : 90;
          } else if (s.variant === Variant.TONAL_SPOT) {
            return s.isDark ? tMinC(s.primaryPalette, 35, 93) : tMaxC(s.primaryPalette, 0, 90);
          } else if (s.variant === Variant.EXPRESSIVE) {
            return s.isDark
              ? tMaxC(s.primaryPalette, 30, 93)
              : tMaxC(s.primaryPalette, 78, Hct.isCyan(s.primaryPalette.hue) ? 88 : 90);
          } else {
            return s.isDark
              ? tMinC(s.primaryPalette, 66, 93)
              : tMaxC(s.primaryPalette, 66, Hct.isCyan(s.primaryPalette.hue) ? 88 : 93);
          }
        },
        isBackground: true,
        background: (s) => (s.platform === "phone" ? this.highestSurface(s) : void 0),
        toneDeltaPair: (s) =>
          s.platform === "phone"
            ? void 0
            : new ToneDeltaPair(
                this.primaryContainer(),
                this.primaryDim(),
                10,
                "darker",
                true,
                "farther",
              ),
        contrastCurve: (s) =>
          s.platform === "phone" && s.contrastLevel > 0 ? getCurve(1.5) : void 0,
      });
      return extendSpecVersion(super.primaryContainer(), "2025", color2025);
    }
    onPrimaryContainer() {
      const color2025 = DynamicColor.fromPalette({
        name: "on_primary_container",
        palette: (s) => s.primaryPalette,
        background: (s) => this.primaryContainer(),
        contrastCurve: (s) => (s.platform === "phone" ? getCurve(6) : getCurve(7)),
      });
      return extendSpecVersion(super.onPrimaryContainer(), "2025", color2025);
    }
    primaryFixed() {
      const color2025 = DynamicColor.fromPalette({
        name: "primary_fixed",
        palette: (s) => s.primaryPalette,
        tone: (s) => {
          let tempS = Object.assign({}, s, { isDark: false, contrastLevel: 0 });
          return this.primaryContainer().getTone(tempS);
        },
        isBackground: true,
        background: (s) => (s.platform === "phone" ? this.highestSurface(s) : void 0),
        contrastCurve: (s) =>
          s.platform === "phone" && s.contrastLevel > 0 ? getCurve(1.5) : void 0,
      });
      return extendSpecVersion(super.primaryFixed(), "2025", color2025);
    }
    primaryFixedDim() {
      const color2025 = DynamicColor.fromPalette({
        name: "primary_fixed_dim",
        palette: (s) => s.primaryPalette,
        tone: (s) => this.primaryFixed().getTone(s),
        isBackground: true,
        toneDeltaPair: (s) =>
          new ToneDeltaPair(
            this.primaryFixedDim(),
            this.primaryFixed(),
            5,
            "darker",
            true,
            "exact",
          ),
      });
      return extendSpecVersion(super.primaryFixedDim(), "2025", color2025);
    }
    onPrimaryFixed() {
      const color2025 = DynamicColor.fromPalette({
        name: "on_primary_fixed",
        palette: (s) => s.primaryPalette,
        background: (s) => this.primaryFixedDim(),
        contrastCurve: (s) => getCurve(7),
      });
      return extendSpecVersion(super.onPrimaryFixed(), "2025", color2025);
    }
    onPrimaryFixedVariant() {
      const color2025 = DynamicColor.fromPalette({
        name: "on_primary_fixed_variant",
        palette: (s) => s.primaryPalette,
        background: (s) => this.primaryFixedDim(),
        contrastCurve: (s) => getCurve(4.5),
      });
      return extendSpecVersion(super.onPrimaryFixedVariant(), "2025", color2025);
    }
    inversePrimary() {
      const color2025 = DynamicColor.fromPalette({
        name: "inverse_primary",
        palette: (s) => s.primaryPalette,
        tone: (s) => tMaxC(s.primaryPalette),
        background: (s) => this.inverseSurface(),
        contrastCurve: (s) => (s.platform === "phone" ? getCurve(6) : getCurve(7)),
      });
      return extendSpecVersion(super.inversePrimary(), "2025", color2025);
    }
    ////////////////////////////////////////////////////////////////
    // Secondaries [Q]                                            //
    ////////////////////////////////////////////////////////////////
    secondary() {
      const color2025 = DynamicColor.fromPalette({
        name: "secondary",
        palette: (s) => s.secondaryPalette,
        tone: (s) => {
          if (s.platform === "watch") {
            return s.variant === Variant.NEUTRAL ? 90 : tMaxC(s.secondaryPalette, 0, 90);
          } else if (s.variant === Variant.NEUTRAL) {
            return s.isDark ? tMinC(s.secondaryPalette, 0, 98) : tMaxC(s.secondaryPalette);
          } else if (s.variant === Variant.VIBRANT) {
            return tMaxC(s.secondaryPalette, 0, s.isDark ? 90 : 98);
          } else {
            return s.isDark ? 80 : tMaxC(s.secondaryPalette);
          }
        },
        isBackground: true,
        background: (s) =>
          s.platform === "phone" ? this.highestSurface(s) : this.surfaceContainerHigh(),
        contrastCurve: (s) => (s.platform === "phone" ? getCurve(4.5) : getCurve(7)),
        toneDeltaPair: (s) =>
          s.platform === "phone"
            ? new ToneDeltaPair(
                this.secondaryContainer(),
                this.secondary(),
                5,
                "relative_lighter",
                true,
                "farther",
              )
            : void 0,
      });
      return extendSpecVersion(super.secondary(), "2025", color2025);
    }
    secondaryDim() {
      return DynamicColor.fromPalette({
        name: "secondary_dim",
        palette: (s) => s.secondaryPalette,
        tone: (s) => {
          if (s.variant === Variant.NEUTRAL) {
            return 85;
          } else {
            return tMaxC(s.secondaryPalette, 0, 90);
          }
        },
        isBackground: true,
        background: (s) => this.surfaceContainerHigh(),
        contrastCurve: (s) => getCurve(4.5),
        toneDeltaPair: (s) =>
          new ToneDeltaPair(this.secondaryDim(), this.secondary(), 5, "darker", true, "farther"),
      });
    }
    onSecondary() {
      const color2025 = DynamicColor.fromPalette({
        name: "on_secondary",
        palette: (s) => s.secondaryPalette,
        background: (s) => (s.platform === "phone" ? this.secondary() : this.secondaryDim()),
        contrastCurve: (s) => (s.platform === "phone" ? getCurve(6) : getCurve(7)),
      });
      return extendSpecVersion(super.onSecondary(), "2025", color2025);
    }
    secondaryContainer() {
      const color2025 = DynamicColor.fromPalette({
        name: "secondary_container",
        palette: (s) => s.secondaryPalette,
        tone: (s) => {
          if (s.platform === "watch") {
            return 30;
          } else if (s.variant === Variant.VIBRANT) {
            return s.isDark ? tMinC(s.secondaryPalette, 30, 40) : tMaxC(s.secondaryPalette, 84, 90);
          } else if (s.variant === Variant.EXPRESSIVE) {
            return s.isDark ? 15 : tMaxC(s.secondaryPalette, 90, 95);
          } else {
            return s.isDark ? 25 : 90;
          }
        },
        isBackground: true,
        background: (s) => (s.platform === "phone" ? this.highestSurface(s) : void 0),
        toneDeltaPair: (s) =>
          s.platform === "watch"
            ? new ToneDeltaPair(
                this.secondaryContainer(),
                this.secondaryDim(),
                10,
                "darker",
                true,
                "farther",
              )
            : void 0,
        contrastCurve: (s) =>
          s.platform === "phone" && s.contrastLevel > 0 ? getCurve(1.5) : void 0,
      });
      return extendSpecVersion(super.secondaryContainer(), "2025", color2025);
    }
    onSecondaryContainer() {
      const color2025 = DynamicColor.fromPalette({
        name: "on_secondary_container",
        palette: (s) => s.secondaryPalette,
        background: (s) => this.secondaryContainer(),
        contrastCurve: (s) => (s.platform === "phone" ? getCurve(6) : getCurve(7)),
      });
      return extendSpecVersion(super.onSecondaryContainer(), "2025", color2025);
    }
    secondaryFixed() {
      const color2025 = DynamicColor.fromPalette({
        name: "secondary_fixed",
        palette: (s) => s.secondaryPalette,
        tone: (s) => {
          let tempS = Object.assign({}, s, { isDark: false, contrastLevel: 0 });
          return this.secondaryContainer().getTone(tempS);
        },
        isBackground: true,
        background: (s) => (s.platform === "phone" ? this.highestSurface(s) : void 0),
        contrastCurve: (s) =>
          s.platform === "phone" && s.contrastLevel > 0 ? getCurve(1.5) : void 0,
      });
      return extendSpecVersion(super.secondaryFixed(), "2025", color2025);
    }
    secondaryFixedDim() {
      const color2025 = DynamicColor.fromPalette({
        name: "secondary_fixed_dim",
        palette: (s) => s.secondaryPalette,
        tone: (s) => this.secondaryFixed().getTone(s),
        isBackground: true,
        toneDeltaPair: (s) =>
          new ToneDeltaPair(
            this.secondaryFixedDim(),
            this.secondaryFixed(),
            5,
            "darker",
            true,
            "exact",
          ),
      });
      return extendSpecVersion(super.secondaryFixedDim(), "2025", color2025);
    }
    onSecondaryFixed() {
      const color2025 = DynamicColor.fromPalette({
        name: "on_secondary_fixed",
        palette: (s) => s.secondaryPalette,
        background: (s) => this.secondaryFixedDim(),
        contrastCurve: (s) => getCurve(7),
      });
      return extendSpecVersion(super.onSecondaryFixed(), "2025", color2025);
    }
    onSecondaryFixedVariant() {
      const color2025 = DynamicColor.fromPalette({
        name: "on_secondary_fixed_variant",
        palette: (s) => s.secondaryPalette,
        background: (s) => this.secondaryFixedDim(),
        contrastCurve: (s) => getCurve(4.5),
      });
      return extendSpecVersion(super.onSecondaryFixedVariant(), "2025", color2025);
    }
    ////////////////////////////////////////////////////////////////
    // Tertiaries [T]                                             //
    ////////////////////////////////////////////////////////////////
    tertiary() {
      const color2025 = DynamicColor.fromPalette({
        name: "tertiary",
        palette: (s) => s.tertiaryPalette,
        tone: (s) => {
          if (s.platform === "watch") {
            return s.variant === Variant.TONAL_SPOT
              ? tMaxC(s.tertiaryPalette, 0, 90)
              : tMaxC(s.tertiaryPalette);
          } else if (s.variant === Variant.EXPRESSIVE || s.variant === Variant.VIBRANT) {
            return tMaxC(
              s.tertiaryPalette,
              0,
              Hct.isCyan(s.tertiaryPalette.hue) ? 88 : s.isDark ? 98 : 100,
            );
          } else {
            return s.isDark ? tMaxC(s.tertiaryPalette, 0, 98) : tMaxC(s.tertiaryPalette);
          }
        },
        isBackground: true,
        background: (s) =>
          s.platform === "phone" ? this.highestSurface(s) : this.surfaceContainerHigh(),
        contrastCurve: (s) => (s.platform === "phone" ? getCurve(4.5) : getCurve(7)),
        toneDeltaPair: (s) =>
          s.platform === "phone"
            ? new ToneDeltaPair(
                this.tertiaryContainer(),
                this.tertiary(),
                5,
                "relative_lighter",
                true,
                "farther",
              )
            : void 0,
      });
      return extendSpecVersion(super.tertiary(), "2025", color2025);
    }
    tertiaryDim() {
      return DynamicColor.fromPalette({
        name: "tertiary_dim",
        palette: (s) => s.tertiaryPalette,
        tone: (s) => {
          if (s.variant === Variant.TONAL_SPOT) {
            return tMaxC(s.tertiaryPalette, 0, 90);
          } else {
            return tMaxC(s.tertiaryPalette);
          }
        },
        isBackground: true,
        background: (s) => this.surfaceContainerHigh(),
        contrastCurve: (s) => getCurve(4.5),
        toneDeltaPair: (s) =>
          new ToneDeltaPair(this.tertiaryDim(), this.tertiary(), 5, "darker", true, "farther"),
      });
    }
    onTertiary() {
      const color2025 = DynamicColor.fromPalette({
        name: "on_tertiary",
        palette: (s) => s.tertiaryPalette,
        background: (s) => (s.platform === "phone" ? this.tertiary() : this.tertiaryDim()),
        contrastCurve: (s) => (s.platform === "phone" ? getCurve(6) : getCurve(7)),
      });
      return extendSpecVersion(super.onTertiary(), "2025", color2025);
    }
    tertiaryContainer() {
      const color2025 = DynamicColor.fromPalette({
        name: "tertiary_container",
        palette: (s) => s.tertiaryPalette,
        tone: (s) => {
          if (s.platform === "watch") {
            return s.variant === Variant.TONAL_SPOT
              ? tMaxC(s.tertiaryPalette, 0, 90)
              : tMaxC(s.tertiaryPalette);
          } else {
            if (s.variant === Variant.NEUTRAL) {
              return s.isDark ? tMaxC(s.tertiaryPalette, 0, 93) : tMaxC(s.tertiaryPalette, 0, 96);
            } else if (s.variant === Variant.TONAL_SPOT) {
              return tMaxC(s.tertiaryPalette, 0, s.isDark ? 93 : 100);
            } else if (s.variant === Variant.EXPRESSIVE) {
              return tMaxC(
                s.tertiaryPalette,
                75,
                Hct.isCyan(s.tertiaryPalette.hue) ? 88 : s.isDark ? 93 : 100,
              );
            } else {
              return s.isDark ? tMaxC(s.tertiaryPalette, 0, 93) : tMaxC(s.tertiaryPalette, 72, 100);
            }
          }
        },
        isBackground: true,
        background: (s) => (s.platform === "phone" ? this.highestSurface(s) : void 0),
        toneDeltaPair: (s) =>
          s.platform === "watch"
            ? new ToneDeltaPair(
                this.tertiaryContainer(),
                this.tertiaryDim(),
                10,
                "darker",
                true,
                "farther",
              )
            : void 0,
        contrastCurve: (s) =>
          s.platform === "phone" && s.contrastLevel > 0 ? getCurve(1.5) : void 0,
      });
      return extendSpecVersion(super.tertiaryContainer(), "2025", color2025);
    }
    onTertiaryContainer() {
      const color2025 = DynamicColor.fromPalette({
        name: "on_tertiary_container",
        palette: (s) => s.tertiaryPalette,
        background: (s) => this.tertiaryContainer(),
        contrastCurve: (s) => (s.platform === "phone" ? getCurve(6) : getCurve(7)),
      });
      return extendSpecVersion(super.onTertiaryContainer(), "2025", color2025);
    }
    tertiaryFixed() {
      const color2025 = DynamicColor.fromPalette({
        name: "tertiary_fixed",
        palette: (s) => s.tertiaryPalette,
        tone: (s) => {
          let tempS = Object.assign({}, s, { isDark: false, contrastLevel: 0 });
          return this.tertiaryContainer().getTone(tempS);
        },
        isBackground: true,
        background: (s) => (s.platform === "phone" ? this.highestSurface(s) : void 0),
        contrastCurve: (s) =>
          s.platform === "phone" && s.contrastLevel > 0 ? getCurve(1.5) : void 0,
      });
      return extendSpecVersion(super.tertiaryFixed(), "2025", color2025);
    }
    tertiaryFixedDim() {
      const color2025 = DynamicColor.fromPalette({
        name: "tertiary_fixed_dim",
        palette: (s) => s.tertiaryPalette,
        tone: (s) => this.tertiaryFixed().getTone(s),
        isBackground: true,
        toneDeltaPair: (s) =>
          new ToneDeltaPair(
            this.tertiaryFixedDim(),
            this.tertiaryFixed(),
            5,
            "darker",
            true,
            "exact",
          ),
      });
      return extendSpecVersion(super.tertiaryFixedDim(), "2025", color2025);
    }
    onTertiaryFixed() {
      const color2025 = DynamicColor.fromPalette({
        name: "on_tertiary_fixed",
        palette: (s) => s.tertiaryPalette,
        background: (s) => this.tertiaryFixedDim(),
        contrastCurve: (s) => getCurve(7),
      });
      return extendSpecVersion(super.onTertiaryFixed(), "2025", color2025);
    }
    onTertiaryFixedVariant() {
      const color2025 = DynamicColor.fromPalette({
        name: "on_tertiary_fixed_variant",
        palette: (s) => s.tertiaryPalette,
        background: (s) => this.tertiaryFixedDim(),
        contrastCurve: (s) => getCurve(4.5),
      });
      return extendSpecVersion(super.onTertiaryFixedVariant(), "2025", color2025);
    }
    ////////////////////////////////////////////////////////////////
    // Errors [E]                                                 //
    ////////////////////////////////////////////////////////////////
    error() {
      const color2025 = DynamicColor.fromPalette({
        name: "error",
        palette: (s) => s.errorPalette,
        tone: (s) => {
          if (s.platform === "phone") {
            return s.isDark ? tMinC(s.errorPalette, 0, 98) : tMaxC(s.errorPalette);
          } else {
            return tMinC(s.errorPalette);
          }
        },
        isBackground: true,
        background: (s) =>
          s.platform === "phone" ? this.highestSurface(s) : this.surfaceContainerHigh(),
        contrastCurve: (s) => (s.platform === "phone" ? getCurve(4.5) : getCurve(7)),
        toneDeltaPair: (s) =>
          s.platform === "phone"
            ? new ToneDeltaPair(
                this.errorContainer(),
                this.error(),
                5,
                "relative_lighter",
                true,
                "farther",
              )
            : void 0,
      });
      return extendSpecVersion(super.error(), "2025", color2025);
    }
    errorDim() {
      return DynamicColor.fromPalette({
        name: "error_dim",
        palette: (s) => s.errorPalette,
        tone: (s) => tMinC(s.errorPalette),
        isBackground: true,
        background: (s) => this.surfaceContainerHigh(),
        contrastCurve: (s) => getCurve(4.5),
        toneDeltaPair: (s) =>
          new ToneDeltaPair(this.errorDim(), this.error(), 5, "darker", true, "farther"),
      });
    }
    onError() {
      const color2025 = DynamicColor.fromPalette({
        name: "on_error",
        palette: (s) => s.errorPalette,
        background: (s) => (s.platform === "phone" ? this.error() : this.errorDim()),
        contrastCurve: (s) => (s.platform === "phone" ? getCurve(6) : getCurve(7)),
      });
      return extendSpecVersion(super.onError(), "2025", color2025);
    }
    errorContainer() {
      const color2025 = DynamicColor.fromPalette({
        name: "error_container",
        palette: (s) => s.errorPalette,
        tone: (s) => {
          if (s.platform === "watch") {
            return 30;
          } else {
            return s.isDark ? tMinC(s.errorPalette, 30, 93) : tMaxC(s.errorPalette, 0, 90);
          }
        },
        isBackground: true,
        background: (s) => (s.platform === "phone" ? this.highestSurface(s) : void 0),
        toneDeltaPair: (s) =>
          s.platform === "watch"
            ? new ToneDeltaPair(
                this.errorContainer(),
                this.errorDim(),
                10,
                "darker",
                true,
                "farther",
              )
            : void 0,
        contrastCurve: (s) =>
          s.platform === "phone" && s.contrastLevel > 0 ? getCurve(1.5) : void 0,
      });
      return extendSpecVersion(super.errorContainer(), "2025", color2025);
    }
    onErrorContainer() {
      const color2025 = DynamicColor.fromPalette({
        name: "on_error_container",
        palette: (s) => s.errorPalette,
        background: (s) => this.errorContainer(),
        contrastCurve: (s) => (s.platform === "phone" ? getCurve(4.5) : getCurve(7)),
      });
      return extendSpecVersion(super.onErrorContainer(), "2025", color2025);
    }
    /////////////////////////////////////////////////////////////////
    // Remapped Colors                                             //
    /////////////////////////////////////////////////////////////////
    surfaceVariant() {
      const color2025 = Object.assign(this.surfaceContainerHighest().clone(), {
        name: "surface_variant",
      });
      return extendSpecVersion(super.surfaceVariant(), "2025", color2025);
    }
    surfaceTint() {
      const color2025 = Object.assign(this.primary().clone(), { name: "surface_tint" });
      return extendSpecVersion(super.surfaceTint(), "2025", color2025);
    }
    background() {
      const color2025 = Object.assign(this.surface().clone(), { name: "background" });
      return extendSpecVersion(super.background(), "2025", color2025);
    }
    onBackground() {
      const color2025 = Object.assign(this.onSurface().clone(), {
        name: "on_background",
        tone: (s) => {
          return s.platform === "watch" ? 100 : this.onSurface().getTone(s);
        },
      });
      return extendSpecVersion(super.onBackground(), "2025", color2025);
    }
  };

  // node_modules/@material/material-color-utilities/dynamiccolor/material_dynamic_colors.js
  /**
   * @license
   * Copyright 2022 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  var MaterialDynamicColors = class _MaterialDynamicColors {
    constructor() {
      this.allColors = [
        this.background(),
        this.onBackground(),
        this.surface(),
        this.surfaceDim(),
        this.surfaceBright(),
        this.surfaceContainerLowest(),
        this.surfaceContainerLow(),
        this.surfaceContainer(),
        this.surfaceContainerHigh(),
        this.surfaceContainerHighest(),
        this.onSurface(),
        this.onSurfaceVariant(),
        this.outline(),
        this.outlineVariant(),
        this.inverseSurface(),
        this.inverseOnSurface(),
        this.primary(),
        this.primaryDim(),
        this.onPrimary(),
        this.primaryContainer(),
        this.onPrimaryContainer(),
        this.primaryFixed(),
        this.primaryFixedDim(),
        this.onPrimaryFixed(),
        this.onPrimaryFixedVariant(),
        this.inversePrimary(),
        this.secondary(),
        this.secondaryDim(),
        this.onSecondary(),
        this.secondaryContainer(),
        this.onSecondaryContainer(),
        this.secondaryFixed(),
        this.secondaryFixedDim(),
        this.onSecondaryFixed(),
        this.onSecondaryFixedVariant(),
        this.tertiary(),
        this.tertiaryDim(),
        this.onTertiary(),
        this.tertiaryContainer(),
        this.onTertiaryContainer(),
        this.tertiaryFixed(),
        this.tertiaryFixedDim(),
        this.onTertiaryFixed(),
        this.onTertiaryFixedVariant(),
        this.error(),
        this.errorDim(),
        this.onError(),
        this.errorContainer(),
        this.onErrorContainer(),
      ].filter((c) => c !== void 0);
    }
    highestSurface(s) {
      return _MaterialDynamicColors.colorSpec.highestSurface(s);
    }
    ////////////////////////////////////////////////////////////////
    // Main Palettes                                              //
    ////////////////////////////////////////////////////////////////
    primaryPaletteKeyColor() {
      return _MaterialDynamicColors.colorSpec.primaryPaletteKeyColor();
    }
    secondaryPaletteKeyColor() {
      return _MaterialDynamicColors.colorSpec.secondaryPaletteKeyColor();
    }
    tertiaryPaletteKeyColor() {
      return _MaterialDynamicColors.colorSpec.tertiaryPaletteKeyColor();
    }
    neutralPaletteKeyColor() {
      return _MaterialDynamicColors.colorSpec.neutralPaletteKeyColor();
    }
    neutralVariantPaletteKeyColor() {
      return _MaterialDynamicColors.colorSpec.neutralVariantPaletteKeyColor();
    }
    errorPaletteKeyColor() {
      return _MaterialDynamicColors.colorSpec.errorPaletteKeyColor();
    }
    ////////////////////////////////////////////////////////////////
    // Surfaces [S]                                               //
    ////////////////////////////////////////////////////////////////
    background() {
      return _MaterialDynamicColors.colorSpec.background();
    }
    onBackground() {
      return _MaterialDynamicColors.colorSpec.onBackground();
    }
    surface() {
      return _MaterialDynamicColors.colorSpec.surface();
    }
    surfaceDim() {
      return _MaterialDynamicColors.colorSpec.surfaceDim();
    }
    surfaceBright() {
      return _MaterialDynamicColors.colorSpec.surfaceBright();
    }
    surfaceContainerLowest() {
      return _MaterialDynamicColors.colorSpec.surfaceContainerLowest();
    }
    surfaceContainerLow() {
      return _MaterialDynamicColors.colorSpec.surfaceContainerLow();
    }
    surfaceContainer() {
      return _MaterialDynamicColors.colorSpec.surfaceContainer();
    }
    surfaceContainerHigh() {
      return _MaterialDynamicColors.colorSpec.surfaceContainerHigh();
    }
    surfaceContainerHighest() {
      return _MaterialDynamicColors.colorSpec.surfaceContainerHighest();
    }
    onSurface() {
      return _MaterialDynamicColors.colorSpec.onSurface();
    }
    surfaceVariant() {
      return _MaterialDynamicColors.colorSpec.surfaceVariant();
    }
    onSurfaceVariant() {
      return _MaterialDynamicColors.colorSpec.onSurfaceVariant();
    }
    outline() {
      return _MaterialDynamicColors.colorSpec.outline();
    }
    outlineVariant() {
      return _MaterialDynamicColors.colorSpec.outlineVariant();
    }
    inverseSurface() {
      return _MaterialDynamicColors.colorSpec.inverseSurface();
    }
    inverseOnSurface() {
      return _MaterialDynamicColors.colorSpec.inverseOnSurface();
    }
    shadow() {
      return _MaterialDynamicColors.colorSpec.shadow();
    }
    scrim() {
      return _MaterialDynamicColors.colorSpec.scrim();
    }
    surfaceTint() {
      return _MaterialDynamicColors.colorSpec.surfaceTint();
    }
    ////////////////////////////////////////////////////////////////
    // Primaries [P]                                              //
    ////////////////////////////////////////////////////////////////
    primary() {
      return _MaterialDynamicColors.colorSpec.primary();
    }
    primaryDim() {
      return _MaterialDynamicColors.colorSpec.primaryDim();
    }
    onPrimary() {
      return _MaterialDynamicColors.colorSpec.onPrimary();
    }
    primaryContainer() {
      return _MaterialDynamicColors.colorSpec.primaryContainer();
    }
    onPrimaryContainer() {
      return _MaterialDynamicColors.colorSpec.onPrimaryContainer();
    }
    inversePrimary() {
      return _MaterialDynamicColors.colorSpec.inversePrimary();
    }
    /////////////////////////////////////////////////////////////////
    // Primary Fixed [PF]                                          //
    /////////////////////////////////////////////////////////////////
    primaryFixed() {
      return _MaterialDynamicColors.colorSpec.primaryFixed();
    }
    primaryFixedDim() {
      return _MaterialDynamicColors.colorSpec.primaryFixedDim();
    }
    onPrimaryFixed() {
      return _MaterialDynamicColors.colorSpec.onPrimaryFixed();
    }
    onPrimaryFixedVariant() {
      return _MaterialDynamicColors.colorSpec.onPrimaryFixedVariant();
    }
    ////////////////////////////////////////////////////////////////
    // Secondaries [Q]                                            //
    ////////////////////////////////////////////////////////////////
    secondary() {
      return _MaterialDynamicColors.colorSpec.secondary();
    }
    secondaryDim() {
      return _MaterialDynamicColors.colorSpec.secondaryDim();
    }
    onSecondary() {
      return _MaterialDynamicColors.colorSpec.onSecondary();
    }
    secondaryContainer() {
      return _MaterialDynamicColors.colorSpec.secondaryContainer();
    }
    onSecondaryContainer() {
      return _MaterialDynamicColors.colorSpec.onSecondaryContainer();
    }
    /////////////////////////////////////////////////////////////////
    // Secondary Fixed [QF]                                        //
    /////////////////////////////////////////////////////////////////
    secondaryFixed() {
      return _MaterialDynamicColors.colorSpec.secondaryFixed();
    }
    secondaryFixedDim() {
      return _MaterialDynamicColors.colorSpec.secondaryFixedDim();
    }
    onSecondaryFixed() {
      return _MaterialDynamicColors.colorSpec.onSecondaryFixed();
    }
    onSecondaryFixedVariant() {
      return _MaterialDynamicColors.colorSpec.onSecondaryFixedVariant();
    }
    ////////////////////////////////////////////////////////////////
    // Tertiaries [T]                                             //
    ////////////////////////////////////////////////////////////////
    tertiary() {
      return _MaterialDynamicColors.colorSpec.tertiary();
    }
    tertiaryDim() {
      return _MaterialDynamicColors.colorSpec.tertiaryDim();
    }
    onTertiary() {
      return _MaterialDynamicColors.colorSpec.onTertiary();
    }
    tertiaryContainer() {
      return _MaterialDynamicColors.colorSpec.tertiaryContainer();
    }
    onTertiaryContainer() {
      return _MaterialDynamicColors.colorSpec.onTertiaryContainer();
    }
    /////////////////////////////////////////////////////////////////
    // Tertiary Fixed [TF]                                         //
    /////////////////////////////////////////////////////////////////
    tertiaryFixed() {
      return _MaterialDynamicColors.colorSpec.tertiaryFixed();
    }
    tertiaryFixedDim() {
      return _MaterialDynamicColors.colorSpec.tertiaryFixedDim();
    }
    onTertiaryFixed() {
      return _MaterialDynamicColors.colorSpec.onTertiaryFixed();
    }
    onTertiaryFixedVariant() {
      return _MaterialDynamicColors.colorSpec.onTertiaryFixedVariant();
    }
    ////////////////////////////////////////////////////////////////
    // Errors [E]                                                 //
    ////////////////////////////////////////////////////////////////
    error() {
      return _MaterialDynamicColors.colorSpec.error();
    }
    errorDim() {
      return _MaterialDynamicColors.colorSpec.errorDim();
    }
    onError() {
      return _MaterialDynamicColors.colorSpec.onError();
    }
    errorContainer() {
      return _MaterialDynamicColors.colorSpec.errorContainer();
    }
    onErrorContainer() {
      return _MaterialDynamicColors.colorSpec.onErrorContainer();
    }
    // Static variables are deprecated. Use the instance methods to get correct
    // specs based on request.
    /** @deprecated Use highestSurface() instead. */
    static highestSurface(s) {
      return _MaterialDynamicColors.colorSpec.highestSurface(s);
    }
  };
  MaterialDynamicColors.contentAccentToneDelta = 15;
  MaterialDynamicColors.colorSpec = new ColorSpecDelegateImpl2025();
  MaterialDynamicColors.primaryPaletteKeyColor =
    MaterialDynamicColors.colorSpec.primaryPaletteKeyColor();
  MaterialDynamicColors.secondaryPaletteKeyColor =
    MaterialDynamicColors.colorSpec.secondaryPaletteKeyColor();
  MaterialDynamicColors.tertiaryPaletteKeyColor =
    MaterialDynamicColors.colorSpec.tertiaryPaletteKeyColor();
  MaterialDynamicColors.neutralPaletteKeyColor =
    MaterialDynamicColors.colorSpec.neutralPaletteKeyColor();
  MaterialDynamicColors.neutralVariantPaletteKeyColor =
    MaterialDynamicColors.colorSpec.neutralVariantPaletteKeyColor();
  MaterialDynamicColors.background = MaterialDynamicColors.colorSpec.background();
  MaterialDynamicColors.onBackground = MaterialDynamicColors.colorSpec.onBackground();
  MaterialDynamicColors.surface = MaterialDynamicColors.colorSpec.surface();
  MaterialDynamicColors.surfaceDim = MaterialDynamicColors.colorSpec.surfaceDim();
  MaterialDynamicColors.surfaceBright = MaterialDynamicColors.colorSpec.surfaceBright();
  MaterialDynamicColors.surfaceContainerLowest =
    MaterialDynamicColors.colorSpec.surfaceContainerLowest();
  MaterialDynamicColors.surfaceContainerLow = MaterialDynamicColors.colorSpec.surfaceContainerLow();
  MaterialDynamicColors.surfaceContainer = MaterialDynamicColors.colorSpec.surfaceContainer();
  MaterialDynamicColors.surfaceContainerHigh =
    MaterialDynamicColors.colorSpec.surfaceContainerHigh();
  MaterialDynamicColors.surfaceContainerHighest =
    MaterialDynamicColors.colorSpec.surfaceContainerHighest();
  MaterialDynamicColors.onSurface = MaterialDynamicColors.colorSpec.onSurface();
  MaterialDynamicColors.surfaceVariant = MaterialDynamicColors.colorSpec.surfaceVariant();
  MaterialDynamicColors.onSurfaceVariant = MaterialDynamicColors.colorSpec.onSurfaceVariant();
  MaterialDynamicColors.inverseSurface = MaterialDynamicColors.colorSpec.inverseSurface();
  MaterialDynamicColors.inverseOnSurface = MaterialDynamicColors.colorSpec.inverseOnSurface();
  MaterialDynamicColors.outline = MaterialDynamicColors.colorSpec.outline();
  MaterialDynamicColors.outlineVariant = MaterialDynamicColors.colorSpec.outlineVariant();
  MaterialDynamicColors.shadow = MaterialDynamicColors.colorSpec.shadow();
  MaterialDynamicColors.scrim = MaterialDynamicColors.colorSpec.scrim();
  MaterialDynamicColors.surfaceTint = MaterialDynamicColors.colorSpec.surfaceTint();
  MaterialDynamicColors.primary = MaterialDynamicColors.colorSpec.primary();
  MaterialDynamicColors.onPrimary = MaterialDynamicColors.colorSpec.onPrimary();
  MaterialDynamicColors.primaryContainer = MaterialDynamicColors.colorSpec.primaryContainer();
  MaterialDynamicColors.onPrimaryContainer = MaterialDynamicColors.colorSpec.onPrimaryContainer();
  MaterialDynamicColors.inversePrimary = MaterialDynamicColors.colorSpec.inversePrimary();
  MaterialDynamicColors.secondary = MaterialDynamicColors.colorSpec.secondary();
  MaterialDynamicColors.onSecondary = MaterialDynamicColors.colorSpec.onSecondary();
  MaterialDynamicColors.secondaryContainer = MaterialDynamicColors.colorSpec.secondaryContainer();
  MaterialDynamicColors.onSecondaryContainer =
    MaterialDynamicColors.colorSpec.onSecondaryContainer();
  MaterialDynamicColors.tertiary = MaterialDynamicColors.colorSpec.tertiary();
  MaterialDynamicColors.onTertiary = MaterialDynamicColors.colorSpec.onTertiary();
  MaterialDynamicColors.tertiaryContainer = MaterialDynamicColors.colorSpec.tertiaryContainer();
  MaterialDynamicColors.onTertiaryContainer = MaterialDynamicColors.colorSpec.onTertiaryContainer();
  MaterialDynamicColors.error = MaterialDynamicColors.colorSpec.error();
  MaterialDynamicColors.onError = MaterialDynamicColors.colorSpec.onError();
  MaterialDynamicColors.errorContainer = MaterialDynamicColors.colorSpec.errorContainer();
  MaterialDynamicColors.onErrorContainer = MaterialDynamicColors.colorSpec.onErrorContainer();
  MaterialDynamicColors.primaryFixed = MaterialDynamicColors.colorSpec.primaryFixed();
  MaterialDynamicColors.primaryFixedDim = MaterialDynamicColors.colorSpec.primaryFixedDim();
  MaterialDynamicColors.onPrimaryFixed = MaterialDynamicColors.colorSpec.onPrimaryFixed();
  MaterialDynamicColors.onPrimaryFixedVariant =
    MaterialDynamicColors.colorSpec.onPrimaryFixedVariant();
  MaterialDynamicColors.secondaryFixed = MaterialDynamicColors.colorSpec.secondaryFixed();
  MaterialDynamicColors.secondaryFixedDim = MaterialDynamicColors.colorSpec.secondaryFixedDim();
  MaterialDynamicColors.onSecondaryFixed = MaterialDynamicColors.colorSpec.onSecondaryFixed();
  MaterialDynamicColors.onSecondaryFixedVariant =
    MaterialDynamicColors.colorSpec.onSecondaryFixedVariant();
  MaterialDynamicColors.tertiaryFixed = MaterialDynamicColors.colorSpec.tertiaryFixed();
  MaterialDynamicColors.tertiaryFixedDim = MaterialDynamicColors.colorSpec.tertiaryFixedDim();
  MaterialDynamicColors.onTertiaryFixed = MaterialDynamicColors.colorSpec.onTertiaryFixed();
  MaterialDynamicColors.onTertiaryFixedVariant =
    MaterialDynamicColors.colorSpec.onTertiaryFixedVariant();

  // node_modules/@material/material-color-utilities/dynamiccolor/dynamic_scheme.js
  /**
   * @license
   * Copyright 2022 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  var DynamicScheme = class _DynamicScheme {
    static maybeFallbackSpecVersion(specVersion, variant) {
      switch (variant) {
        case Variant.EXPRESSIVE:
        case Variant.VIBRANT:
        case Variant.TONAL_SPOT:
        case Variant.NEUTRAL:
          return specVersion;
        default:
          return "2021";
      }
    }
    constructor(args) {
      this.sourceColorArgb = args.sourceColorHct.toInt();
      this.variant = args.variant;
      this.contrastLevel = args.contrastLevel;
      this.isDark = args.isDark;
      this.platform = args.platform ?? "phone";
      this.specVersion = _DynamicScheme.maybeFallbackSpecVersion(
        args.specVersion ?? "2021",
        this.variant,
      );
      this.sourceColorHct = args.sourceColorHct;
      this.primaryPalette =
        args.primaryPalette ??
        getSpec2(this.specVersion).getPrimaryPalette(
          this.variant,
          args.sourceColorHct,
          this.isDark,
          this.platform,
          this.contrastLevel,
        );
      this.secondaryPalette =
        args.secondaryPalette ??
        getSpec2(this.specVersion).getSecondaryPalette(
          this.variant,
          args.sourceColorHct,
          this.isDark,
          this.platform,
          this.contrastLevel,
        );
      this.tertiaryPalette =
        args.tertiaryPalette ??
        getSpec2(this.specVersion).getTertiaryPalette(
          this.variant,
          args.sourceColorHct,
          this.isDark,
          this.platform,
          this.contrastLevel,
        );
      this.neutralPalette =
        args.neutralPalette ??
        getSpec2(this.specVersion).getNeutralPalette(
          this.variant,
          args.sourceColorHct,
          this.isDark,
          this.platform,
          this.contrastLevel,
        );
      this.neutralVariantPalette =
        args.neutralVariantPalette ??
        getSpec2(this.specVersion).getNeutralVariantPalette(
          this.variant,
          args.sourceColorHct,
          this.isDark,
          this.platform,
          this.contrastLevel,
        );
      this.errorPalette =
        args.errorPalette ??
        getSpec2(this.specVersion).getErrorPalette(
          this.variant,
          args.sourceColorHct,
          this.isDark,
          this.platform,
          this.contrastLevel,
        ) ??
        TonalPalette.fromHueAndChroma(25, 84);
      this.colors = new MaterialDynamicColors();
    }
    toString() {
      return `Scheme: variant=${Variant[this.variant]}, mode=${this.isDark ? "dark" : "light"}, platform=${this.platform}, contrastLevel=${this.contrastLevel.toFixed(1)}, seed=${this.sourceColorHct.toString()}, specVersion=${this.specVersion}`;
    }
    /**
     * Returns a new hue based on a piecewise function and input color hue.
     *
     * For example, for the following function:
     * result = 26 if 0 <= hue < 101
     * result = 39 if 101 <= hue < 210
     * result = 28 if 210 <= hue < 360
     *
     * call the function as:
     *
     * const hueBreakpoints = [0, 101, 210, 360];
     * const hues = [26, 39, 28];
     * const result = scheme.piecewise(hue, hueBreakpoints, hues);
     *
     * @param sourceColorHct The input value.
     * @param hueBreakpoints The breakpoints, in sorted order. No default lower or
     *     upper bounds are assumed.
     * @param hues The hues that should be applied when source color's hue is >=
     *     the same index in hueBrakpoints array, and < the hue at the next index
     *     in hueBrakpoints array. Otherwise, the source color's hue is returned.
     */
    static getPiecewiseHue(sourceColorHct, hueBreakpoints, hues) {
      const size = Math.min(hueBreakpoints.length - 1, hues.length);
      const sourceHue = sourceColorHct.hue;
      for (let i = 0; i < size; i++) {
        if (sourceHue >= hueBreakpoints[i] && sourceHue < hueBreakpoints[i + 1]) {
          return sanitizeDegreesDouble(hues[i]);
        }
      }
      return sourceHue;
    }
    /**
     * Returns a shifted hue based on a piecewise function and input color hue.
     *
     * For example, for the following function:
     * result = hue + 26 if 0 <= hue < 101
     * result = hue - 39 if 101 <= hue < 210
     * result = hue + 28 if 210 <= hue < 360
     *
     * call the function as:
     *
     * const hueBreakpoints = [0, 101, 210, 360];
     * const hues = [26, -39, 28];
     * const result = scheme.getRotatedHue(hue, hueBreakpoints, hues);
     *
     * @param sourceColorHct the source color of the theme, in HCT.
     * @param hueBreakpoints The "breakpoints", i.e. the hues at which a rotation
     *     should be apply. No default lower or upper bounds are assumed.
     * @param rotations The rotation that should be applied when source color's
     *     hue is >= the same index in hues array, and < the hue at the next
     *     index in hues array. Otherwise, the source color's hue is returned.
     */
    static getRotatedHue(sourceColorHct, hueBreakpoints, rotations) {
      let rotation = _DynamicScheme.getPiecewiseHue(sourceColorHct, hueBreakpoints, rotations);
      if (Math.min(hueBreakpoints.length - 1, rotations.length) <= 0) {
        rotation = 0;
      }
      return sanitizeDegreesDouble(sourceColorHct.hue + rotation);
    }
    getArgb(dynamicColor) {
      return dynamicColor.getArgb(this);
    }
    getHct(dynamicColor) {
      return dynamicColor.getHct(this);
    }
    // Palette key colors
    get primaryPaletteKeyColor() {
      return this.getArgb(this.colors.primaryPaletteKeyColor());
    }
    get secondaryPaletteKeyColor() {
      return this.getArgb(this.colors.secondaryPaletteKeyColor());
    }
    get tertiaryPaletteKeyColor() {
      return this.getArgb(this.colors.tertiaryPaletteKeyColor());
    }
    get neutralPaletteKeyColor() {
      return this.getArgb(this.colors.neutralPaletteKeyColor());
    }
    get neutralVariantPaletteKeyColor() {
      return this.getArgb(this.colors.neutralVariantPaletteKeyColor());
    }
    get errorPaletteKeyColor() {
      return this.getArgb(this.colors.errorPaletteKeyColor());
    }
    // Surface colors
    get background() {
      return this.getArgb(this.colors.background());
    }
    get onBackground() {
      return this.getArgb(this.colors.onBackground());
    }
    get surface() {
      return this.getArgb(this.colors.surface());
    }
    get surfaceDim() {
      return this.getArgb(this.colors.surfaceDim());
    }
    get surfaceBright() {
      return this.getArgb(this.colors.surfaceBright());
    }
    get surfaceContainerLowest() {
      return this.getArgb(this.colors.surfaceContainerLowest());
    }
    get surfaceContainerLow() {
      return this.getArgb(this.colors.surfaceContainerLow());
    }
    get surfaceContainer() {
      return this.getArgb(this.colors.surfaceContainer());
    }
    get surfaceContainerHigh() {
      return this.getArgb(this.colors.surfaceContainerHigh());
    }
    get surfaceContainerHighest() {
      return this.getArgb(this.colors.surfaceContainerHighest());
    }
    get onSurface() {
      return this.getArgb(this.colors.onSurface());
    }
    get surfaceVariant() {
      return this.getArgb(this.colors.surfaceVariant());
    }
    get onSurfaceVariant() {
      return this.getArgb(this.colors.onSurfaceVariant());
    }
    get inverseSurface() {
      return this.getArgb(this.colors.inverseSurface());
    }
    get inverseOnSurface() {
      return this.getArgb(this.colors.inverseOnSurface());
    }
    get outline() {
      return this.getArgb(this.colors.outline());
    }
    get outlineVariant() {
      return this.getArgb(this.colors.outlineVariant());
    }
    get shadow() {
      return this.getArgb(this.colors.shadow());
    }
    get scrim() {
      return this.getArgb(this.colors.scrim());
    }
    get surfaceTint() {
      return this.getArgb(this.colors.surfaceTint());
    }
    // Primary colors
    get primary() {
      return this.getArgb(this.colors.primary());
    }
    get primaryDim() {
      const primaryDim = this.colors.primaryDim();
      if (primaryDim === void 0) {
        throw new Error("`primaryDim` color is undefined prior to 2025 spec.");
      }
      return this.getArgb(primaryDim);
    }
    get onPrimary() {
      return this.getArgb(this.colors.onPrimary());
    }
    get primaryContainer() {
      return this.getArgb(this.colors.primaryContainer());
    }
    get onPrimaryContainer() {
      return this.getArgb(this.colors.onPrimaryContainer());
    }
    get primaryFixed() {
      return this.getArgb(this.colors.primaryFixed());
    }
    get primaryFixedDim() {
      return this.getArgb(this.colors.primaryFixedDim());
    }
    get onPrimaryFixed() {
      return this.getArgb(this.colors.onPrimaryFixed());
    }
    get onPrimaryFixedVariant() {
      return this.getArgb(this.colors.onPrimaryFixedVariant());
    }
    get inversePrimary() {
      return this.getArgb(this.colors.inversePrimary());
    }
    // Secondary colors
    get secondary() {
      return this.getArgb(this.colors.secondary());
    }
    get secondaryDim() {
      const secondaryDim = this.colors.secondaryDim();
      if (secondaryDim === void 0) {
        throw new Error("`secondaryDim` color is undefined prior to 2025 spec.");
      }
      return this.getArgb(secondaryDim);
    }
    get onSecondary() {
      return this.getArgb(this.colors.onSecondary());
    }
    get secondaryContainer() {
      return this.getArgb(this.colors.secondaryContainer());
    }
    get onSecondaryContainer() {
      return this.getArgb(this.colors.onSecondaryContainer());
    }
    get secondaryFixed() {
      return this.getArgb(this.colors.secondaryFixed());
    }
    get secondaryFixedDim() {
      return this.getArgb(this.colors.secondaryFixedDim());
    }
    get onSecondaryFixed() {
      return this.getArgb(this.colors.onSecondaryFixed());
    }
    get onSecondaryFixedVariant() {
      return this.getArgb(this.colors.onSecondaryFixedVariant());
    }
    // Tertiary colors
    get tertiary() {
      return this.getArgb(this.colors.tertiary());
    }
    get tertiaryDim() {
      const tertiaryDim = this.colors.tertiaryDim();
      if (tertiaryDim === void 0) {
        throw new Error("`tertiaryDim` color is undefined prior to 2025 spec.");
      }
      return this.getArgb(tertiaryDim);
    }
    get onTertiary() {
      return this.getArgb(this.colors.onTertiary());
    }
    get tertiaryContainer() {
      return this.getArgb(this.colors.tertiaryContainer());
    }
    get onTertiaryContainer() {
      return this.getArgb(this.colors.onTertiaryContainer());
    }
    get tertiaryFixed() {
      return this.getArgb(this.colors.tertiaryFixed());
    }
    get tertiaryFixedDim() {
      return this.getArgb(this.colors.tertiaryFixedDim());
    }
    get onTertiaryFixed() {
      return this.getArgb(this.colors.onTertiaryFixed());
    }
    get onTertiaryFixedVariant() {
      return this.getArgb(this.colors.onTertiaryFixedVariant());
    }
    // Error colors
    get error() {
      return this.getArgb(this.colors.error());
    }
    get errorDim() {
      const errorDim = this.colors.errorDim();
      if (errorDim === void 0) {
        throw new Error("`errorDim` color is undefined prior to 2025 spec.");
      }
      return this.getArgb(errorDim);
    }
    get onError() {
      return this.getArgb(this.colors.onError());
    }
    get errorContainer() {
      return this.getArgb(this.colors.errorContainer());
    }
    get onErrorContainer() {
      return this.getArgb(this.colors.onErrorContainer());
    }
  };
  DynamicScheme.DEFAULT_SPEC_VERSION = "2021";
  DynamicScheme.DEFAULT_PLATFORM = "phone";
  var DynamicSchemePalettesDelegateImpl2021 = class {
    //////////////////////////////////////////////////////////////////
    // Scheme Palettes                                              //
    //////////////////////////////////////////////////////////////////
    getPrimaryPalette(variant, sourceColorHct, isDark, platform, contrastLevel) {
      switch (variant) {
        case Variant.CONTENT:
        case Variant.FIDELITY:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, sourceColorHct.chroma);
        case Variant.FRUIT_SALAD:
          return TonalPalette.fromHueAndChroma(sanitizeDegreesDouble(sourceColorHct.hue - 50), 48);
        case Variant.MONOCHROME:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, 0);
        case Variant.NEUTRAL:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, 12);
        case Variant.RAINBOW:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, 48);
        case Variant.TONAL_SPOT:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, 36);
        case Variant.EXPRESSIVE:
          return TonalPalette.fromHueAndChroma(sanitizeDegreesDouble(sourceColorHct.hue + 240), 40);
        case Variant.VIBRANT:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, 200);
        default:
          throw new Error(`Unsupported variant: ${variant}`);
      }
    }
    getSecondaryPalette(variant, sourceColorHct, isDark, platform, contrastLevel) {
      switch (variant) {
        case Variant.CONTENT:
        case Variant.FIDELITY:
          return TonalPalette.fromHueAndChroma(
            sourceColorHct.hue,
            Math.max(sourceColorHct.chroma - 32, sourceColorHct.chroma * 0.5),
          );
        case Variant.FRUIT_SALAD:
          return TonalPalette.fromHueAndChroma(sanitizeDegreesDouble(sourceColorHct.hue - 50), 36);
        case Variant.MONOCHROME:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, 0);
        case Variant.NEUTRAL:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, 8);
        case Variant.RAINBOW:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, 16);
        case Variant.TONAL_SPOT:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, 16);
        case Variant.EXPRESSIVE:
          return TonalPalette.fromHueAndChroma(
            DynamicScheme.getRotatedHue(
              sourceColorHct,
              [0, 21, 51, 121, 151, 191, 271, 321, 360],
              [45, 95, 45, 20, 45, 90, 45, 45, 45],
            ),
            24,
          );
        case Variant.VIBRANT:
          return TonalPalette.fromHueAndChroma(
            DynamicScheme.getRotatedHue(
              sourceColorHct,
              [0, 41, 61, 101, 131, 181, 251, 301, 360],
              [18, 15, 10, 12, 15, 18, 15, 12, 12],
            ),
            24,
          );
        default:
          throw new Error(`Unsupported variant: ${variant}`);
      }
    }
    getTertiaryPalette(variant, sourceColorHct, isDark, platform, contrastLevel) {
      switch (variant) {
        case Variant.CONTENT:
          return TonalPalette.fromHct(
            DislikeAnalyzer.fixIfDisliked(
              new TemperatureCache(sourceColorHct).analogous(
                /* count= */
                3,
                /* divisions= */
                6,
              )[2],
            ),
          );
        case Variant.FIDELITY:
          return TonalPalette.fromHct(
            DislikeAnalyzer.fixIfDisliked(new TemperatureCache(sourceColorHct).complement),
          );
        case Variant.FRUIT_SALAD:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, 36);
        case Variant.MONOCHROME:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, 0);
        case Variant.NEUTRAL:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, 16);
        case Variant.RAINBOW:
        case Variant.TONAL_SPOT:
          return TonalPalette.fromHueAndChroma(sanitizeDegreesDouble(sourceColorHct.hue + 60), 24);
        case Variant.EXPRESSIVE:
          return TonalPalette.fromHueAndChroma(
            DynamicScheme.getRotatedHue(
              sourceColorHct,
              [0, 21, 51, 121, 151, 191, 271, 321, 360],
              [120, 120, 20, 45, 20, 15, 20, 120, 120],
            ),
            32,
          );
        case Variant.VIBRANT:
          return TonalPalette.fromHueAndChroma(
            DynamicScheme.getRotatedHue(
              sourceColorHct,
              [0, 41, 61, 101, 131, 181, 251, 301, 360],
              [35, 30, 20, 25, 30, 35, 30, 25, 25],
            ),
            32,
          );
        default:
          throw new Error(`Unsupported variant: ${variant}`);
      }
    }
    getNeutralPalette(variant, sourceColorHct, isDark, platform, contrastLevel) {
      switch (variant) {
        case Variant.CONTENT:
        case Variant.FIDELITY:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, sourceColorHct.chroma / 8);
        case Variant.FRUIT_SALAD:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, 10);
        case Variant.MONOCHROME:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, 0);
        case Variant.NEUTRAL:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, 2);
        case Variant.RAINBOW:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, 0);
        case Variant.TONAL_SPOT:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, 6);
        case Variant.EXPRESSIVE:
          return TonalPalette.fromHueAndChroma(sanitizeDegreesDouble(sourceColorHct.hue + 15), 8);
        case Variant.VIBRANT:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, 10);
        default:
          throw new Error(`Unsupported variant: ${variant}`);
      }
    }
    getNeutralVariantPalette(variant, sourceColorHct, isDark, platform, contrastLevel) {
      switch (variant) {
        case Variant.CONTENT:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, sourceColorHct.chroma / 8 + 4);
        case Variant.FIDELITY:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, sourceColorHct.chroma / 8 + 4);
        case Variant.FRUIT_SALAD:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, 16);
        case Variant.MONOCHROME:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, 0);
        case Variant.NEUTRAL:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, 2);
        case Variant.RAINBOW:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, 0);
        case Variant.TONAL_SPOT:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, 8);
        case Variant.EXPRESSIVE:
          return TonalPalette.fromHueAndChroma(sanitizeDegreesDouble(sourceColorHct.hue + 15), 12);
        case Variant.VIBRANT:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, 12);
        default:
          throw new Error(`Unsupported variant: ${variant}`);
      }
    }
    getErrorPalette(variant, sourceColorHct, isDark, platform, contrastLevel) {
      return void 0;
    }
  };
  var DynamicSchemePalettesDelegateImpl2025 = class _DynamicSchemePalettesDelegateImpl2025 extends DynamicSchemePalettesDelegateImpl2021 {
    //////////////////////////////////////////////////////////////////
    // Scheme Palettes                                              //
    //////////////////////////////////////////////////////////////////
    getPrimaryPalette(variant, sourceColorHct, isDark, platform, contrastLevel) {
      switch (variant) {
        case Variant.NEUTRAL:
          return TonalPalette.fromHueAndChroma(
            sourceColorHct.hue,
            platform === "phone"
              ? Hct.isBlue(sourceColorHct.hue)
                ? 12
                : 8
              : Hct.isBlue(sourceColorHct.hue)
                ? 16
                : 12,
          );
        case Variant.TONAL_SPOT:
          return TonalPalette.fromHueAndChroma(
            sourceColorHct.hue,
            platform === "phone" && isDark ? 26 : 32,
          );
        case Variant.EXPRESSIVE:
          return TonalPalette.fromHueAndChroma(
            sourceColorHct.hue,
            platform === "phone" ? (isDark ? 36 : 48) : 40,
          );
        case Variant.VIBRANT:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, platform === "phone" ? 74 : 56);
        default:
          return super.getPrimaryPalette(variant, sourceColorHct, isDark, platform, contrastLevel);
      }
    }
    getSecondaryPalette(variant, sourceColorHct, isDark, platform, contrastLevel) {
      switch (variant) {
        case Variant.NEUTRAL:
          return TonalPalette.fromHueAndChroma(
            sourceColorHct.hue,
            platform === "phone"
              ? Hct.isBlue(sourceColorHct.hue)
                ? 6
                : 4
              : Hct.isBlue(sourceColorHct.hue)
                ? 10
                : 6,
          );
        case Variant.TONAL_SPOT:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, 16);
        case Variant.EXPRESSIVE:
          return TonalPalette.fromHueAndChroma(
            DynamicScheme.getRotatedHue(
              sourceColorHct,
              [0, 105, 140, 204, 253, 278, 300, 333, 360],
              [-160, 155, -100, 96, -96, -156, -165, -160],
            ),
            platform === "phone" ? (isDark ? 16 : 24) : 24,
          );
        case Variant.VIBRANT:
          return TonalPalette.fromHueAndChroma(
            DynamicScheme.getRotatedHue(
              sourceColorHct,
              [0, 38, 105, 140, 333, 360],
              [-14, 10, -14, 10, -14],
            ),
            platform === "phone" ? 56 : 36,
          );
        default:
          return super.getSecondaryPalette(
            variant,
            sourceColorHct,
            isDark,
            platform,
            contrastLevel,
          );
      }
    }
    getTertiaryPalette(variant, sourceColorHct, isDark, platform, contrastLevel) {
      switch (variant) {
        case Variant.NEUTRAL:
          return TonalPalette.fromHueAndChroma(
            DynamicScheme.getRotatedHue(
              sourceColorHct,
              [0, 38, 105, 161, 204, 278, 333, 360],
              [-32, 26, 10, -39, 24, -15, -32],
            ),
            platform === "phone" ? 20 : 36,
          );
        case Variant.TONAL_SPOT:
          return TonalPalette.fromHueAndChroma(
            DynamicScheme.getRotatedHue(
              sourceColorHct,
              [0, 20, 71, 161, 333, 360],
              [-40, 48, -32, 40, -32],
            ),
            platform === "phone" ? 28 : 32,
          );
        case Variant.EXPRESSIVE:
          return TonalPalette.fromHueAndChroma(
            DynamicScheme.getRotatedHue(
              sourceColorHct,
              [0, 105, 140, 204, 253, 278, 300, 333, 360],
              [-165, 160, -105, 101, -101, -160, -170, -165],
            ),
            48,
          );
        case Variant.VIBRANT:
          return TonalPalette.fromHueAndChroma(
            DynamicScheme.getRotatedHue(
              sourceColorHct,
              [0, 38, 71, 105, 140, 161, 253, 333, 360],
              [-72, 35, 24, -24, 62, 50, 62, -72],
            ),
            56,
          );
        default:
          return super.getTertiaryPalette(variant, sourceColorHct, isDark, platform, contrastLevel);
      }
    }
    static getExpressiveNeutralHue(sourceColorHct) {
      const hue = DynamicScheme.getRotatedHue(
        sourceColorHct,
        [0, 71, 124, 253, 278, 300, 360],
        [10, 0, 10, 0, 10, 0],
      );
      return hue;
    }
    static getExpressiveNeutralChroma(sourceColorHct, isDark, platform) {
      const neutralHue =
        _DynamicSchemePalettesDelegateImpl2025.getExpressiveNeutralHue(sourceColorHct);
      return platform === "phone" ? (isDark ? (Hct.isYellow(neutralHue) ? 6 : 14) : 18) : 12;
    }
    static getVibrantNeutralHue(sourceColorHct) {
      return DynamicScheme.getRotatedHue(
        sourceColorHct,
        [0, 38, 105, 140, 333, 360],
        [-14, 10, -14, 10, -14],
      );
    }
    static getVibrantNeutralChroma(sourceColorHct, platform) {
      const neutralHue =
        _DynamicSchemePalettesDelegateImpl2025.getVibrantNeutralHue(sourceColorHct);
      return platform === "phone" ? 28 : Hct.isBlue(neutralHue) ? 28 : 20;
    }
    getNeutralPalette(variant, sourceColorHct, isDark, platform, contrastLevel) {
      switch (variant) {
        case Variant.NEUTRAL:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, platform === "phone" ? 1.4 : 6);
        case Variant.TONAL_SPOT:
          return TonalPalette.fromHueAndChroma(sourceColorHct.hue, platform === "phone" ? 5 : 10);
        case Variant.EXPRESSIVE:
          return TonalPalette.fromHueAndChroma(
            _DynamicSchemePalettesDelegateImpl2025.getExpressiveNeutralHue(sourceColorHct),
            _DynamicSchemePalettesDelegateImpl2025.getExpressiveNeutralChroma(
              sourceColorHct,
              isDark,
              platform,
            ),
          );
        case Variant.VIBRANT:
          return TonalPalette.fromHueAndChroma(
            _DynamicSchemePalettesDelegateImpl2025.getVibrantNeutralHue(sourceColorHct),
            _DynamicSchemePalettesDelegateImpl2025.getVibrantNeutralChroma(
              sourceColorHct,
              platform,
            ),
          );
        default:
          return super.getNeutralPalette(variant, sourceColorHct, isDark, platform, contrastLevel);
      }
    }
    getNeutralVariantPalette(variant, sourceColorHct, isDark, platform, contrastLevel) {
      switch (variant) {
        case Variant.NEUTRAL:
          return TonalPalette.fromHueAndChroma(
            sourceColorHct.hue,
            (platform === "phone" ? 1.4 : 6) * 2.2,
          );
        case Variant.TONAL_SPOT:
          return TonalPalette.fromHueAndChroma(
            sourceColorHct.hue,
            (platform === "phone" ? 5 : 10) * 1.7,
          );
        case Variant.EXPRESSIVE:
          const expressiveNeutralHue =
            _DynamicSchemePalettesDelegateImpl2025.getExpressiveNeutralHue(sourceColorHct);
          const expressiveNeutralChroma =
            _DynamicSchemePalettesDelegateImpl2025.getExpressiveNeutralChroma(
              sourceColorHct,
              isDark,
              platform,
            );
          return TonalPalette.fromHueAndChroma(
            expressiveNeutralHue,
            expressiveNeutralChroma *
              (expressiveNeutralHue >= 105 && expressiveNeutralHue < 125 ? 1.6 : 2.3),
          );
        case Variant.VIBRANT:
          const vibrantNeutralHue =
            _DynamicSchemePalettesDelegateImpl2025.getVibrantNeutralHue(sourceColorHct);
          const vibrantNeutralChroma =
            _DynamicSchemePalettesDelegateImpl2025.getVibrantNeutralChroma(
              sourceColorHct,
              platform,
            );
          return TonalPalette.fromHueAndChroma(vibrantNeutralHue, vibrantNeutralChroma * 1.29);
        default:
          return super.getNeutralVariantPalette(
            variant,
            sourceColorHct,
            isDark,
            platform,
            contrastLevel,
          );
      }
    }
    getErrorPalette(variant, sourceColorHct, isDark, platform, contrastLevel) {
      const errorHue = DynamicScheme.getPiecewiseHue(
        sourceColorHct,
        [0, 3, 13, 23, 33, 43, 153, 273, 360],
        [12, 22, 32, 12, 22, 32, 22, 12],
      );
      switch (variant) {
        case Variant.NEUTRAL:
          return TonalPalette.fromHueAndChroma(errorHue, platform === "phone" ? 50 : 40);
        case Variant.TONAL_SPOT:
          return TonalPalette.fromHueAndChroma(errorHue, platform === "phone" ? 60 : 48);
        case Variant.EXPRESSIVE:
          return TonalPalette.fromHueAndChroma(errorHue, platform === "phone" ? 64 : 48);
        case Variant.VIBRANT:
          return TonalPalette.fromHueAndChroma(errorHue, platform === "phone" ? 80 : 60);
        default:
          return super.getErrorPalette(variant, sourceColorHct, isDark, platform, contrastLevel);
      }
    }
  };
  var spec20212 = new DynamicSchemePalettesDelegateImpl2021();
  var spec20252 = new DynamicSchemePalettesDelegateImpl2025();
  function getSpec2(specVersion) {
    return specVersion === "2025" ? spec20252 : spec20212;
  }

  // node_modules/@material/material-color-utilities/palettes/core_palette.js
  /**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  var CorePalette = class _CorePalette {
    /**
     * @param argb ARGB representation of a color
     *
     * @deprecated Use {@link DynamicScheme} for color scheme generation.
     * Use {@link CorePalettes} for core palettes container class.
     */
    static of(argb) {
      return new _CorePalette(argb, false);
    }
    /**
     * @param argb ARGB representation of a color
     *
     * @deprecated Use {@link DynamicScheme} for color scheme generation.
     * Use {@link CorePalettes} for core palettes container class.
     */
    static contentOf(argb) {
      return new _CorePalette(argb, true);
    }
    /**
     * Create a [CorePalette] from a set of colors
     *
     * @deprecated Use {@link DynamicScheme} for color scheme generation.
     * Use {@link CorePalettes} for core palettes container class.
     */
    static fromColors(colors) {
      return _CorePalette.createPaletteFromColors(false, colors);
    }
    /**
     * Create a content [CorePalette] from a set of colors
     *
     * @deprecated Use {@link DynamicScheme} for color scheme generation.
     * Use {@link CorePalettes} for core palettes container class.
     */
    static contentFromColors(colors) {
      return _CorePalette.createPaletteFromColors(true, colors);
    }
    static createPaletteFromColors(content, colors) {
      const palette = new _CorePalette(colors.primary, content);
      if (colors.secondary) {
        const p = new _CorePalette(colors.secondary, content);
        palette.a2 = p.a1;
      }
      if (colors.tertiary) {
        const p = new _CorePalette(colors.tertiary, content);
        palette.a3 = p.a1;
      }
      if (colors.error) {
        const p = new _CorePalette(colors.error, content);
        palette.error = p.a1;
      }
      if (colors.neutral) {
        const p = new _CorePalette(colors.neutral, content);
        palette.n1 = p.n1;
      }
      if (colors.neutralVariant) {
        const p = new _CorePalette(colors.neutralVariant, content);
        palette.n2 = p.n2;
      }
      return palette;
    }
    constructor(argb, isContent) {
      const hct = Hct.fromInt(argb);
      const hue = hct.hue;
      const chroma = hct.chroma;
      if (isContent) {
        this.a1 = TonalPalette.fromHueAndChroma(hue, chroma);
        this.a2 = TonalPalette.fromHueAndChroma(hue, chroma / 3);
        this.a3 = TonalPalette.fromHueAndChroma(hue + 60, chroma / 2);
        this.n1 = TonalPalette.fromHueAndChroma(hue, Math.min(chroma / 12, 4));
        this.n2 = TonalPalette.fromHueAndChroma(hue, Math.min(chroma / 6, 8));
      } else {
        this.a1 = TonalPalette.fromHueAndChroma(hue, Math.max(48, chroma));
        this.a2 = TonalPalette.fromHueAndChroma(hue, 16);
        this.a3 = TonalPalette.fromHueAndChroma(hue + 60, 24);
        this.n1 = TonalPalette.fromHueAndChroma(hue, 4);
        this.n2 = TonalPalette.fromHueAndChroma(hue, 8);
      }
      this.error = TonalPalette.fromHueAndChroma(25, 84);
    }
  };

  // node_modules/@material/material-color-utilities/quantize/lab_point_provider.js
  /**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */

  // node_modules/@material/material-color-utilities/quantize/quantizer_wsmeans.js
  /**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */

  // node_modules/@material/material-color-utilities/quantize/quantizer_map.js
  /**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */

  // node_modules/@material/material-color-utilities/quantize/quantizer_wu.js
  /**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */

  // node_modules/@material/material-color-utilities/quantize/quantizer_celebi.js
  /**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */

  // node_modules/@material/material-color-utilities/scheme/scheme.js
  /**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */

  // node_modules/@material/material-color-utilities/scheme/scheme_android.js
  /**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */

  // node_modules/@material/material-color-utilities/scheme/scheme_content.js
  /**
   * @license
   * Copyright 2023 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */

  // node_modules/@material/material-color-utilities/scheme/scheme_expressive.js
  /**
   * @license
   * Copyright 2022 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */

  // node_modules/@material/material-color-utilities/scheme/scheme_fidelity.js
  /**
   * @license
   * Copyright 2023 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */

  // node_modules/@material/material-color-utilities/scheme/scheme_fruit_salad.js
  /**
   * @license
   * Copyright 2022 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */

  // node_modules/@material/material-color-utilities/scheme/scheme_monochrome.js
  /**
   * @license
   * Copyright 2022 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */

  // node_modules/@material/material-color-utilities/scheme/scheme_neutral.js
  /**
   * @license
   * Copyright 2022 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */

  // node_modules/@material/material-color-utilities/scheme/scheme_rainbow.js
  /**
   * @license
   * Copyright 2022 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */

  // node_modules/@material/material-color-utilities/scheme/scheme_tonal_spot.js
  /**
   * @license
   * Copyright 2022 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */

  // node_modules/@material/material-color-utilities/scheme/scheme_vibrant.js
  /**
   * @license
   * Copyright 2022 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */

  // node_modules/@material/material-color-utilities/score/score.js
  /**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  var SCORE_OPTION_DEFAULTS = {
    desired: 4,
    fallbackColorARGB: 4282549748,
    filter: true,
    // Avoid unsuitable colors.
  };
  function compare(a, b) {
    if (a.score > b.score) {
      return -1;
    } else if (a.score < b.score) {
      return 1;
    }
    return 0;
  }
  var Score = class _Score {
    constructor() {}
    /**
     * Given a map with keys of colors and values of how often the color appears,
     * rank the colors based on suitability for being used for a UI theme.
     *
     * @param colorsToPopulation map with keys of colors and values of how often
     *     the color appears, usually from a source image.
     * @param {ScoreOptions} options optional parameters.
     * @return Colors sorted by suitability for a UI theme. The most suitable
     *     color is the first item, the least suitable is the last. There will
     *     always be at least one color returned. If all the input colors
     *     were not suitable for a theme, a default fallback color will be
     *     provided, Google Blue.
     */
    static score(colorsToPopulation, options) {
      const { desired, fallbackColorARGB, filter } = { ...SCORE_OPTION_DEFAULTS, ...options };
      const colorsHct = [];
      const huePopulation = new Array(360).fill(0);
      let populationSum = 0;
      for (const [argb, population] of colorsToPopulation.entries()) {
        const hct = Hct.fromInt(argb);
        colorsHct.push(hct);
        const hue = Math.floor(hct.hue);
        huePopulation[hue] += population;
        populationSum += population;
      }
      const hueExcitedProportions = new Array(360).fill(0);
      for (let hue = 0; hue < 360; hue++) {
        const proportion = huePopulation[hue] / populationSum;
        for (let i = hue - 14; i < hue + 16; i++) {
          const neighborHue = sanitizeDegreesInt(i);
          hueExcitedProportions[neighborHue] += proportion;
        }
      }
      const scoredHct = new Array();
      for (const hct of colorsHct) {
        const hue = sanitizeDegreesInt(Math.round(hct.hue));
        const proportion = hueExcitedProportions[hue];
        if (
          filter &&
          (hct.chroma < _Score.CUTOFF_CHROMA || proportion <= _Score.CUTOFF_EXCITED_PROPORTION)
        ) {
          continue;
        }
        const proportionScore = proportion * 100 * _Score.WEIGHT_PROPORTION;
        const chromaWeight =
          hct.chroma < _Score.TARGET_CHROMA
            ? _Score.WEIGHT_CHROMA_BELOW
            : _Score.WEIGHT_CHROMA_ABOVE;
        const chromaScore = (hct.chroma - _Score.TARGET_CHROMA) * chromaWeight;
        const score = proportionScore + chromaScore;
        scoredHct.push({ hct, score });
      }
      scoredHct.sort(compare);
      const chosenColors = [];
      for (let differenceDegrees2 = 90; differenceDegrees2 >= 15; differenceDegrees2--) {
        chosenColors.length = 0;
        for (const { hct } of scoredHct) {
          const duplicateHue = chosenColors.find((chosenHct) => {
            return differenceDegrees(hct.hue, chosenHct.hue) < differenceDegrees2;
          });
          if (!duplicateHue) {
            chosenColors.push(hct);
          }
          if (chosenColors.length >= desired) break;
        }
        if (chosenColors.length >= desired) break;
      }
      const colors = [];
      if (chosenColors.length === 0) {
        colors.push(fallbackColorARGB);
      }
      for (const chosenHct of chosenColors) {
        colors.push(chosenHct.toInt());
      }
      return colors;
    }
  };
  Score.TARGET_CHROMA = 48;
  Score.WEIGHT_PROPORTION = 0.7;
  Score.WEIGHT_CHROMA_ABOVE = 0.3;
  Score.WEIGHT_CHROMA_BELOW = 0.1;
  Score.CUTOFF_CHROMA = 5;
  Score.CUTOFF_EXCITED_PROPORTION = 0.01;

  // node_modules/@material/material-color-utilities/utils/string_utils.js
  /**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  function hexFromArgb(argb) {
    const r = redFromArgb(argb);
    const g = greenFromArgb(argb);
    const b = blueFromArgb(argb);
    const outParts = [r.toString(16), g.toString(16), b.toString(16)];
    for (const [i, part] of outParts.entries()) {
      if (part.length === 1) {
        outParts[i] = "0" + part;
      }
    }
    return "#" + outParts.join("");
  }
  function argbFromHex(hex) {
    hex = hex.replace("#", "");
    const isThree = hex.length === 3;
    const isSix = hex.length === 6;
    const isEight = hex.length === 8;
    if (!isThree && !isSix && !isEight) {
      throw new Error("unexpected hex " + hex);
    }
    let r = 0;
    let g = 0;
    let b = 0;
    if (isThree) {
      r = parseIntHex(hex.slice(0, 1).repeat(2));
      g = parseIntHex(hex.slice(1, 2).repeat(2));
      b = parseIntHex(hex.slice(2, 3).repeat(2));
    } else if (isSix) {
      r = parseIntHex(hex.slice(0, 2));
      g = parseIntHex(hex.slice(2, 4));
      b = parseIntHex(hex.slice(4, 6));
    } else if (isEight) {
      r = parseIntHex(hex.slice(2, 4));
      g = parseIntHex(hex.slice(4, 6));
      b = parseIntHex(hex.slice(6, 8));
    }
    return ((255 << 24) | ((r & 255) << 16) | ((g & 255) << 8) | (b & 255)) >>> 0;
  }
  function parseIntHex(value) {
    return parseInt(value, 16);
  }

  // node_modules/@material/material-color-utilities/utils/image_utils.js
  /**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */

  // node_modules/@material/material-color-utilities/utils/theme_utils.js
  /**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */

  // node_modules/@material/material-color-utilities/index.js
  /**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */

  // src/ui/custom-palette.js
  var DEFAULT_SEED = "#6750a4";
  function normalizeSeed(value) {
    const hex = String(value || "").trim();
    return /^#?[\da-f]{6}$/i.test(hex) ? `#${hex.replace(/^#/, "").toLowerCase()}` : null;
  }
  var cachedSeed = null;
  var cachedPalette = null;
  function customPalette(value) {
    const seed = normalizeSeed(value);
    if (!seed) return null;
    if (seed === cachedSeed) return cachedPalette;
    const p = CorePalette.of(argbFromHex(seed));
    const color = (palette2, tone) => hexFromArgb(palette2.tone(tone));
    const palette = {
      label: "自定义",
      surface: color(p.n2, 94),
      card: color(p.n2, 98),
      shadow: color(p.n2, 82),
      roles: {
        primary: color(p.a1, 40),
        "primary-hover": color(p.a1, 30),
        "on-primary": color(p.a1, 100),
        "secondary-container": color(p.a2, 90),
        "on-secondary-container": color(p.a2, 10),
        "on-surface": color(p.n1, 10),
        "on-surface-variant": color(p.n2, 30),
        outline: color(p.n2, 50),
        "primary-container": color(p.a1, 90),
        "on-primary-container": color(p.a1, 10),
      },
    };
    cachedSeed = seed;
    cachedPalette = palette;
    return palette;
  }

  // src/ui/palettes.js
  var appearancePalettes = {
    lavender: {
      label: "淡紫",
      surface: "#f2ebf7",
      card: "#fdf7ff",
      shadow: "#d0cad5",
      roles: {
        primary: "#6750a4",
        "primary-hover": "#4f378a",
        "on-primary": "#ffffff",
        "secondary-container": "#e8def8",
        "on-secondary-container": "#1e192b",
        "on-surface": "#1c1b1e",
        "on-surface-variant": "#49454e",
        outline: "#7a757f",
        "primary-container": "#e9ddff",
        "on-primary-container": "#22005d",
      },
    },
    rose: {
      label: "柔粉",
      surface: "#fee9ed",
      card: "#fff8f8",
      shadow: "#dbc7cb",
      roles: {
        primary: "#994060",
        "primary-hover": "#7b2948",
        "on-primary": "#ffffff",
        "secondary-container": "#ffd9e2",
        "on-secondary-container": "#2b151c",
        "on-surface": "#201a1b",
        "on-surface-variant": "#514346",
        outline: "#837376",
        "primary-container": "#ffd9e2",
        "on-primary-container": "#3f001c",
      },
    },
    mint: {
      label: "薄荷",
      surface: "#e7f0e9",
      card: "#f2fcf5",
      shadow: "#c5cec8",
      roles: {
        primary: "#006c50",
        "primary-hover": "#00513c",
        "on-primary": "#ffffff",
        "secondary-container": "#cee9db",
        "on-secondary-container": "#082017",
        "on-surface": "#191c1a",
        "on-surface-variant": "#404944",
        outline: "#707974",
        "primary-container": "#84f8cd",
        "on-primary-container": "#002116",
      },
    },
    apricot: {
      label: "奶杏",
      surface: "#fdebdc",
      card: "#fff8f5",
      shadow: "#dbc9bb",
      roles: {
        primary: "#8a5100",
        "primary-hover": "#693c00",
        "on-primary": "#ffffff",
        "secondary-container": "#fedcbe",
        "on-secondary-container": "#291806",
        "on-surface": "#201b16",
        "on-surface-variant": "#50453a",
        outline: "#837568",
        "primary-container": "#ffdcbd",
        "on-primary-container": "#2c1600",
      },
    },
    blue: {
      label: "浅蓝",
      surface: "#ecedf7",
      card: "#f9f9ff",
      shadow: "#caccd5",
      roles: {
        primary: "#2a5ea7",
        "primary-hover": "#00458d",
        "on-primary": "#ffffff",
        "secondary-container": "#dae2f9",
        "on-secondary-container": "#131c2b",
        "on-surface": "#1a1b1e",
        "on-surface-variant": "#44474e",
        outline: "#74777f",
        "primary-container": "#d6e3ff",
        "on-primary-container": "#001b3e",
      },
    },
    teal: {
      label: "青绿",
      surface: "#e6f0ed",
      card: "#f1fcf8",
      shadow: "#c4cecb",
      roles: {
        primary: "#006a60",
        "primary-hover": "#005048",
        "on-primary": "#ffffff",
        "secondary-container": "#cce8e2",
        "on-secondary-container": "#05201c",
        "on-surface": "#191c1b",
        "on-surface-variant": "#3f4947",
        outline: "#6f7977",
        "primary-container": "#74f8e6",
        "on-primary-container": "#00201c",
      },
    },
    lake: {
      label: "湖蓝",
      surface: "#e7eff4",
      card: "#f3fbff",
      shadow: "#c5cdd2",
      roles: {
        primary: "#006780",
        "primary-hover": "#004d61",
        "on-primary": "#ffffff",
        "secondary-container": "#cfe6f1",
        "on-secondary-container": "#071e26",
        "on-surface": "#191c1d",
        "on-surface-variant": "#40484c",
        outline: "#70787c",
        "primary-container": "#b8eaff",
        "on-primary-container": "#001f28",
      },
    },
    indigo: {
      label: "靛蓝",
      surface: "#eeedf8",
      card: "#fbf8ff",
      shadow: "#cccbd5",
      roles: {
        primary: "#4a58a9",
        "primary-hover": "#313f90",
        "on-primary": "#ffffff",
        "secondary-container": "#e0e1f9",
        "on-secondary-container": "#181a2c",
        "on-surface": "#1b1b1f",
        "on-surface-variant": "#46464f",
        outline: "#767680",
        "primary-container": "#dee0ff",
        "on-primary-container": "#000f5d",
      },
    },
    berry: {
      label: "莓紫",
      surface: "#f8eaf4",
      card: "#fff7fa",
      shadow: "#d6c8d2",
      roles: {
        primary: "#86458b",
        "primary-hover": "#6c2d72",
        "on-primary": "#ffffff",
        "secondary-container": "#f5dbf1",
        "on-secondary-container": "#251626",
        "on-surface": "#1e1a1d",
        "on-surface-variant": "#4d444c",
        outline: "#7f747c",
        "primary-container": "#ffd6fc",
        "on-primary-container": "#36003e",
      },
    },
    coral: {
      label: "珊瑚",
      surface: "#ffe9e5",
      card: "#fff8f6",
      shadow: "#dec7c3",
      roles: {
        primary: "#9c4234",
        "primary-hover": "#7d2c1f",
        "on-primary": "#ffffff",
        "secondary-container": "#ffdad4",
        "on-secondary-container": "#2c1511",
        "on-surface": "#201a19",
        "on-surface-variant": "#534340",
        outline: "#857370",
        "primary-container": "#ffdad4",
        "on-primary-container": "#400200",
      },
    },
    olive: {
      label: "橄榄",
      surface: "#efefde",
      card: "#fbfae9",
      shadow: "#cdcdbd",
      roles: {
        primary: "#566500",
        "primary-hover": "#404c00",
        "on-primary": "#ffffff",
        "secondary-container": "#e1e5c3",
        "on-secondary-container": "#191d08",
        "on-surface": "#1b1c17",
        "on-surface-variant": "#46483b",
        outline: "#77786a",
        "primary-container": "#d8ec7b",
        "on-primary-container": "#181e00",
      },
    },
  };

  // src/ui/theme.js
  var KEY = "hz-helper-neumorphism-v1";
  var PALETTE_KEY = "hz-helper-material-palette-v1";
  var PURE_KEY = "hz-helper-pure-neumorphism-v1";
  var SEED_KEY = "hz-helper-material-seed-v1";
  var views = /* @__PURE__ */ new Set();
  var validChoice = (value) => value === "custom" || Object.hasOwn(appearancePalettes, value);
  var stopListening = null;
  function read(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  function save(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  }
  function notify(state) {
    for (const apply of views) apply(state);
  }
  function bindAppearance({ host, $, lifecycle }) {
    const toggle = $("#neumorphism"),
      picker = $("#appearance-palette"),
      pureToggle = $("#pure-neumorphism");
    for (const [value, palette] of Object.entries(appearancePalettes)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = palette.label;
      picker.append(option);
    }
    const customOption = document.createElement("option");
    customOption.value = "custom";
    customOption.textContent = "自定义";
    picker.append(customOption);
    const colorInput = $("#appearance-seed-color"),
      hexInput = $("#appearance-seed-hex");
    let enabled = false,
      pure = false,
      selected = "lavender",
      seed = DEFAULT_SEED,
      appliedPalette = null;
    const update = (element, property, value) => {
      if (element[property] !== value) element[property] = value;
    };
    const flag = (name, value) => {
      if (value) {
        if (host.getAttribute(name) !== "true") host.setAttribute(name, "true");
      } else if (host.hasAttribute ? host.hasAttribute(name) : host.getAttribute(name) !== null) {
        host.removeAttribute(name);
      }
    };
    const apply = (state) => {
      enabled = state.enabled ?? enabled;
      pure = state.pure ?? pure;
      selected = validChoice(state.palette) ? state.palette : selected;
      seed = normalizeSeed(state.seed) || seed;
      const palette = selected === "custom" ? customPalette(seed) : appearancePalettes[selected];
      update(toggle, "checked", enabled);
      update(pureToggle, "checked", pure);
      update($("#pure-neumorphism-row"), "hidden", !enabled);
      flag("data-pure-neumorphic", enabled && pure);
      update(picker, "value", selected);
      update($("#appearance-palette-row"), "hidden", !enabled);
      update($("#appearance-custom-row"), "hidden", !enabled || selected !== "custom");
      update(colorInput, "value", seed);
      if (hexInput.value.toLowerCase() !== seed) hexInput.value = seed;
      hexInput.removeAttribute("aria-invalid");
      $("#appearance-seed-error").textContent = "";
      flag("data-neumorphic", enabled);
      if (palette !== appliedPalette) {
        host.style.setProperty("--theme-surface", palette.surface);
        host.style.setProperty("--theme-card", palette.card);
        host.style.setProperty("--theme-shadow", palette.shadow);
        for (const [role, color] of Object.entries(palette.roles)) {
          host.style.setProperty(`--theme-${role}`, color);
        }
        appliedPalette = palette;
      }
    };
    views.add(apply);
    apply({
      enabled: read(KEY) === "1",
      pure: read(PURE_KEY) === "1",
      palette: read(PALETTE_KEY),
      seed: read(SEED_KEY),
    });
    toggle.onchange = () => {
      notify({ enabled: toggle.checked });
      save(KEY, toggle.checked ? "1" : "0");
    };
    pureToggle.onchange = () => {
      notify({ pure: pureToggle.checked });
      save(PURE_KEY, pureToggle.checked ? "1" : "0");
    };
    picker.onchange = () => {
      if (!validChoice(picker.value)) return;
      notify({ palette: picker.value });
      save(PALETTE_KEY, picker.value);
    };
    const updateSeed = (value, showError = false) => {
      const next = normalizeSeed(value);
      if (!next) {
        if (showError) {
          hexInput.setAttribute("aria-invalid", "true");
          $("#appearance-seed-error").textContent = "请输入六位色值，例如 #6750A4";
        }
        return;
      }
      notify({ seed: next });
      save(SEED_KEY, next);
    };
    colorInput.oninput = () => updateSeed(colorInput.value);
    hexInput.oninput = () => updateSeed(hexInput.value);
    hexInput.onchange = () => updateSeed(hexInput.value, true);
    if (!stopListening) {
      const changed = (event) => {
        if (event.key === KEY || event.key === null) notify({ enabled: read(KEY) === "1" });
        if (event.key === PURE_KEY || event.key === null) notify({ pure: read(PURE_KEY) === "1" });
        if (event.key === SEED_KEY || event.key === null)
          notify({ seed: read(SEED_KEY) || DEFAULT_SEED });
        if (event.key === PALETTE_KEY || event.key === null)
          notify({ palette: read(PALETTE_KEY) || "lavender" });
      };
      window.addEventListener("storage", changed);
      stopListening = () => window.removeEventListener("storage", changed);
    }
    lifecycle.defer(() => {
      views.delete(apply);
      if (!views.size) {
        stopListening?.();
        stopListening = null;
      }
    });
  }

  // src/ui/motion.js
  function createMenuMotion({ panel, launcher, reducedMotion }) {
    let menuAnimation = null,
      ballAnimation = null,
      generation = 0;
    const enterEase = "cubic-bezier(.16,1,.3,1)";
    const exitEase = "cubic-bezier(.4,0,1,1)";
    const translate = (x) => `translate3d(${x}px,0,0)`;
    function opacity(element, fallback) {
      const value = Number.parseFloat(getComputedStyle(element).opacity);
      return Number.isFinite(value) ? value : fallback;
    }
    function transition(open) {
      const ticket = ++generation;
      const menuCurrent = menuAnimation && panel.getBoundingClientRect?.();
      const ballCurrent = ballAnimation && launcher.getBoundingClientRect?.();
      const ballOpacity = opacity(launcher, open ? 1 : 0);
      menuAnimation?.cancel();
      ballAnimation?.cancel();
      menuAnimation = null;
      ballAnimation = null;
      if (reducedMotion() || typeof panel.animate !== "function") {
        panel.hidden = !open;
        launcher.style.opacity = open ? "0" : "";
        launcher.style.pointerEvents = open ? "none" : "";
        panel.style.willChange = "";
        launcher.style.willChange = "";
        return;
      }
      panel.hidden = false;
      const menu = panel.getBoundingClientRect?.();
      const ball = launcher.getBoundingClientRect?.();
      const left = ball ? ball.left + ball.width / 2 < window.innerWidth / 2 : false;
      const menuOutside = menu
        ? left
          ? -(menu.right + 80)
          : window.innerWidth - menu.left + 80
        : left
          ? -window.innerWidth
          : window.innerWidth;
      const ballOutside = ball
        ? left
          ? -(ball.right + 24)
          : window.innerWidth - ball.left + 24
        : 80;
      const menuStart = menuCurrent && menu ? menuCurrent.left - menu.left : open ? menuOutside : 0;
      const ballStart = ballCurrent && ball ? ballCurrent.left - ball.left : open ? 0 : ballOutside;
      const hasBallMotion = typeof launcher.animate === "function";
      panel.style.willChange = "transform";
      launcher.style.opacity = open ? "0" : "";
      launcher.style.pointerEvents = open ? "none" : "";
      const activeMenu = panel.animate(
        [{ transform: translate(menuStart) }, { transform: translate(open ? 0 : menuOutside) }],
        {
          duration: open ? 380 : 300,
          delay: open && hasBallMotion && !menuCurrent ? 100 : 0,
          easing: open ? enterEase : exitEase,
          fill: "both",
        },
      );
      menuAnimation = activeMenu;
      activeMenu.finished
        .then(() => {
          if (ticket !== generation) return;
          if (!open) panel.hidden = true;
          panel.style.willChange = "";
          menuAnimation = null;
          activeMenu.cancel();
        })
        .catch(() => {});
      if (!hasBallMotion) return;
      launcher.style.willChange = "transform, opacity";
      const activeBall = launcher.animate(
        [
          {
            transform: translate(ballStart),
            opacity: ballCurrent ? ballOpacity : open ? 1 : 0,
          },
          { transform: translate(open ? ballOutside : 0), opacity: open ? 0 : 1 },
        ],
        {
          duration: open ? 160 : 260,
          delay: open ? 0 : 220,
          easing: open ? exitEase : enterEase,
          fill: "both",
        },
      );
      ballAnimation = activeBall;
      activeBall.finished
        .then(() => {
          if (ticket !== generation) return;
          launcher.style.opacity = open ? "0" : "";
          launcher.style.willChange = "";
          ballAnimation = null;
          activeBall.cancel();
        })
        .catch(() => {});
    }
    return { transition };
  }

  // src/ui/launcher.js
  function bindLauncher({ host, panel, launcher, reducedMotion, lifecycle, onToggle }) {
    const menuMotion = createMenuMotion({ panel, launcher, reducedMotion });
    const positionKey = "hz-helper-launcher-position-v1";
    const margin = 12,
      ball = 48;
    let drag = null,
      suppressClick = false;
    function placeLauncher(side, fraction) {
      const width = window.innerWidth,
        height = window.innerHeight;
      if (!(width > 0 && height > 0)) return;
      const maxY = Math.max(margin, height - ball - margin),
        y = margin + Math.max(0, Math.min(1, fraction)) * (maxY - margin);
      host.style.left = `${side === "left" ? margin : Math.max(margin, width - ball - margin)}px`;
      host.style.top = `${y}px`;
      host.style.right = "auto";
      host.style.bottom = "auto";
      panel.style.left = side === "left" ? "12px" : "auto";
      panel.style.right = side === "left" ? "auto" : "12px";
    }
    function savePosition(side, y) {
      const maxY = Math.max(margin, window.innerHeight - ball - margin),
        fraction = maxY === margin ? 0 : Math.max(0, Math.min(1, (y - margin) / (maxY - margin)));
      localStorage.setItem(positionKey, JSON.stringify({ side, fraction }));
      placeLauncher(side, fraction);
    }
    function restorePosition() {
      try {
        const p = JSON.parse(localStorage.getItem(positionKey) || "null");
        if (p && ["left", "right"].includes(p.side) && Number.isFinite(p.fraction))
          placeLauncher(p.side, p.fraction);
      } catch {}
    }
    launcher.onpointerdown = (event) => {
      if (event.button !== 0 || !host.getBoundingClientRect) return;
      const rect = host.getBoundingClientRect();
      drag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: rect.left,
        top: rect.top,
        moved: false,
      };
      launcher.setPointerCapture?.(event.pointerId);
    };
    launcher.onpointermove = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x,
        dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      const x = Math.max(margin, Math.min(window.innerWidth - ball - margin, drag.left + dx));
      const y = Math.max(margin, Math.min(window.innerHeight - ball - margin, drag.top + dy));
      host.style.left = `${x}px`;
      host.style.top = `${y}px`;
      host.style.right = "auto";
      host.style.bottom = "auto";
    };
    function endDrag(event) {
      if (!drag || event.pointerId !== drag.id) return;
      if (drag.moved) {
        const x = drag.left + event.clientX - drag.x,
          y = drag.top + event.clientY - drag.y;
        savePosition(x + ball / 2 < window.innerWidth / 2 ? "left" : "right", y);
        suppressClick = true;
        lifecycle.timeout(() => {
          suppressClick = false;
        }, 0);
      }
      drag = null;
    }
    launcher.onpointerup = endDrag;
    launcher.onpointercancel = endDrag;
    lifecycle.on(window, "resize", restorePosition);
    restorePosition();
    launcher.onclick = () => {
      if (!suppressClick) onToggle();
    };
    return menuMotion;
  }

  // src/ui/preferences.js
  function bindPreferences({ $, icon: icon2, lifecycle }) {
    const muteKey = "hz-helper-mute-video-v1";
    $("#mute-video").checked = localStorage.getItem(muteKey) === "1";
    function renderMuteIcon() {
      $("#mute-icon").innerHTML = icon2($("#mute-video").checked ? "volume-x" : "volume", 16);
    }
    renderMuteIcon();
    let onMuteChanged = () => {};
    $("#mute-video").onchange = () => {
      localStorage.setItem(muteKey, $("#mute-video").checked ? "1" : "0");
      renderMuteIcon();
      onMuteChanged();
    };
    lifecycle.on(window, "storage", (event) => {
      if (event.key === muteKey) {
        $("#mute-video").checked = event.newValue === "1";
        renderMuteIcon();
        onMuteChanged();
      }
    });
    const wakeKey = "hz-helper-keep-awake-v1";
    let wakeSentinel = null,
      wakeRequestId = 0;
    $("#keep-awake").checked = localStorage.getItem(wakeKey) === "1";
    async function updateWakeLock() {
      const id = ++wakeRequestId,
        enabled = $("#keep-awake").checked;
      if (!enabled || document.visibilityState !== "visible") {
        if (wakeSentinel) {
          const old = wakeSentinel;
          wakeSentinel = null;
          await old.release().catch(() => {});
        }
        return;
      }
      if (!navigator.wakeLock?.request) {
        return;
      }
      if (wakeSentinel && !wakeSentinel.released) {
        return;
      }
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (
          id !== wakeRequestId ||
          !$("#keep-awake").checked ||
          document.visibilityState !== "visible"
        ) {
          await lock.release();
          return;
        }
        wakeSentinel = lock;
        lock.addEventListener("release", () => {
          if (wakeSentinel === lock) {
            wakeSentinel = null;
          }
        });
      } catch (error) {
        if (id === wakeRequestId) {
          log("防息屏请求失败", error.message);
        }
      }
    }
    $("#keep-awake").onchange = () => {
      localStorage.setItem(wakeKey, $("#keep-awake").checked ? "1" : "0");
      void updateWakeLock();
    };
    lifecycle.on(window, "storage", (event) => {
      if (event.key === wakeKey) {
        $("#keep-awake").checked = event.newValue === "1";
        void updateWakeLock();
      }
    });
    lifecycle.on(document, "visibilitychange", () => void updateWakeLock());
    lifecycle.on(window, "pagehide", () => {
      wakeRequestId++;
      if (wakeSentinel) {
        void wakeSentinel.release();
        wakeSentinel = null;
      }
    });
    if ($("#keep-awake").checked) void updateWakeLock();
    return {
      set onMuteChanged(fn) {
        onMuteChanged = fn;
      },
    };
  }

  // src/ui/icons.js
  var paths = {
    layers: '<path d="m12 2 10 5-10 5L2 7l10-5Z"/><path d="m2 12 10 5 10-5M2 17l10 5 10-5"/>',
    check: '<path d="m20 6-11 11-5-5"/>',
    trash: '<path d="M3 6h18M19 6l-1 14H6L5 6M9 6V3h6v3M10 10v6M14 10v6"/>',
    play: '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>',
    "volume-x":
      '<path d="M11 4.702a.7.7 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.7.7 0 0 0 11 19.298z" /> <path d="m16.5 14.5 5-5" /> <path d="m16.5 9.5 5 5" />',
    volume:
      '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" /> <path d="M16 9a5 5 0 0 1 0 6" /> <path d="M19.364 18.364a9 9 0 0 0 0-12.728" />',
    sun: '<circle cx="12" cy="12" r="4" /> <path d="M12 2v2" /> <path d="M12 20v2" /> <path d="m4.93 4.93 1.41 1.41" /> <path d="m17.66 17.66 1.41 1.41" /> <path d="M2 12h2" /> <path d="M20 12h2" /> <path d="m6.34 17.66-1.41 1.41" /> <path d="m19.07 4.93-1.41 1.41" />',
    menu: '<path d="M4 6.5h16M4 12h16M4 17.5h10"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    info: '<circle cx="12" cy="12" r="10" /> <path d="M12 16v-4" /> <path d="M12 8h.01" />',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    // Lucide refresh-cw, ISC license: https://lucide.dev/icons/refresh-cw
    refresh:
      '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    // Lucide copy, ISC license: https://lucide.dev/icons/copy
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    pause:
      '<rect x="14" y="3" width="5" height="18" rx="1"/><rect x="5" y="3" width="5" height="18" rx="1"/>',
  };
  var icon = (name, size = 20) => {
    const solid = name === "play" || name === "pause";
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${solid ? "currentColor" : "none"}" stroke="${solid ? "none" : "currentColor"}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
  };

  // src/ui/markup.js
  function html(strings, ...values) {
    return strings.reduce(
      (output, part, index) => output + part + (index < values.length ? values[index] : ""),
      "",
    );
  }

  // src/ui/icon-button.js
  var escapeAttribute = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char],
    );
  function attributes({ id, label, className = "icon-button", title = label }) {
    return {
      type: "button",
      id,
      class: className || void 0,
      "aria-label": label,
      title,
    };
  }
  function glyph({ name, size = 16, wrapped = false }) {
    const svg = icon(name, size);
    return wrapped ? `<span class="action-icon">${svg}</span>` : svg;
  }
  function iconButton(options) {
    const attrs = Object.entries(attributes(options))
      .filter(([, value]) => value !== void 0 && value !== null)
      .map(([name, value]) => `${name}="${escapeAttribute(value)}"`)
      .join(" ");
    return `<button ${attrs}${options.disabled ? " disabled" : ""}>${glyph(options)}</button>`;
  }
  function createIconButton(options) {
    const button = document.createElement("button");
    for (const [name, value] of Object.entries(attributes(options))) {
      if (value !== void 0 && value !== null) button.setAttribute(name, value);
    }
    button.disabled = !!options.disabled;
    button.innerHTML = glyph(options);
    return button;
  }

  // src/ui/progress-bar.js
  function progressBar({ trackId, fillId, label }) {
    return `<div id="${trackId}" class="progress-track" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100"><div id="${fillId}" class="progress-fill"></div></div>`;
  }
  function renderProgressBar(track, fill, percent, emptyText = "尚未取得进度") {
    const value = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
    fill.style.width = `${value ?? 0}%`;
    if (value === null) {
      track.removeAttribute("aria-valuenow");
      track.setAttribute("aria-valuetext", emptyText);
    } else {
      track.setAttribute("aria-valuenow", String(value));
      track.removeAttribute("aria-valuetext");
    }
    return value;
  }

  // src/ui/template.js
  var panelTemplate = (icon2, info) => html`
    <button
      id="launcher"
      type="button"
      aria-label="打开学习助手"
      aria-expanded="false"
      aria-controls="panel"
    >
      ${icon2("menu", 22)}
    </button>
    <section
      id="panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby="panel-title"
      tabindex="-1"
      hidden
    >
      <header>
        <div class="panel-heading"><h2 id="panel-title">学习助手</h2></div>
        <div class="header-actions">
          <span id="refresh-countdown" role="timer" aria-live="off" hidden></span>
          ${iconButton({ id: "close-panel", name: "close", size: 18, label: "关闭菜单", title: null })}
        </div>
      </header>
      <div class="body">
        <div id="controls"></div>
        <div class="status-section">
          <div class="status-line" id="status-line" hidden>
            <p id="state" role="status" aria-live="polite" aria-atomic="true">等待开始</p>
          </div>
          <div id="center-progress" hidden>
            <div class="course-progress-head">
              <div class="course-progress-meta">
                <span id="center-progress-label">课程进度</span>
                <time id="center-check-time">—</time>
              </div>
              ${iconButton({ id: "check-course-progress", name: "refresh", label: "手动核对课程进度", disabled: true })}
            </div>
            ${progressBar({ trackId: "center-progress-bar", fillId: "center-progress-fill", label: "平台当前课程进度" })}
          </div>
          <p id="center-status" role="status" aria-live="polite" hidden></p>
          <p id="progress"></p>
        </div>
        <section class="annual" aria-label="学时概览">
          <div class="section-head">
            <div class="section-title">
              学时概览${info("annual-info", "关于学时预计", "分类数字来自平台默认学年已学列表，可能含未完成或未通过考试的课程。平台确认总学时单独显示。")}
            </div>
            ${iconButton({ id: "refresh-annual", className: "refresh", name: "refresh", size: 18, label: "刷新平台学时" })}
          </div>
          <div class="annual-grid">
            <div>
              <span>总学时</span>
              <strong>
                <span id="estimate-total">—</span>
                <small>
                  /
                  <span id="goal-display-total">90</span>
                </small>
              </strong>
            </div>
            <div>
              <span>专业课程</span>
              <strong>
                <span id="estimate-professional">—</span>
                <small>
                  /
                  <span id="goal-display-professional">60</span>
                </small>
              </strong>
            </div>
            <div>
              <span>公需合计</span>
              <strong>
                <span id="estimate-public">—</span>
                <small>
                  /
                  <span id="goal-display-public">18</span>
                </small>
              </strong>
            </div>
          </div>
          <div class="official-meta">
            <span>
              平台确认总学时
              <b id="annual-total">—</b>
            </span>
            <span id="annual-year">平台默认学年：—</span>
          </div>
          <div id="annual-breakdown" hidden></div>
          <p id="learned-summary" role="status" aria-live="polite"></p>
        </section>
        <section class="preferences" aria-label="偏好设置">
          <div class="section-title">偏好设置</div>
          <div class="preference-row">
            <span class="preference-label">
              <span id="mute-icon">${icon2("volume", 16)}</span>
              <label for="mute-video">自动静音</label>
              ${info("mute-info", "关于自动静音", "静音主播放器和已识别课件。未支持的课件可以在浏览器标签页右键选择静音网站。")}
            </span>
            <input id="mute-video" type="checkbox" role="switch" aria-label="自动静音视频" />
          </div>
          <div class="preference-row">
            <span class="preference-label">
              ${icon2("sun", 15)}
              <label for="keep-awake">防止息屏</label>
            </span>
            <input id="keep-awake" type="checkbox" role="switch" aria-label="防止息屏" />
          </div>
          <div class="preference-row">
            <span class="preference-label">
              ${icon2("layers", 16)}
              <label for="neumorphism">新拟态外观</label>
            </span>
            <input id="neumorphism" type="checkbox" role="switch" aria-label="新拟态外观" />
          </div>
          <div class="preference-row" id="pure-neumorphism-row" hidden>
            <label for="pure-neumorphism">同色新拟态（实验）</label>
            <input
              id="pure-neumorphism"
              type="checkbox"
              role="switch"
              aria-label="同色新拟态（实验）"
            />
          </div>
          <div class="preference-row" id="appearance-palette-row" hidden>
            <label for="appearance-palette">Material 3 配色</label>
            <div class="select-wrap appearance-picker">
              <select id="appearance-palette" aria-label="Material 3 配色"></select>
              ${icon2("chevron", 16)}
            </div>
          </div>
          <div id="appearance-custom-row" hidden>
            <div class="custom-color-row">
              <label for="appearance-seed-color">种子颜色</label>
              <input
                id="appearance-seed-color"
                type="color"
                value="#6750a4"
                aria-label="选择自定义种子颜色"
              />
              <input
                id="appearance-seed-hex"
                type="text"
                value="#6750a4"
                maxlength="7"
                spellcheck="false"
                autocomplete="off"
                aria-label="自定义种子颜色十六进制色值"
                aria-describedby="appearance-seed-error"
              />
            </div>
            <p id="appearance-seed-error" role="status" aria-live="polite"></p>
          </div>
        </section>
        <div id="dashboard"></div>
        <div id="preview"></div>
        <section class="log-section" aria-labelledby="log-title">
          <details id="log-disclosure" class="log-disclosure">
            <summary class="section-head">
              <div class="section-title" id="log-title">日志</div>
              <div class="log-tools icon-actions">
                ${iconButton({ id: "copy-log", className: "", name: "copy", size: 20, label: "复制日志" })}${iconButton({ id: "clear-log", className: "", name: "trash", size: 20, label: "清空日志" })}
              </div>
            </summary>
            <div id="event-log" role="log" aria-label="运行日志"></div>
            <p id="log-result" role="status" aria-live="polite"></p>
          </details>
        </section>
      </div>
    </section>
  `;

  // src/ui/panel.js
  function createPanel({ lifecycle: externalLifecycle } = {}) {
    const lifecycle = externalLifecycle || createLifecycle();
    const host = document.createElement("div");
    host.id = "hz-learning-helper";
    document.documentElement.append(host);
    const ui = host.attachShadow({ mode: "open" });
    function info(id, label, description) {
      return `<span class="info-wrap"><button type="button" class="info-trigger" data-info="${id}" aria-label="${label}" aria-expanded="false" aria-controls="${id}">${icon("info", 16)}</button><span class="help" id="${id}" role="note" hidden>${description}</span></span>`;
    }
    ui.innerHTML = `<style>${panelStyles}</style>${panelTemplate(icon, info)}`;
    const $ = (selector) => ui.querySelector(selector);
    bindAppearance({ host, $, lifecycle });
    bindSurfaceCards({ host, root: ui, lifecycle });
    const infoView = bindInfoDisclosures({ ui, $, lifecycle });
    let lastStatus = "",
      expanded = false,
      onPanelOpened = () => {};
    const reducedMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    function setExpanded(value) {
      infoView.close();
      expanded = value;
      const panel = $("#panel"),
        launcher = $("#launcher");
      launcher.setAttribute("aria-expanded", String(value));
      launcher.setAttribute("aria-label", value ? "收起学习助手" : "打开学习助手");
      if (value) {
        panel.hidden = false;
        panel.inert = false;
        panel.removeAttribute("aria-hidden");
        panel.focus({ preventScroll: true });
        onPanelOpened();
      } else {
        panel.inert = true;
        launcher.focus({ preventScroll: true });
        panel.setAttribute("aria-hidden", "true");
      }
      launcher.tabIndex = value ? -1 : 0;
      menuMotion.transition(value);
    }
    const menuMotion = bindLauncher({
      host,
      panel: $("#panel"),
      launcher: $("#launcher"),
      reducedMotion,
      lifecycle,
      onToggle: () => setExpanded(!expanded),
    });
    const preferences = bindPreferences({ $, icon, lifecycle });
    $("#close-panel").onclick = () => setExpanded(false);
    lifecycle.on(
      document,
      "click",
      (event) => {
        if (!expanded) return;
        const path = event.composedPath?.() || [];
        if (event.target === host || path.includes(host)) return;
        setExpanded(false);
      },
      true,
    );
    lifecycle.on(ui, "keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (infoView.opened) {
        const button = infoView.opened.button;
        infoView.close();
        button.focus();
      } else if (expanded) setExpanded(false);
    });
    function status(message, { logged = false } = {}) {
      if (message === lastStatus) return;
      $("#state").textContent = message;
      $("#status-line").hidden = true;
      const level = /失败|错误|过期|拒绝|无法|不支持|不匹配|阻止/.test(message)
        ? "error"
        : /未响应|重试|未读到|未完成|自动暂停/.test(message)
          ? "warning"
          : "info";
      if (!logged && !["等待预览", "正在识别主播放器…"].includes(message))
        recordEvent("state", "运行状态", message, { level });
      log(message);
      lastStatus = message;
    }
    if (!externalLifecycle)
      window.addEventListener("pagehide", () => lifecycle.dispose(), {
        once: true,
      });
    return {
      lifecycle,
      ui,
      $,
      icon,
      info,
      status,
      get onPanelOpened() {
        return onPanelOpened;
      },
      set onPanelOpened(fn) {
        onPanelOpened = fn;
      },
      set onMuteChanged(fn) {
        preferences.onMuteChanged = fn;
      },
    };
  }

  // src/ui/keyed-list.js
  function createKeyedList({ container, key, create, update }) {
    const entries = /* @__PURE__ */ new Map();
    function render(items) {
      const live = new Set(items.map(key));
      for (const [id, entry] of entries) {
        if (!live.has(id)) {
          entry.element.remove();
          entries.delete(id);
        }
      }
      items.forEach((item, index) => {
        const id = key(item);
        let entry = entries.get(id);
        if (!entry) {
          entry = create(item);
          entries.set(id, entry);
        }
        update(entry, item, index);
        const next = container.children[index] || null;
        if (next !== entry.element) container.insertBefore(entry.element, next);
      });
    }
    return { render };
  }

  // src/ui/log-summary.js
  var summaryRules = [
    [/播放页.*(?:未响应|无响应)/, "等待播放页响应"],
    [/正在恢复|关闭其他课程页|正在重新打开/, "正在重开课程"],
    [/已恢复当前播放页|正在学习|正常播放/, "课程播放中"],
    [/核对失败/, "课程核对失败"],
    [/继续核对|正在核对/, "正在核对课程"],
    [/达到目标|学习结束/, "学习目标已完成"],
    [/请允许.*弹窗|重开课程被拦截/, "课程窗口被拦截"],
    [/手动暂停|主面板已暂停/, "学习已暂停"],
    [/查找课程|继续查找|补充学习计划/, "正在查找课程"],
  ];
  function logSummary(event, detail = "") {
    if (!["运行状态", "预览操作"].includes(event)) return event || "运行状态";
    const text2 = String(detail);
    return (
      summaryRules.find(([pattern]) => pattern.test(text2))?.[1] ||
      text2.split(/[；;\n]/)[0].slice(0, 36) ||
      "运行状态"
    );
  }

  // src/ui/log.js
  function formatLogTime(value, full = false) {
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
  function createLogView({
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
        } catch {}
      }
      if (!rows.length) {
        list.render([]);
        box.textContent = empty;
        return;
      }
      if (!box.children.length) box.textContent = "";
      const occurrences = /* @__PURE__ */ new Map();
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

  // src/diagnostics.js
  function createDiagnostics({ $, lifecycle }) {
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
        ...rows.reverse().map(
          (
            row,
          ) => `${formatLogTime(row.time, true)}；[${eventLevel(row).toUpperCase()}] ${row.event}
${row.detail}${
            row.debug
              ? `
详细状态：${JSON.stringify(row.debug)}`
              : ""
          }`,
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

  // src/settings-schema.js
  var fields = [
    ["target", "10"],
    ["targetMode", "absolute"],
    ["maxMinutes", "75"],
    ["maxRatio", "45"],
    ["window", ""],
    ["annual-limit", true],
    ["goal-total", "90"],
    ["goal-professional", "60"],
    ["goal-public", "18"],
    ["auto", true, false],
    ["category", "auto"],
    ["auto-refresh", true, false],
    ["refresh-minutes", "15", false],
  ];
  var SETTINGS = Object.freeze(
    Object.fromEntries(
      fields.map(([id, defaultValue, affectsPlan = true]) => [
        id,
        Object.freeze({
          defaultValue,
          affectsPlan,
          checkbox: typeof defaultValue === "boolean",
        }),
      ]),
    ),
  );
  var PERSISTED_SETTING_IDS = Object.freeze(Object.keys(SETTINGS));
  var PLAN_SETTING_IDS = Object.freeze(
    PERSISTED_SETTING_IDS.filter((id) => SETTINGS[id].affectsPlan),
  );
  var isCheckboxSetting = (id) => SETTINGS[id]?.checkbox === true;
  var settingDefault = (id) => SETTINGS[id].defaultValue;
  var REFRESH_MINUTES = Object.freeze({ min: 5, max: 240 });
  var validRefreshMinutes = (value) =>
    Number.isFinite(value) && value >= REFRESH_MINUTES.min && value <= REFRESH_MINUTES.max;

  // src/annual-view.js
  function createAnnualView($) {
    function updateEstimatedPanel(saved) {
      const base = saved?.base;
      for (const [id, key] of [
        ["total", "total"],
        ["professional", "professional"],
        ["public", "public"],
      ]) {
        const value = number(base?.[key]);
        $("#estimate-" + id).textContent = Number.isFinite(value) ? String(round(value)) : "—";
      }
    }
    function showAnnualGoals(goals = {}) {
      for (const [id, key, fallback] of [
        ["total", "goal-total", settingDefault("goal-total")],
        ["professional", "goal-professional", settingDefault("goal-professional")],
        ["public", "goal-public", settingDefault("goal-public")],
      ]) {
        const targetAsTotal =
          id === "total" &&
          goals.targetMode === "absolute" &&
          (!goals.category || goals.category === "auto");
        const value = number(targetAsTotal ? goals.target : goals[key]);
        $("#goal-display-" + id).textContent =
          Number.isFinite(value) && value >= 0 ? String(round(value)) : String(fallback);
      }
    }
    function showConfirmedHours({ total, snapshot }) {
      $("#annual-total").textContent = String(total);
      $("#annual-breakdown").textContent = snapshot
        ? `专业 ${round(snapshot.professional)}；行业公需 ${round(snapshot.industry)}；一般公需 ${round(snapshot.general)} 学时`
        : "分类学时暂未完整返回";
    }
    return { updateEstimatedPanel, showAnnualGoals, showConfirmedHours };
  }

  // src/annual-data.js
  async function readLearnedHours({ readAPI, accountScope, scope, year, requestRetries }) {
    const quiet = () => {};
    const seen = /* @__PURE__ */ new Map();
    let expectedTotal = null,
      perPage = null,
      page = 1;
    while (true) {
      const result2 = await readAPI(
        "/api/index/Study.StudyHour/myStudyList",
        { page, limit: 100, schoolyearid: year.schoolyearid },
        quiet,
        requestRetries,
      );
      const p = result2.data,
        count = number(p?.total),
        size = number(p?.per_page),
        current = number(p?.current_page);
      if (
        !Array.isArray(p?.data) ||
        !Number.isInteger(count) ||
        count < 0 ||
        !Number.isInteger(size) ||
        size < 1 ||
        current !== page
      )
        throw new Error("已学列表分页数据不完整");
      if (p.data.length !== Math.min(size, Math.max(0, count - (page - 1) * size)))
        throw new Error("已学列表分页缺少数据");
      if (expectedTotal === null) {
        expectedTotal = count;
        perPage = size;
      } else if (count !== expectedTotal || size !== perPage)
        throw new Error("统计时列表发生变化，请重新统计");
      for (const row of p.data) {
        const id = row.courseid == null ? "" : String(row.courseid).trim();
        const hours = number(row.period),
          category = String(row.coursetype_text || "").trim();
        if (!id || !Number.isFinite(hours) || hours < 0)
          throw new Error("已学列表缺少课程 ID 或学时");
        const old = seen.get(id);
        if (old && (old.hours !== hours || old.category !== category))
          throw new Error("同一课程在列表中的学时或类别不一致");
        seen.set(id, { hours, category });
      }
      if (page * size >= count) break;
      if (!p.data.length || page >= 200) throw new Error("已学列表分页未正常结束");
      page++;
      await sleep(1500);
    }
    if ((await accountScope()) !== scope) throw new Error("平台账户已变化，请重新统计");
    const result = {
      scope,
      year: year.yeartitle.trim(),
      total: 0,
      professional: 0,
      industry: 0,
      general: 0,
      other: 0,
      unknownCount: 0,
      count: seen.size,
      ids: [...seen.keys()],
    };
    for (const { hours, category } of seen.values()) {
      result.total += hours;
      if (category === "专业课程") result.professional += hours;
      else if (category === "行业公需") result.industry += hours;
      else if (category === "一般公需") result.general += hours;
      else {
        result.other += hours;
        result.unknownCount++;
      }
    }
    for (const key of ["total", "professional", "industry", "general", "other"])
      result[key] = round(result[key]);
    if (result.unknownCount) throw new Error("列表含未识别类别，无法合并分类学时");
    return result;
  }
  function readConfirmedHours(data) {
    const study = Array.isArray(data?.data?.study) ? data.data.study : [];
    const totals = study.filter((item) => String(item.typeid) === "0");
    const total = totals.length === 1 ? number(totals[0].s) : NaN;
    if (!Number.isFinite(total) || total < 0)
      throw new Error("暂时无法读取年度学时，可点击刷新或到学时管理系统查看");
    const categories = study.filter((item) => String(item.typeid) !== "0");
    const byName = (name) => categories.filter((item) => String(item.coursetype).trim() === name);
    const professional = byName("专业课程"),
      industry = byName("行业公需"),
      general = byName("一般公需");
    const valid = (row) =>
      row.length === 1 && Number.isFinite(number(row[0].s)) && number(row[0].s) >= 0;
    const snapshot =
      valid(professional) && valid(industry) && valid(general)
        ? {
            total,
            professional: number(professional[0].s),
            industry: number(industry[0].s),
            general: number(general[0].s),
            public: number(industry[0].s) + number(general[0].s),
          }
        : null;
    return { total, snapshot };
  }

  // src/annual-storage.js
  var estimateStorageKey = (scope) => `hz-helper-annual-estimate-v1:${scope}`;
  function saveLearnedEstimate(scope, result) {
    const priorRaw = localStorage.getItem(estimateStorageKey(scope));
    const legacyKey = `hz-helper-legacy-estimate-v1:${scope}`;
    if (priorRaw && !localStorage.getItem(legacyKey)) {
      try {
        const prior = JSON.parse(priorRaw);
        if (number(prior.total) > 0 || (Array.isArray(prior.entries) && prior.entries.length))
          localStorage.setItem(legacyKey, priorRaw);
      } catch {}
    }
    const saved = {
      year: result.year,
      base: {
        total: result.total,
        professional: result.professional,
        industry: result.industry,
        general: result.general,
        public: round(result.industry + result.general),
      },
      source: "已学列表",
    };
    localStorage.setItem(estimateStorageKey(scope), JSON.stringify(saved));
    return saved;
  }

  // src/annual-query.js
  function createAnnualQueries({ readAPI, accountScope }) {
    async function requestMetadata(scope, retries) {
      const data = await readAPI(
        "/api/index/Study.StudyHour/myStudyList",
        { page: 1, limit: 1 },
        () => {},
        retries,
      );
      if ((await accountScope()) !== scope) throw new Error("平台账户已变化，请刷新页面");
      return data;
    }
    function readMetadata(scope, retries = 3, context = null) {
      if (!context) return requestMetadata(scope, retries);
      if (context.scope === scope && context.promise) return context.promise;
      const promise = requestMetadata(scope, retries);
      context.scope = scope;
      context.promise = promise;
      promise.catch(() => {
        if (context.promise === promise) context.promise = null;
      });
      return promise;
    }
    return { readMetadata };
  }

  // src/annual.js
  function createAnnualService({ $, status, readAPI, accountScope, channel, panel }) {
    const { readMetadata } = createAnnualQueries({ readAPI, accountScope });
    let annualBusy = false,
      annualLoaded = false,
      annualSnapshot = null,
      annualYear = "",
      learnedSnapshot = null,
      learnedBusy = false,
      onEstimateUpdated = async () => {},
      learnedTask = null;
    const { updateEstimatedPanel, showAnnualGoals, showConfirmedHours } = createAnnualView($);
    function loadAnnualGoals(scope) {
      try {
        showAnnualGoals(JSON.parse(localStorage.getItem(`hz-helper-settings-v1:${scope}`) || "{}"));
      } catch {
        showAnnualGoals();
      }
    }
    async function refreshAnnual(refreshContext = null) {
      if (annualBusy) return;
      annualBusy = true;
      annualSnapshot = null;
      annualYear = "";
      $("#annual-breakdown").textContent = "";
      $("#annual-total").textContent = "—";
      $("#annual-year").textContent = "正在读取平台学年…";
      try {
        const scope = await accountScope();
        loadAnnualGoals(scope);
        const quietRetry = () => {};
        const managementRequest = readAPI("/api/index/Study.UserIndex/index", {}, quietRetry)
          .then(async (data) => {
            if ((await accountScope()) !== scope) throw new Error("平台账户已变化，请刷新页面");
            const confirmed = readConfirmedHours(data);
            annualSnapshot = confirmed.snapshot;
            showConfirmedHours(confirmed);
          })
          .catch((error) => {
            status(error.message);
          });
        const yearRequest = readMetadata(scope, 3, refreshContext)
          .then(async (data) => {
            if ((await accountScope()) !== scope) throw new Error("平台账户已变化，请刷新页面");
            const first = Array.isArray(data?.year) ? data.year[0] : null;
            const title =
              typeof first?.yeartitle === "string" && first.yeartitle.trim()
                ? first.yeartitle.trim()
                : "";
            annualYear = title;
            $("#annual-year").textContent = title
              ? `平台默认学年：${title}`
              : "平台默认学年：未能读取";
          })
          .catch(() => {
            $("#annual-year").textContent = "平台默认学年：未能读取";
          });
        await Promise.allSettled([managementRequest, yearRequest]);
        let saved = null;
        try {
          saved = JSON.parse(localStorage.getItem(estimateStorageKey(scope)) || "null");
        } catch {}
        if (saved?.year === annualYear && saved.source === "已学列表") updateEstimatedPanel(saved);
        else updateEstimatedPanel(null);
        annualLoaded = true;
      } catch (error) {
        $("#annual-year").textContent = "平台默认学年：未能读取";
        status(error.message);
      } finally {
        annualBusy = false;
      }
    }
    function calculateLearned(fresh = false, requestRetries = 3, refreshContext = null) {
      if (learnedTask)
        return fresh
          ? learnedTask.then(() => calculateLearned(false, requestRetries))
          : learnedTask;
      learnedTask = calculateLearnedNow(requestRetries, refreshContext).finally(() => {
        learnedTask = null;
      });
      return learnedTask;
    }
    async function calculateLearnedNow(requestRetries = 3, refreshContext = null) {
      learnedBusy = true;
      $("#learned-summary").textContent = "";
      try {
        const scope = await accountScope();
        loadAnnualGoals(scope);
        const initial = await readMetadata(scope, requestRetries, refreshContext);
        const year = Array.isArray(initial.year) ? initial.year[0] : null;
        if (
          year?.schoolyearid === null ||
          year?.schoolyearid === void 0 ||
          typeof year.yeartitle !== "string" ||
          !year.yeartitle.trim()
        )
          throw new Error("平台未返回默认学年");
        const result = await readLearnedHours({
          readAPI,
          accountScope,
          scope,
          year,
          requestRetries,
        });
        if (annualYear && annualYear !== result.year)
          throw new Error("平台默认学年已变，请刷新后重试");
        annualYear = result.year;
        $("#annual-year").textContent = `平台默认学年：${result.year}`;
        const saved = saveLearnedEstimate(scope, result);
        learnedSnapshot = result;
        updateEstimatedPanel(saved);
        await onEstimateUpdated(scope, saved);
        channel.postMessage({
          type: "estimate-updated",
          scope,
          year: result.year,
        });
        $("#learned-summary").textContent = "";
        log("已学列表合计", {
          year: result.year,
          count: result.count,
          total: result.total,
        });
        return result;
      } catch (error) {
        $("#learned-summary").textContent = `已学列表统计失败：${error.message}`;
        recordEvent("error", "已学列表统计失败", String(error.message || "未知错误"));
        log("已学列表统计失败", error.message);
        return null;
      } finally {
        learnedBusy = false;
      }
    }
    async function refreshLearnedInBackground() {
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) {
          recordEvent("warning", "已学列表查询重试", `第 ${attempt}/3 次重试`);
          await sleep([5e3, 1e4, 2e4][attempt - 1]);
        }
        const result = await calculateLearned(true, 0);
        if (result) return result;
      }
      $("#learned-summary").textContent = "已学列表查询失败，重试 3 次后仍未成功；可点击刷新";
      log("后台查询已学列表失败，已重试 3 次");
      return null;
    }
    let refreshTask = null;
    function refreshAll() {
      if (refreshTask) return refreshTask;
      recordEvent("refresh", "刷新学时", "同步平台确认值与默认学年已学列表");
      $("#refresh-annual").disabled = true;
      refreshTask = (async () => {
        const refreshContext = {};
        await refreshAnnual(refreshContext);
        return await calculateLearned(true, 3, refreshContext);
      })().finally(() => {
        refreshTask = null;
        $("#refresh-annual").disabled = false;
      });
      return refreshTask;
    }
    $("#refresh-annual").onclick = refreshAll;
    panel.onPanelOpened = () => {
      if (!annualLoaded || !learnedSnapshot) void refreshAll();
    };
    return {
      refreshAnnual,
      calculateLearned,
      refreshLearnedInBackground,
      showAnnualGoals,
      get annualBusy() {
        return annualBusy;
      },
      set annualBusy(value) {
        annualBusy = value;
      },
      get annualLoaded() {
        return annualLoaded;
      },
      set annualLoaded(value) {
        annualLoaded = value;
      },
      get annualSnapshot() {
        return annualSnapshot;
      },
      set annualSnapshot(value) {
        annualSnapshot = value;
      },
      get annualYear() {
        return annualYear;
      },
      set annualYear(value) {
        annualYear = value;
      },
      get learnedSnapshot() {
        return learnedSnapshot;
      },
      set learnedSnapshot(value) {
        learnedSnapshot = value;
      },
      get learnedBusy() {
        return learnedBusy;
      },
      set learnedBusy(value) {
        learnedBusy = value;
      },
      get refreshTask() {
        return refreshTask;
      },
      set refreshTask(value) {
        refreshTask = value;
      },
      get onEstimateUpdated() {
        return onEstimateUpdated;
      },
      set onEstimateUpdated(value) {
        onEstimateUpdated = value;
      },
    };
  }

  // src/recovery-client.js
  function createRecoveryClient({ send, onReceipt, now = () => Date.now() }) {
    let pending = null;
    function transmit() {
      pending.sentAt = now();
      send("recovery-request", { reason: pending.reason, requestId: pending.id });
    }
    function request(reason) {
      if (pending) return;
      pending = { id: crypto.randomUUID(), reason, confirmed: false };
      transmit();
    }
    function tick() {
      if (pending && !pending.confirmed && now() - pending.sentAt >= 1e4) transmit();
    }
    function acknowledge(message) {
      if (
        !pending ||
        message.requestId !== pending.id ||
        !["queued", "running", "blocked"].includes(message.status)
      )
        return;
      if (pending.confirmed) return;
      pending.confirmed = true;
      onReceipt(message);
    }
    return {
      request,
      tick,
      acknowledge,
      clear() {
        pending = null;
      },
    };
  }

  // src/media-errors.js
  function isMediaErrorDialog(node) {
    return !!(
      node.matches?.(".vjs-error-display") && node.closest?.(".video-js")?.querySelector?.("video")
    );
  }
  function readMediaFailure(video, root = document) {
    const code = Number(video?.error?.code);
    if ([1, 2, 3, 4].includes(code)) return { code, source: "native" };
    for (const node of root.querySelectorAll(".video-js .vjs-error-display")) {
      if (!visible(node) || !isMediaErrorDialog(node)) continue;
      const message = String(node.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      if (/playback was aborted due to a corruption/i.test(message))
        return { code: 3, source: "videojs" };
      if (/no compatible source|media could not be loaded|source.*not supported/i.test(message))
        return { code: 4, source: "videojs" };
    }
    return null;
  }

  // src/dialogs.js
  function innermost(nodes) {
    return nodes.filter((node) => !nodes.some((other) => other !== node && node.contains?.(other)));
  }
  function collectDialogs(root = document) {
    const boxes = innermost([...root.querySelectorAll(".el-message-box")].filter(visible));
    const semantics = [...root.querySelectorAll('[role="dialog"],dialog[open]')].filter(
      (node) => visible(node) && !isMediaErrorDialog(node),
    );
    const unknown = innermost(
      semantics.filter(
        (node) =>
          !boxes.some((box) => node === box || node.contains?.(box) || box.contains?.(node)),
      ),
    );
    return { boxes, unknown, count: boxes.length + unknown.length };
  }
  function dialogStackLevel(box) {
    let level = 0,
      node = box;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      const z = Number.parseInt(getComputedStyle(node).zIndex, 10);
      if (Number.isFinite(z)) level = Math.max(level, z);
    }
    return level;
  }

  // src/planner.js
  function classify(message) {
    const t = String(message).replace(/\s+/g, "");
    const match = t.match(
      /^您的学习时间已达到要求，获得学分:([0-9]+(?:\.[0-9]+)?),是否继续学习\?$/,
    );
    if (match && Number(match[1]) > 0) return { type: "complete", credits: Number(match[1]) };
    if (
      /(?:同时|同一时间)(?:只能|只允许|仅能|仅允许)?(?:播放|学习)一(?:个|门)(?:视频|课程)|只能(?:同时)?(?:播放|学习)一(?:个|门)(?:视频|课程)/.test(
        t,
      )
    )
      return { type: "conflict" };
    if (
      /^(?:您(?:的)?|该课程)?(?:学时(?:已)?达标|(?:学习时间|学时)已达到要求|已完成(?:本|该)课程学习|(?:本|该)课程已完成)(?:[，,。]?是否继续学习[?？])?[！!。]?$/.test(
        t,
      )
    )
      return { type: "quota" };
    if (t === "是否继续学习？") return { type: "resume" };
    if (t === "您是否要继续学习?请在2分钟之内点击确定") return { type: "presence" };
    return { type: "unknown" };
  }
  function rank(courses) {
    return [...courses].sort(
      (a, b) =>
        b.hours / b.remaining - a.hours / a.remaining ||
        a.remaining - b.remaining ||
        a.id.localeCompare(b.id),
    );
  }
  function inWindow(value, now = /* @__PURE__ */ new Date()) {
    if (!value.trim()) return true;
    const m = value.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
    if (!m || +m[1] > 23 || +m[3] > 23 || +m[2] > 59 || +m[4] > 59)
      throw new Error("时间段请填写 HH:MM-HH:MM，例如 19:00-23:00");
    const start = +m[1] * 60 + +m[2],
      end = +m[3] * 60 + +m[4],
      minute = now.getHours() * 60 + now.getMinutes();
    return (
      start === end ||
      (start < end ? minute >= start && minute < end : minute >= start || minute < end)
    );
  }
  function normalizeCourse(row, studied = null) {
    const id = row.courseid === void 0 || row.courseid === null ? "" : String(row.courseid);
    const duration = number(row.coursetimes);
    const learned = studied ? number(studied.validstudytime) : number(row.validstudytime ?? 0);
    if (!id || !row.coursename || !(duration > 0) || !(learned >= 0) || learned >= duration)
      return null;
    return {
      id,
      name: String(row.coursename),
      duration,
      learned,
      remaining: duration - learned,
      hours: number(row.period),
      category: String(row.coursetype || "").trim(),
      examChecked: row.examtype_text === "无",
      excludedExam: !!row.examtype_text && row.examtype_text !== "无",
    };
  }
  function eligible(course, settings) {
    const value = course.hours;
    return (
      !course.excludedExam &&
      value > 0 &&
      course.duration <= settings.maxMinutes * 60 &&
      course.remaining > 0 &&
      minutesPerUnit(course) < (settings.maxRatio ?? 45)
    );
  }
  function minutesPerUnit(course) {
    return course.remaining / 60 / course.hours;
  }
  function chooseForGoal(courses, target, earned = 0) {
    const chosen = [];
    let sum = earned;
    for (const course of courses) {
      if (sum >= target) break;
      chosen.push(course);
      sum += course.hours;
    }
    return chosen;
  }
  function categoryGroup(name) {
    if (name === "专业课程") return "professional";
    if (name === "行业公需" || name === "一般公需") return "public";
    return null;
  }
  function annualDeficits(goals, progress) {
    const professional = Math.max(0, goals.professional - progress.professional);
    const publicHours = Math.max(0, goals.public - progress.public);
    const generalExtra = Math.max(
      0,
      goals.annualTotal - progress.total - professional - publicHours,
    );
    return { professional, public: publicHours, generalExtra };
  }
  function annualChoose(courses, goals, progress, earned) {
    const value = { ...progress },
      chosen = [],
      pool = [...courses];
    let roundEarned = earned;
    while (pool.length && !goalReached(goals, roundEarned, value, true)) {
      const deficits = annualDeficits(goals, value);
      const professional = pool.filter((c) => categoryGroup(c.category) === "professional");
      const publicCourses = pool.filter((c) => categoryGroup(c.category) === "public");
      const generalCourses = pool.filter((c) => c.category === "一般公需");
      let available = [];
      if (deficits.professional > 0 && professional.length) available = professional;
      else if (deficits.public > 0 && publicCourses.length) available = publicCourses;
      else if (goals.targetMode === "absolute" && !deficits.professional && !deficits.public)
        available = pool;
      else if (
        goals.targetMode !== "absolute" &&
        deficits.generalExtra > 0 &&
        generalCourses.length
      )
        available = generalCourses;
      if (!available.length) break;
      const course = available[0],
        group = categoryGroup(course.category);
      chosen.push(course);
      pool.splice(pool.indexOf(course), 1);
      roundEarned += course.hours;
      value.total += course.hours;
      if (group) value[group] += course.hours;
    }
    return chosen;
  }
  function parsePage(data, key, page) {
    const p = data[key];
    if (
      !p ||
      !Array.isArray(p.data) ||
      number(p.current_page) !== page ||
      !(number(p.per_page) > 0) ||
      !(number(p.total) >= 0)
    )
      throw new Error("课程分页结构变化或返回页码错误，已停止读取");
    if (p.data.some((row) => row.courseid === void 0 || row.courseid === null || !row.coursename))
      throw new Error("课程 ID / 名称缺失，已停止读取");
    const exhausted = page * number(p.per_page) >= number(p.total);
    if (!p.data.length && !exhausted) throw new Error("分页提前返回空数据，未将其认定为末页");
    return {
      rows: p.data,
      exhausted,
      total: number(p.total),
      signature: p.data
        .map((row) => String(row.courseid))
        .sort()
        .join("|"),
    };
  }
  var usesAnnual = (s) =>
    s.category === "auto" && (s.mode === "annual" || s.targetMode === "absolute");
  function goalReached(s, amount, progress, annual = usesAnnual(s)) {
    if (s.targetMode === "absolute" && annual)
      return (
        !!progress &&
        amount >= s.target &&
        progress.professional >= s.professional &&
        progress.public >= s.public
      );
    return (
      amount >= s.target ||
      (annual &&
        progress &&
        progress.total >= s.annualTotal &&
        progress.professional >= s.professional &&
        progress.public >= s.public)
    );
  }
  function projectProgress(base, courses) {
    if (!base) return null;
    const progress = { ...base };
    for (const course of courses) {
      progress.total += course.hours;
      const group = categoryGroup(course.category);
      if (group) progress[group] += course.hours;
    }
    return progress;
  }

  // src/player-media.js
  function createPlayerMedia({ panel, lifecycle, state, playbackDiagnostic, diagnostics, config }) {
    const { $ } = panel;
    const mutedByHelper = /* @__PURE__ */ new WeakMap();
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
    const observedPlayers = /* @__PURE__ */ new WeakSet();
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

  // src/player-dialogs.js
  function createPlayerDialogs({
    state,
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
  }) {
    const dialogMessages = /* @__PURE__ */ new WeakMap(),
      cycleBoxes = /* @__PURE__ */ new Set();
    const handled = /* @__PURE__ */ new WeakSet(),
      firstSeen = /* @__PURE__ */ new WeakMap(),
      clickedAt = /* @__PURE__ */ new WeakMap(),
      incompleteSince = /* @__PURE__ */ new WeakMap();
    let dialogWasOpen = false;
    async function handle({ dialogBudget, tick }) {
      const { boxes, unknown: unknownDialogs } = collectDialogs();
      const choices = boxes
        .map((box, index) => ({
          box,
          index,
          message: text(box.querySelector(".el-message-box__message")),
        }))
        .map((item) => ({
          ...item,
          kind: classify(item.message),
          level: dialogStackLevel(item.box),
        }));
      const known = choices
        .filter((item) => item.kind.type !== "unknown")
        .sort((a, b) => b.level - a.level || b.index - a.index);
      const selected =
        known.find(
          (item) => !handled.has(item.box) || dialogMessages.get(item.box) !== item.message,
        ) ||
        known[0] ||
        choices[0];
      if (unknownDialogs.length && !known.length) {
        pause("遇到未识别弹窗，保留完成监控；90秒未恢复将重开当前课程", true);
        return true;
      }
      if (selected) {
        const { box, message, kind } = selected;
        cycleBoxes.add(box);
        dialogWasOpen = true;
        if (!message) {
          if (!incompleteSince.has(box)) incompleteSince.set(box, Date.now());
          if (Date.now() - incompleteSince.get(box) < 3e4) {
            status("弹窗尚未加载完整，等待内容出现…");
            return true;
          }
          pause("弹窗内容30秒内仍未加载，请检查后继续");
          return true;
        }
        if (dialogMessages.get(box) !== message) {
          dialogMessages.set(box, message);
          handled.delete(box);
          firstSeen.delete(box);
          clickedAt.delete(box);
          log("弹窗等待诊断", {
            event: "识别弹窗",
            message: message.slice(0, 160),
            visibility: document.visibilityState,
            focused: document.hasFocus?.(),
          });
        }
        if (kind.type === "unknown") {
          pause(`未识别弹窗：${message.slice(0, 100)}；90秒未恢复将重开当前课程`, true);
          return true;
        }
        if (handled.has(box)) {
          if (Date.now() - clickedAt.get(box) > 9e4) {
            log("弹窗等待诊断", {
              event: "点击后90秒仍检测到弹窗",
              message: message.slice(0, 160),
              visibility: document.visibilityState,
              focused: document.hasFocus?.(),
              waitedSeconds: Math.round((Date.now() - clickedAt.get(box)) / 1e3),
            });
            pause("原生按钮点击90秒后弹窗仍未消失，正在重新打开当前课程", true);
            requestRecovery("原生弹窗点击90秒后仍未消失");
          } else status("原生确认已点击，等待平台响应；不会重复提交");
          return true;
        }
        if (!firstSeen.has(box))
          firstSeen.set(box, {
            at: Date.now(),
            delay: document.visibilityState === "hidden" ? 0 : 500,
          });
        const first = firstSeen.get(box);
        if (Date.now() - first.at < first.delay) {
          status(`已识别${kind.type === "complete" ? "平台完成" : "继续学习"}提示，稍后处理…`);
          return true;
        }
        if (["resume", "presence"].includes(kind.type) && !config.autoContinue) {
          pause("继续学习提示待你处理（自动继续未勾选）");
          return true;
        }
        const buttons = [...box.querySelectorAll(".el-message-box__btns button")].filter(visible);
        const label =
          kind.type === "complete" || (kind.type === "quota" && /是否继续学习/.test(message))
            ? "取消"
            : "确定";
        const candidates = buttons.filter((button) => text(button) === label && !button.disabled);
        if (candidates.length !== 1) {
          if (
            buttons.filter((button) => text(button) === label).length <= 1 &&
            Date.now() - first.at < 45e3
          ) {
            status("原生按钮尚未就绪，最多等待45秒…");
            return true;
          }
          pause("原生按钮45秒后仍不可用或不唯一，请检查后继续");
          return true;
        }
        if (kind.type === "conflict") {
          handled.add(box);
          clickedAt.set(box, Date.now());
          exitBridge.arm();
          requestRecovery("平台提示同时只能播放一个视频");
          if (!direct) candidates[0].click();
          return true;
        }
        if (kind.type === "quota") {
          state.completed = true;
          exitBridge.arm();
          sessionStorage.setItem(doneKey, "1");
          if (direct) {
            await rememberDirect("complete");
            void annual.refreshLearnedInBackground();
          } else send("complete-notice", { notice: "course-hours-met" });
          handled.add(box);
          clickedAt.set(box, Date.now());
          candidates[0].click();
          if (!direct) lifecycle.timeout(() => window.close(), ACTION_DELAY_MS);
          status("平台提示课程学时已达标，正在同步已学列表");
          return true;
        }
        if (kind.type === "complete") {
          state.completed = true;
          exitBridge.arm();
          sessionStorage.setItem(doneKey, "1");
          if (!direct)
            localStorage.setItem(
              `hz-helper-completion:${run}:${job}`,
              JSON.stringify({ id: config.course.id, credits: kind.credits }),
            );
          send("complete", { credits: kind.credits });
          if (direct) {
            state.video?.pause();
            await rememberDirect("complete");
            status("平台提示完成，可返回课程列表；已学列表正在后台查询");
            void annual.refreshLearnedInBackground();
            return true;
          }
          status(`平台明确完成，获得 ${kind.credits} 学分，关闭此播放页…`);
        } else log(`点击已核实原生按钮：${kind.type}`);
        handled.add(box);
        clickedAt.set(box, Date.now());
        candidates[0].click();
        if (state.completed)
          lifecycle.timeout(() => {
            if (!window.closed) {
              window.close();
              status("已请求关闭完成页；若仍有浏览器提示，请手动关闭并确认已重开新版课页");
            }
          }, ACTION_DELAY_MS);
        if (
          !state.completed &&
          document.visibilityState === "hidden" &&
          choices.length > 1 &&
          dialogBudget > 1
        )
          await tick(dialogBudget - 1);
        return true;
      }
      if (dialogWasOpen) {
        for (const box of cycleBoxes) {
          handled.delete(box);
          firstSeen.delete(box);
          clickedAt.delete(box);
          incompleteSince.delete(box);
          dialogMessages.delete(box);
        }
        cycleBoxes.clear();
        state.lastAdvance = Date.now();
        dialogWasOpen = false;
      }
      return false;
    }
    return { handle };
  }

  // src/ui/controls.js
  function mountControllerControls({ $, icon: icon2, info }) {
    $("#center-progress").hidden = false;
    $("#controls").innerHTML = html`
      <div class="label-row">
        <label for="target">学习目标</label>
        ${info("target-info", "关于学习目标", "达到总数时，自动类别需同时满足目标总数及设置中的专业、公需要求；指定类别只计算该类别。新增数量以本轮列表增量为基数。")}
      </div>
      <div class="input-row" id="round-target">
        <div class="target-wrap">
          <input id="target" type="text" inputmode="decimal" value="${settingDefault("target")}" />
          <span class="suffix" id="target-unit">学时</span>
        </div>
      </div>
      <div class="select-wrap">
        <select id="targetMode" class="goal-mode" aria-label="目标方式">
          <option value="absolute" ${settingDefault("targetMode") === "absolute" ? "selected" : ""}>
            达到总数
          </option>
          <option
            value="increment"
            ${settingDefault("targetMode") === "increment" ? "selected" : ""}
          >
            新增数量
          </option>
        </select>
        ${icon2("chevron", 16)}
      </div>
      <div class="category-row">
        <span class="select-wrap">
          <select id="category" aria-label="选择课程类别">
            <option value="auto" ${settingDefault("category") === "auto" ? "selected" : ""}>
              自动选择类别
            </option>
            <option value="专业课程" ${settingDefault("category") === "专业课程" ? "selected" : ""}>
              专业课程
            </option>
            <option value="行业公需" ${settingDefault("category") === "行业公需" ? "selected" : ""}>
              行业公需
            </option>
            <option value="一般公需" ${settingDefault("category") === "一般公需" ? "selected" : ""}>
              一般公需
            </option>
          </select>
          ${icon2("chevron", 16)}
        </span>
        <button type="button" id="read-next">查找</button>
      </div>
      <div class="actions" id="scheduler-actions">
        <button type="button" id="plan">查找并安排课程</button>
        <button type="button" class="primary" id="start" aria-label="开始学习" disabled>
          ${icon2("play", 20)}
          <span>开始学习</span>
        </button>
      </div>
      <details>
        <summary>设置</summary>
        <div class="advanced">
          <div class="preference-row">
            <span class="preference-label">
              <label for="annual-limit">新增模式按年度分类要求调度</label>
            </span>
            <input
              id="annual-limit"
              type="checkbox"
              role="switch"
              ${settingDefault("annual-limit") ? "checked" : ""}
            />
          </div>
          <div class="annual-goals" id="annual-goals">
            <div class="field" id="annual-total-field">
              <label for="goal-total">年度总学时</label>
              <input
                id="goal-total"
                type="text"
                inputmode="decimal"
                value="${settingDefault("goal-total")}"
              />
            </div>
            <div class="field">
              <label for="goal-professional">专业课程学时</label>
              <input
                id="goal-professional"
                type="text"
                inputmode="decimal"
                value="${settingDefault("goal-professional")}"
              />
            </div>
            <div class="field">
              <label for="goal-public">行业与一般公需合计</label>
              <input
                id="goal-public"
                type="text"
                inputmode="decimal"
                value="${settingDefault("goal-public")}"
              />
            </div>
          </div>
          <div class="field">
            <div class="setting-label">
              <label for="maxMinutes">时长上限（分钟）</label>
              ${info("duration-info", "关于时长上限", "按单门课程总时长筛选。0.5学时等小课也参与排序。")}
            </div>
            <input
              id="maxMinutes"
              type="text"
              inputmode="decimal"
              value="${settingDefault("maxMinutes")}"
            />
          </div>
          <div class="field">
            <div class="setting-label">
              <label for="maxRatio">每学时上限（分钟）</label>
              ${info("ratio-info", "关于每学时上限", "预计剩余分钟数除以课程学时，严格小于该数值才加入计划。")}
            </div>
            <input
              id="maxRatio"
              type="text"
              inputmode="decimal"
              value="${settingDefault("maxRatio")}"
            />
          </div>
          <div class="field time">
            <div class="setting-label">
              <label for="window" id="window-current">开课时段：全天</label>
              ${info("window-info", "关于开课时段", "留空表示全天。只限制新开课时间，当前课程会继续学习。")}
            </div>
            <input
              id="window"
              value="${settingDefault("window")}"
              type="text"
              placeholder="例如 19:00-23:00"
              aria-label="新开课时段，留空全天"
            />
          </div>
          <div class="preference-row">
            <span class="preference-label">
              <label for="auto">自动继续学习</label>
              ${info("continue-info", "关于自动继续", "自动处理已识别的续播提示。需要你处理的其他提示可在日志中查看。")}
            </span>
            <input
              id="auto"
              type="checkbox"
              role="switch"
              ${settingDefault("auto") ? "checked" : ""}
            />
          </div>
          <div class="preference-row">
            <span class="preference-label">
              <label for="auto-refresh">定时刷新主页面</label>
              ${info("auto-refresh-info", "关于定时刷新", "只刷新调度主页面，学习期间按间隔执行；页面刷新不保证登录续期，恢复失败会等待手动处理。")}
            </span>
            <input
              id="auto-refresh"
              type="checkbox"
              role="switch"
              ${settingDefault("auto-refresh") ? "checked" : ""}
            />
          </div>
          <div class="field">
            <label for="refresh-minutes">刷新间隔（分钟）</label>
            <input
              id="refresh-minutes"
              type="text"
              inputmode="decimal"
              value="${settingDefault("refresh-minutes")}"
            />
          </div>
          <div class="settings-actions">
            <button type="button" id="reset" class="reset">从第1页重新读取</button>
            <button type="button" class="reset" id="sync-history">同步平台已学</button>
          </div>
          <p id="history-progress" role="status" aria-live="polite"></p>
        </div>
      </details>
      <details id="history-details" hidden>
        <summary>排除</summary>
        <div id="records"></div>
      </details>
    `;
    $("#dashboard").innerHTML = html`
      <div class="stats">
        <div class="stat">
          <span>本轮列表增量</span>
          <strong id="earned">0</strong>
          <small id="earned-unit">学时</small>
        </div>
        <div class="stat">
          <span>计划待学</span>
          <strong id="queued">0</strong>
          <small>门</small>
        </div>
      </div>
      <div class="round-progress">
        ${progressBar({ trackId: "round-progress-bar", fillId: "bar", label: "本轮学习目标进度" })}
      </div>
    `;
  }
  function mountPlayerControls({ $, icon: icon2 }) {
    $("#center-progress").hidden = true;
    $("#controls").innerHTML = html`
      <div class="worker-actions">
        <button
          type="button"
          class="primary playback-toggle"
          id="playback-toggle"
          aria-label="继续播放"
        >
          ${icon2("play", 20)}
          <span>继续播放</span>
        </button>
      </div>
      <div class="manual-buttons pill-actions">
        <button
          type="button"
          id="worker-learned"
          class="quiet-action"
          title="已学，跳过此课"
          aria-label="已学，跳过此课"
        >
          ${icon2("check", 18)}
        </button>
        <button
          type="button"
          id="worker-remove"
          class="quiet-action"
          title="移除此课"
          aria-label="移除此课"
        >
          ${icon2("trash", 18)}
        </button>
      </div>
    `;
  }

  // src/playback.js
  var playbackBlocked = (error) =>
    ["NotAllowedError", "SecurityError", "NotSupportedError"].includes(error.name);
  function requestPlayback(player, timeoutMs = 0) {
    const playing = player.play();
    if (!timeoutMs) return playing;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("播放启动等待超时")), timeoutMs);
    });
    return Promise.race([playing, timeout]).finally(() => clearTimeout(timer));
  }

  // src/player.js
  function startPlayer(env) {
    const { panel, runtime, annual, diagnostics, channel, accountScope, lifecycle } = env;
    const { $, status } = panel;
    const { run, job, direct, directConfig, exitBridge } = runtime;
    const { playbackDiagnostic } = diagnostics;
    $("#preview").replaceChildren();
    let config;
    try {
      config = directConfig || JSON.parse(localStorage.getItem(configKey(run)) || "null");
    } catch {}
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
                nextPlayAt = Date.now() + 5e3;
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
        /* @__PURE__ */ Object.create(null),
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
      if (Date.now() - lastBeat > 2e3) {
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
      if (!enabled && automaticPauseAt && Date.now() - automaticPauseAt >= 9e4)
        requestRecovery(`播放自动暂停超过90秒：${pauseReason}`);
      if (!enabled || !locked) return;
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
        if (elapsed >= 18e4) pause("已自动重试识别3分钟，主播放器仍未出现；请检查后继续");
        else
          status(
            `主播放器尚未出现，自动重试识别（${Math.min(3, Math.floor(elapsed / 6e4) + 1)}/3轮，最多3分钟）`,
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
        if (Date.now() - networkErrorSince >= 18e4)
          requestRecovery("播放器网络错误 code=2 持续3分钟，关闭后重开当前课程");
        else
          status(
            `视频网络异常，等待原播放器恢复（${Math.min(3, Math.floor((Date.now() - networkErrorSince) / 6e4) + 1)}/3轮）；持续3分钟后重开当前课程`,
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
          const diagnostic2 = `${frameReport.state}:${frameReport.error || ""}`;
          if (diagnostic2 !== lastFrameDiagnostic) {
            lastFrameDiagnostic = diagnostic2;
            playbackDiagnostic(
              "课件播放状态",
              `${frameReport.selector || "原生控件"}；状态 ${frameReport.state}；${frameReport.error || "未报告播放错误"}`,
            );
          }
          if (["blocked", "error", "unsupported"].includes(frameReport.state)) {
            frameBlockedAt || (frameBlockedAt = Date.now());
            status(
              `课件播放未恢复：${frameReport.error || frameReport.state}；正在重试原生播放按钮`,
            );
            if (Date.now() - frameBlockedAt >= 9e4)
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
            if (frameReport.ended && !direct && Date.now() - lastFrameVerifyAt >= 6e4) {
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
          if (Date.now() - frameSince >= 9e4)
            requestRecovery("课件内容90秒未能读取，关闭后重开当前课程；不自动排除");
          return;
        }
        const grace = 1e4;
        if (Date.now() - frameSince < grace) {
          status("正在识别 iframe 原生播放控件…");
          return;
        }
        if (direct) {
          pause("未识别此 iframe 课件，可返回课程列表选择其他课程");
          return;
        }
        if (!lastFrameSkip || Date.now() - lastFrameSkip >= 5e3) {
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
            nextPlayAt = Date.now() + 6e4;
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
          await requestPlayback(video, 15e3);
          lastAdvance = Date.now();
          nextPlayAt = Date.now() + 1e4;
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
          const delay = [5e3, 1e4, 2e4][playAttempts - 1];
          nextPlayAt = Date.now() + delay;
          playbackAttempted = false;
          status(`播放启动较慢，${delay / 1e3}秒后重试（${playAttempts}/3）`);
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
          if (Date.now() - playbackStableSince >= 3e4) unexpectedPauseRetries = 0;
        }
        if (Date.now() - lastAdvance >= 18e4) {
          pause("视频3分钟没有前进，请检查网络后继续；未重开课程或跳转进度");
          return;
        }
        status(
          video.readyState < 3 || Date.now() - lastAdvance > 15e3
            ? "视频正在缓冲，继续等待网络恢复（最多3分钟）"
            : "正常播放中（1倍速），等待平台完成提示",
        );
      } else if (video.readyState < 2) {
        if (Date.now() - lastAdvance >= 18e4) pause("视频数据3分钟内仍未就绪，请检查后继续");
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
    }, 1e3);
    status(direct ? "已接管当前课程，自动识别并尝试播放" : "正在识别主播放器…");
    send("heartbeat", { completed: false });
  }

  // src/controller-state.js
  var createControllerState = () => ({
    pending: [],
    active: false,
    paused: true,
    busy: false,
    starting: false,
    historyBusy: false,
    catalogBusy: false,
    completing: false,
    acquired: false,
    release: null,
    current: null,
    child: null,
    total: 0,
    roundStart: null,
    lastHeartbeat: 0,
    missingSince: 0,
    planSettings: null,
    roundDone: false,
    annualBase: null,
    searching: false,
    cancelSearch: false,
    heartbeatPaused: false,
    manualPaused: false,
    recovering: false,
    probe: "",
  });
  function pausePlan(state, dueToHeartbeat = false) {
    if (state.searching) state.cancelSearch = true;
    state.paused = true;
    state.heartbeatPaused = dueToHeartbeat;
    state.manualPaused = !dueToHeartbeat;
  }
  function pauseFromWorker(state, manual) {
    state.manualPaused = state.manualPaused || manual;
    state.paused = true;
    state.heartbeatPaused = !state.manualPaused;
  }
  function resumeFromWorker(state) {
    state.paused = false;
    state.heartbeatPaused = false;
    state.manualPaused = false;
  }
  function finishRound(state) {
    state.active = false;
    state.paused = true;
    state.roundDone = true;
  }
  var canSchedule = (state) =>
    state.active &&
    ![state.paused, state.busy, state.catalogBusy, state.completing, state.recovering].some(
      Boolean,
    );

  // src/controller-messages.js
  var isCurrentCourseMessage = (message, state, session) =>
    !!state.current &&
    message?.run === session &&
    message?.job === state.current.job &&
    String(message.id) === state.current.course.id;
  function createControllerMessageHandler({
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
      if (
        m?.type === "estimate-updated" &&
        m.scope === store.scope &&
        m.year === annual.annualYear
      ) {
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
        if (Date.now() - (state.current.lastVerificationHintAt || 0) >= 3e4) {
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
      if (
        m.type === "complete" &&
        !state.current.skipped &&
        !finished.has(state.current.course.id)
      ) {
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

  // src/settings.js
  var readPlanSettings = ($) => ({
    target: number($("#target").value),
    targetMode: $("#targetMode").value || "increment",
    unit: "hours",
    maxMinutes: number($("#maxMinutes").value),
    maxRatio: number($("#maxRatio").value),
    window: $("#window").value.trim(),
    autoContinue: $("#auto").checked,
    mode: $("#annual-limit").checked ? "annual" : "round",
    annualTotal: number($("#goal-total").value),
    professional: number($("#goal-professional").value),
    public: number($("#goal-public").value),
    category: $("#category").value || "auto",
  });
  var samePlanSettings = (s, current) =>
    current &&
    [
      "target",
      "targetMode",
      "unit",
      "maxMinutes",
      "maxRatio",
      "window",
      "mode",
      "annualTotal",
      "professional",
      "public",
      "category",
    ].every((key) => Object.is(s[key], current[key]));
  function validatePlanSettings(s, annual) {
    if (s.mode === "annual" || usesAnnual(s)) {
      if ((!annual.annualSnapshot && !annual.learnedSnapshot) || !annual.annualYear)
        throw new Error("请先刷新平台学时，确认分类和平台默认学年已读取");
      if (
        ![s.annualTotal, s.professional, s.public].every(
          (v) => Number.isFinite(v) && v >= 0 && v <= 1e4,
        )
      )
        throw new Error("年度目标须在 0–10000 学时之间");
    }
    if (!["absolute", "increment"].includes(s.targetMode)) throw new Error("目标方式无效");
    if (!["auto", "专业课程", "行业公需", "一般公需"].includes(s.category))
      throw new Error("课程类别无效");
    if (!(s.target > 0 && s.target <= 1e4)) throw new Error("学习目标需大于 0 且不超过 10000");
    if (!(s.maxMinutes > 0 && s.maxMinutes <= 600)) throw new Error("单课上限需在 1–600 分钟之间");
    if (!(s.maxRatio > 0 && s.maxRatio <= 600)) throw new Error("每学时上限需在 1–600 分钟之间");
    inWindow(s.window);
  }

  // src/auto-refresh.js
  function createAutoRefresh({ state, panel, annual, centerMonitor }) {
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
        ? Math.max(0, Math.ceil((lastAutoRefresh + minutes * 6e4 - Date.now()) / 1e3))
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
      if (Date.now() - lastAutoRefresh < minutes * 6e4) return;
      lastAutoRefresh = Date.now();
      sessionStorage.setItem(refreshTimeKey, String(lastAutoRefresh));
      timer.textContent = "正在刷新";
      recordEvent("page", "定时刷新主页面", `设置间隔 ${minutes} 分钟；已保存计划，刷新后尝试恢复`);
      log("按设置刷新主页面");
      location.reload();
    }
    return checkAutoRefresh;
  }

  // src/completion.js
  function createCompletionHandler({ state, store, finished, save: save2 }) {
    function markComplete(task, source) {
      finished.add(task.course.id);
      if (!store.cache.completed.includes(task.course.id))
        store.cache.completed.push(task.course.id);
      store.records[task.course.id] = {
        id: task.course.id,
        name: task.course.name,
        kind: "complete",
        ...(source ? { source } : {}),
        at: Date.now(),
        course: task.course,
      };
      task.complete = true;
      if (state.heartbeatPaused && !state.manualPaused) {
        state.paused = false;
        state.heartbeatPaused = false;
      }
      save2();
    }
    return markComplete;
  }

  // src/course-launcher.js
  function createCourseLauncher({
    state,
    repository,
    session,
    panel,
    settings,
    samePlan,
    reached,
    render,
    stop,
    fail,
    lock,
    probePlayers,
    reconnectCourse,
    rebuild,
    tick,
    lifecycle,
    readAPI,
    messageWorker,
  }) {
    const { state: store, identity, save: save2 } = repository;
    const { $, status } = panel;
    async function launch() {
      if (state.paused || !state.active || state.current) return;
      if ((await identity()) !== store.scope)
        throw new Error("登录凭据已变化，请刷新主面板重新规划");
      while (state.pending.length && !state.paused) {
        const course = state.pending[0];
        if (!course.examChecked) {
          status(`正在读取课程要求：${course.name}`);
          const detail = await readAPI("/api/index/index/getCourseInfo", {
            courseid: course.id,
          });
          if (!detail.data || !["无", "W"].includes(detail.data.examtype)) {
            recordEvent("warning", "课程未加入自动播放", `${course.name}；考核类型未确认为无考核`);
            log("跳过未确认无考核的课程", { id: course.id });
            store.cache.pending = store.cache.pending.filter((c) => c.id !== course.id);
            save2();
            rebuild(state.planSettings);
            render();
            await sleep(1500);
            continue;
          }
          recordEvent("query", "课程要求已确认", `${course.name}；无考核`);
          course.examChecked = true;
          const stored = store.cache.pending.find((c) => c.id === course.id);
          if (stored) stored.examChecked = true;
          save2();
        }
        if (state.paused) return;
        openCourse(course);
        return;
      }
    }
    let preparedWindow = null;
    lifecycle.defer(() => {
      try {
        if (preparedWindow?.location.href === "about:blank") preparedWindow.close();
      } catch {}
      preparedWindow = null;
    });
    function openCourse(course) {
      if (lifecycle.disposed) return false;
      const id = crypto.randomUUID();
      localStorage.setItem(
        configKey(session),
        JSON.stringify({
          job: id,
          course,
          autoContinue: settings().autoContinue,
        }),
      );
      const params = new URLSearchParams({
        courseId: course.id,
        coursetitle: course.name,
        __hzRun: session,
        __hzJob: id,
      });
      const url = `${ORIGIN}/#/class?${params}`;
      let opened;
      if (preparedWindow && !preparedWindow.closed) {
        opened = preparedWindow;
        preparedWindow = null;
        if (opened.location.href !== "about:blank")
          throw new Error("准备页已跳转到其他页面，请重新开始学习");
        opened.name = `hz-helper-${session}-${id}`;
        opened.location.href = url;
      } else {
        opened = window.open(url, `hz-helper-${session}-${id}`);
      }
      if (!opened) {
        stop("请允许本站弹窗，再点击继续学习");
        return false;
      }
      state.child = opened;
      state.current = {
        job: id,
        course,
        complete: false,
        startedAt: Date.now(),
        lastProgressAt: Date.now(),
      };
      state.lastHeartbeat = Date.now();
      state.missingSince = 0;
      $("#center-status").textContent = "";
      $("#center-status").hidden = true;
      render();
      status("正在学习");
      return true;
    }
    $("#start").onclick = async (event) => {
      if (state.starting) return;
      if (state.active && !state.paused) {
        stop();
        return;
      }
      if (state.busy) return;
      state.busy = true;
      state.starting = true;
      render();
      try {
        if (
          event?.isTrusted &&
          state.planSettings &&
          samePlan(settings()) &&
          !reached(state.planSettings) &&
          inWindow(state.planSettings.window) &&
          (!state.current || state.child?.closed)
        ) {
          preparedWindow = window.open("about:blank", `hz-helper-prepare-${crypto.randomUUID()}`);
          if (!preparedWindow) throw new Error("浏览器阻止打开课程页，请允许本站弹窗后重试");
        }
        if (state.current && !state.child && !(await reconnectCourse())) {
          await probePlayers();
          await new Promise((resolve, reject) =>
            navigator.locks
              .request("hz-helper-player-v1", { ifAvailable: true }, (token) =>
                token
                  ? resolve()
                  : reject(new Error("课程页仍在运行，暂不能重新打开；请切回课程页检查")),
              )
              .catch(reject),
          );
          state.child = { closed: true };
        }
        if (route() === "#/class")
          throw new Error("请在学习中心或网络课程页调度，先关闭手动播放页");
        if (!state.planSettings || !samePlan(settings())) throw new Error("请先按当前设置预览课程");
        if (reached(state.planSettings)) throw new Error("目标已达到，请调整目标后重新查找");
        if (!state.pending.length && !state.current)
          throw new Error("当前批次无候选，请先预览下一批");
        if ((await identity()) !== store.scope)
          throw new Error("登录凭据已变化，请刷新主面板重新规划");
        await lock();
        const reopen =
          !!state.current &&
          !!state.child?.closed &&
          !state.current.complete &&
          !state.current.skipped;
        if (!state.current || reopen) await probePlayers();
        if (state.manualPaused && state.current) state.current.resumedAt = Date.now();
        state.active = true;
        state.paused = false;
        state.heartbeatPaused = false;
        state.manualPaused = false;
        render();
        if (reopen) {
          openCourse(state.current.course);
        } else if (state.current && state.child?.closed) {
          status("课页已关闭，正在继续调度");
          lifecycle.timeout(
            () =>
              tick().catch((error) => {
                stop();
                fail(error);
              }),
            0,
          );
        } else if (state.current) {
          messageWorker("resume");
          render();
          status("已恢复当前播放页");
        } else if (inWindow(state.planSettings.window)) await launch();
        else status("等待新开课时间段，保持本面板打开");
      } catch (error) {
        stop();
        fail(error);
      } finally {
        if (preparedWindow) {
          try {
            if (preparedWindow.location.href === "about:blank") preparedWindow.close();
          } catch {}
          preparedWindow = null;
        }
        state.starting = false;
        state.busy = false;
        render();
      }
    };
    return { launch, openCourse };
  }

  // src/recovery.js
  var STALL_MS = 20 * 60 * 1e3;
  function observePlatformProgress(job, seconds, now = Date.now()) {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    if (job.lastPlatformSeconds === void 0 || seconds > job.lastPlatformSeconds) {
      if (job.lastPlatformSeconds !== void 0 || seconds > 0) job.lastProgressAt = now;
      job.lastPlatformSeconds = seconds;
    }
  }
  function createRecovery({
    state,
    repository,
    channel,
    panel,
    session,
    openCourse,
    probePlayers,
    checkCenter,
    isMonitorBusy,
    lifecycle,
  }) {
    const { state: store, identity } = repository;
    const { status } = panel;
    let checking = false,
      lastRecoveryAt = -Infinity,
      pending = null,
      pendingTimer = null;
    const allowed2 = (job) =>
      !lifecycle.disposed &&
      state.active &&
      !state.manualPaused &&
      (!state.paused || state.heartbeatPaused) &&
      state.current === job &&
      !job?.complete &&
      !job?.skipped;
    function schedulePending(delay = ACTION_DELAY_MS) {
      if (pendingTimer !== null || lifecycle.disposed) return;
      pendingTimer = lifecycle.timeout(() => {
        pendingTimer = null;
        const task = pending;
        if (!task) return;
        if (!allowed2(task.job)) {
          pending = null;
          return;
        }
        void recover(task.job, task.reason, task.onlyIfStalled);
      }, delay);
    }
    function enqueue(job, reason, onlyIfStalled, delay = ACTION_DELAY_MS) {
      const previous = pending;
      if (previous?.job === job && !previous.onlyIfStalled && onlyIfStalled) {
        schedulePending(delay);
        return;
      }
      pending = { job, reason, onlyIfStalled };
      if (previous?.job !== job || previous.reason !== reason)
        recordEvent("recovery", "恢复请求已排队", `${reason}；等待主面板空闲后重开当前课程`);
      schedulePending(delay);
    }
    function request(job, reason) {
      if (!job || !allowed2(job)) {
        const detail = state.manualPaused
          ? "主面板已手动暂停，保留暂停，不自动重开"
          : "当前计划或任务状态不允许自动恢复";
        recordEvent("warning", "恢复请求暂未执行", detail);
        return { status: "blocked", detail };
      }
      void recover(job, reason);
      return state.recovering
        ? { status: "running", detail: "主面板已开始核对并恢复当前课程" }
        : { status: "queued", detail: "主面板已接收，等待空闲或恢复冷却结束后执行" };
    }
    function retryPermission(run, job, id) {
      localStorage.setItem(
        closeApprovalKey(run, job),
        JSON.stringify({ source: "recovery", id: String(id), at: Date.now() }),
      );
    }
    function closeKnownWindows(job) {
      const windows = /* @__PURE__ */ new Set();
      if (state.child) {
        try {
          const page = state.child;
          if (
            !page.location ||
            (page.location.origin === ORIGIN &&
              page.location.hash?.split("?")[0].toLowerCase() === "#/class")
          )
            windows.add(page);
          else if (!page.location.origin && page.location.href?.startsWith(`${ORIGIN}/#/class?`))
            windows.add(page);
        } catch {}
      }
      retryPermission(session, job.job, job.course.id);
      for (const page of windows) {
        try {
          if (!page.closed) page.close();
        } catch {}
      }
      return windows;
    }
    async function recover(job, reason, onlyIfStalled = false) {
      if (!job || !allowed2(job) || state.recovering) return;
      if (state.busy) {
        enqueue(job, reason, onlyIfStalled);
        return;
      }
      if (Date.now() - lastRecoveryAt < 6e4) {
        enqueue(job, reason, onlyIfStalled, 6e4 - (Date.now() - lastRecoveryAt));
        return;
      }
      lastRecoveryAt = Date.now();
      pending = null;
      state.recovering = true;
      state.busy = true;
      recordEvent(
        "recovery",
        "开始恢复当前课程",
        `${reason}；关闭课程页后重开同一课程，不计入完成`,
      );
      status("正在恢复：关闭其他课程页，然后重开当前课程");
      try {
        if ((await identity()) !== store.scope) throw new Error("账户已变化，停止恢复");
        await checkCenter(true);
        if (job.centerMonitor?.missing > 0 && !job.complete) {
          await sleep(5e3);
          await checkCenter(true);
        }
        if (
          onlyIfStalled &&
          Date.now() - Math.max(job.lastProgressAt ?? job.startedAt, job.resumedAt ?? 0) < STALL_MS
        )
          return;
        if (!allowed2(job)) return;
        retryPermission(session, job.job, job.course.id);
        channel.postMessage({
          type: "recovery-close",
          run: session,
          recovery: crypto.randomUUID(),
        });
        const windows = closeKnownWindows(job);
        for (let attempt = 0; attempt < 3; attempt++) {
          await sleep(ACTION_DELAY_MS);
          if (!allowed2(job)) return;
          if ([...windows].every((page) => page.closed)) break;
          for (const page of windows) {
            try {
              if (!page.closed) page.close();
            } catch {}
          }
        }
        if ([...windows].some((page) => !page.closed))
          throw new Error("浏览器未关闭旧课程页，请处理离开提示后继续");
        await probePlayers();
        await new Promise((resolve, reject) =>
          navigator.locks
            .request("hz-helper-player-v1", { ifAvailable: true }, (token) =>
              token ? resolve() : reject(new Error("仍有课程页占用播放锁，暂不另开课程")),
            )
            .catch(reject),
        );
        if (!allowed2(job) || (await identity()) !== store.scope) return;
        state.paused = false;
        state.heartbeatPaused = false;
        if (openCourse(job.course)) {
          localStorage.removeItem(closeApprovalKey(session, job.job));
          recordEvent("recovery", "已重新打开当前课程", "保持原课程与平台进度，未跳过、未增加学时");
        } else
          recordEvent("error", "重开课程被拦截", "请允许平台弹出课程页后点击继续；没有记录为完成");
      } catch (error) {
        recordEvent("error", "课程恢复未完成", String(error.message || "无法重新打开课程页"));
        status(`恢复未完成：${error.message}；保留计划，稍后重试`);
        enqueue(job, reason, onlyIfStalled, 6e4);
      } finally {
        state.recovering = false;
        state.busy = false;
      }
    }
    async function checkStall() {
      const job = state.current;
      if (!job || !allowed2(job) || checking || state.recovering || state.busy || isMonitorBusy())
        return;
      if (pending?.job === job && Date.now() - lastRecoveryAt >= 6e4) {
        await recover(job, pending.reason, pending.onlyIfStalled);
        return;
      }
      job.startedAt ?? (job.startedAt = Date.now());
      if (Date.now() - Math.max(job.lastProgressAt ?? job.startedAt, job.resumedAt ?? 0) < STALL_MS)
        return;
      checking = true;
      try {
        await checkCenter(true);
        if (
          allowed2(job) &&
          Date.now() - Math.max(job.lastProgressAt ?? job.startedAt, job.resumedAt ?? 0) >= STALL_MS
        )
          await recover(job, "平台进度超过20分钟没有增长", true);
      } finally {
        checking = false;
      }
    }
    return { recover, request, checkStall };
  }

  // src/history.js
  function createHistorySync({ state, repository, readAPI, panel, rebuild, settings, render }) {
    const { state: store, ensureCache, save: save2, blocked } = repository;
    const { $, status } = panel;
    const progress = (message) => {
      $("#history-progress").textContent = message;
    };
    return async () => {
      if (state.historyBusy) return;
      state.historyBusy = true;
      $("#sync-history").disabled = true;
      $("#sync-history").textContent = "正在同步平台已学…";
      let read2 = 0,
        added = 0;
      try {
        await ensureCache();
        progress("正在读取平台学年列表…");
        const initial = await readAPI(
          "/api/index/Study.StudyHour/myStudyList",
          { page: 1, limit: 1 },
          progress,
        );
        const years = (Array.isArray(initial.year) ? initial.year : [])
          .filter((y) => y.schoolyearid !== void 0 && y.schoolyearid !== null)
          .map((y) => ({
            id: String(y.schoolyearid),
            title: String(y.yeartitle || y.schoolyearid),
          }));
        if (!years.length) throw new Error("平台未返回学年列表，无法为记录确定学年");
        await ensureCache();
        store.historyYears = years;
        store.historySynced = false;
        save2(["history"]);
        for (const [index, year] of years.entries()) {
          const prefix = `同步 ${year.title}（${index + 1}/${years.length} 学年）`;
          for (let page = 1; page <= 200; page++) {
            progress(`${prefix}；正在读取第 ${page} 页；已读取 ${read2} 条，新增 ${added} 条`);
            const data = await readAPI(
              "/api/index/Study.StudyHour/myStudyList",
              { page, limit: 100, schoolyearid: year.id },
              (message2) => progress(`${prefix}；第 ${page} 页；${message2}`),
            );
            const pager = data.data,
              rows = pager?.data,
              total = number(pager?.total),
              size = number(pager?.per_page ?? data.per_page),
              current = number(pager?.current_page ?? data.current_page);
            if (
              !Array.isArray(rows) ||
              !Number.isInteger(total) ||
              total < 0 ||
              !Number.isInteger(size) ||
              size < 1 ||
              current !== page
            )
              throw new Error("学习记录分页结构未匹配，已保存成功读取的记录");
            if (rows.length !== Math.min(size, Math.max(0, total - (page - 1) * size)))
              throw new Error("学习记录分页缺少数据，已保存成功读取的记录");
            await ensureCache();
            const map = new Map(store.history.map((item) => [`${item.yearId}\0${item.id}`, item]));
            let pageAdded = 0;
            for (const row of rows) {
              if (row.courseid === void 0 || row.courseid === null || !String(row.courseid).trim())
                throw new Error("学习记录缺少课程ID，已停止读取");
              const id = String(row.courseid),
                key = `${year.id}\0${id}`;
              if (!map.has(key)) pageAdded++;
              map.set(key, {
                id,
                name: String(row.coursename || id),
                yearId: year.id,
                yearTitle: year.title,
                examtype: row.examtype == null ? null : String(row.examtype),
              });
            }
            store.history = [...map.values()];
            store.historyIds = new Set(store.history.map((item) => String(item.id)));
            store.cache.pending = store.cache.pending.filter((c) => !blocked(c.id));
            save2(["cache", "history"]);
            read2 += rows.length;
            added += pageAdded;
            progress(
              `${prefix}；已读取第 ${page}/${Math.max(1, Math.ceil(total / size))} 页；已读取 ${read2} 条，新增 ${added} 条`,
            );
            recordEvent(
              "history",
              "已学同步进度",
              `${year.title}；第 ${page} 页；本页 ${rows.length} 条；累计 ${read2} 条，新增 ${added} 条`,
            );
            if (page * size >= total) break;
            if (!rows.length || page === 200)
              throw new Error("学习记录分页未正常结束，已保存已读取记录");
          }
        }
        store.historySynced = true;
        save2(["history"]);
        const message = `已读取 ${read2} 条学习记录；新增 ${added} 条；本地共 ${store.history.length} 条，已学课程已过滤`;
        progress(message);
        recordEvent("history", "已学同步完成", message);
      } catch (error) {
        const message = `已学同步未完成：${error.message}；已读取 ${read2} 条，新增 ${added} 条`;
        progress(message);
        recordEvent("error", "已学同步失败", message);
        if (!state.active) status(message);
      } finally {
        rebuild(state.planSettings || settings());
        render();
        $("#start").disabled = !state.active && !state.pending.length && !state.current;
        state.historyBusy = false;
        $("#sync-history").disabled = false;
        $("#sync-history").textContent = "同步平台已学";
      }
    };
  }

  // src/planning.js
  function createPlanning({
    state,
    repository,
    annual,
    panel,
    settings,
    validate,
    targetProgress,
    rebuild,
    render,
    hasMore,
    readBatch,
    stop,
    fail,
    finished,
    reached,
  }) {
    const { ensureCache, estimateKey, saveSettings } = repository;
    const { $, status } = panel;
    const amount = (course) => course.hours,
      unitName = () => "学时";
    function planSatisfied(s) {
      return goalReached(
        s,
        targetProgress(s) + state.pending.reduce((sum, c) => sum + c.hours, 0),
        projectProgress(state.annualBase, state.pending),
      );
    }
    async function searchUntilSatisfied(s, forceRead = false) {
      const mineContext = {};
      state.searching = true;
      state.cancelSearch = false;
      try {
        while (!state.cancelSearch && hasMore(s) && (forceRead || !planSatisfied(s))) {
          const readPage = await readBatch(s, 1, mineContext);
          if (readPage) forceRead = false;
          if (!state.cancelSearch && hasMore(s) && !planSatisfied(s)) await sleep(1500);
        }
      } finally {
        state.searching = false;
      }
    }
    async function makePlan(forceRead = false) {
      if (state.busy || state.catalogBusy || state.searching) return;
      if (state.current && state.child && !state.child.closed) {
        state.catalogBusy = true;
        $("#plan").disabled = true;
        $("#read-next").disabled = true;
        try {
          await ensureCache();
          const s = state.planSettings;
          if (!s) throw new Error("当前学习计划缺失，请刷新主页面");
          rebuild(s);
          if (hasMore(s) && (forceRead || !planSatisfied(s)))
            await searchUntilSatisfied(s, forceRead);
          render();
          status(
            state.cancelSearch
              ? "已停止查找，已读取课程已保留"
              : `课程查询完成，计划共 ${state.pending.length} 门；当前课程继续播放`,
          );
        } catch (error) {
          status(`课程查询失败：${error.message}；当前学习状态保持不变`);
        } finally {
          state.catalogBusy = false;
          $("#plan").disabled = false;
          $("#read-next").disabled = false;
        }
        return;
      }
      state.busy = true;
      $("#plan").disabled = true;
      $("#read-next").disabled = true;
      $("#start").disabled = true;
      try {
        await ensureCache();
        const s = settings();
        if (!annual.learnedSnapshot) {
          status("正在读取平台已学列表…");
          if (!(await annual.calculateLearned())) throw new Error("请先成功读取平台已学列表");
        }
        validate(s);
        saveSettings();
        if (state.roundDone) {
          state.total = 0;
          state.roundStart = null;
          finished.clear();
          state.roundDone = false;
        }
        if (state.roundStart === null) state.roundStart = annual.learnedSnapshot.total;
        const saved = JSON.parse(localStorage.getItem(estimateKey()) || "null");
        if (!saved || saved.source !== "已学列表" || saved.year !== annual.annualYear)
          throw new Error("请重新查询平台已学列表");
        state.annualBase = saved.base;
        state.active = false;
        state.paused = true;
        state.current = null;
        state.child = null;
        state.planSettings = s;
        rebuild(s);
        if (reached(s)) {
          render();
          status(
            s.targetMode === "absolute"
              ? "平台已学列表已达到目标，无需安排课程"
              : "已达到本轮新增目标或年度要求，请核对",
          );
          return;
        }
        if (hasMore(s) && (forceRead || !planSatisfied(s)))
          await searchUntilSatisfied(s, forceRead);
        else render();
        if (state.cancelSearch) {
          status("已停止查找，已读取的课程已保留");
        }
        $("#start").disabled = !state.pending.length;
        $("#start").textContent = "开始学习";
        const planned = round(state.pending.reduce((sum, course) => sum + amount(course, s), 0));
        const projected = round(targetProgress(s) + planned),
          shortfall = Math.max(0, round(s.target - projected));
        if (!state.cancelSearch) {
          if (state.pending.length) {
            const goalLabel = s.targetMode === "absolute" ? "总数目标" : "新增目标";
            const predicted = projectProgress(state.annualBase, state.pending);
            const gaps =
              s.targetMode === "absolute" && usesAnnual(s) && predicted
                ? [
                    shortfall > 0 ? `总计差 ${shortfall}` : "",
                    predicted.professional < s.professional
                      ? `专业差 ${round(s.professional - predicted.professional)}`
                      : "",
                    predicted.public < s.public
                      ? `公需差 ${round(s.public - predicted.public)}`
                      : "",
                  ].filter(Boolean)
                : [];
            const result = gaps.length
              ? `尚缺 ${gaps.join("、")} ${unitName(s)}`
              : shortfall > 0
                ? `距${goalLabel}还差 ${shortfall} ${unitName(s)}`
                : `预计可满足${goalLabel}`;
            const end = !hasMore(s) ? "；所需类别已查完" : "";
            status(
              `找到 ${state.pending.length} 门，预计新增 ${planned} ${unitName(s)}；${result}${end}。`,
            );
          } else if (!hasMore(s))
            status("所需类别已查完，没有找到符合条件的课程，无法满足新增目标。");
          else status("暂无符合条件的所需课程。");
        }
        $("#plan").textContent = state.pending.length
          ? "重新查找课程"
          : !hasMore(s)
            ? "已到末页"
            : "继续查找";
      } catch (error) {
        stop();
        fail(error);
      } finally {
        state.busy = false;
        $("#plan").disabled = false;
        $("#read-next").disabled = false;
      }
    }
    return { planSatisfied, searchUntilSatisfied, makePlan };
  }

  // src/session.js
  var resumeKey = "hz-helper-controller-session-v1";
  function readSession() {
    try {
      return JSON.parse(sessionStorage.getItem(resumeKey) || "null");
    } catch {
      return null;
    }
  }
  function createSessionManager({
    state,
    repository,
    annual,
    panel,
    session,
    finished,
    restoredSession,
    rebuild,
    render,
    lock,
    probePlayers,
    openCourse,
    tick,
    stop,
    fail,
    markComplete,
    courseLinks,
  }) {
    const { state: store, ensureCache, estimateKey } = repository;
    const { $, status } = panel;
    function snapshotSession() {
      if (!store.scope || !store.cache || !state.planSettings) {
        sessionStorage.removeItem(resumeKey);
        return;
      }
      sessionStorage.setItem(
        resumeKey,
        JSON.stringify({
          session,
          scope: store.scope,
          planSettings: state.planSettings,
          roundStart: state.roundStart,
          total: state.total,
          roundDone: state.roundDone,
          finished: [...finished],
          current: state.current,
          active: state.active,
          paused: state.paused,
          heartbeatPaused: state.heartbeatPaused,
          manualPaused: state.manualPaused,
          year: annual.annualYear,
        }),
      );
    }
    async function reconnectCourse() {
      if (!state.current || state.child) return true;
      const current = state.current;
      const existing = await courseLinks.connect(session, current.job, current.course.id);
      if (!existing || state.current !== current) return false;
      state.child = existing;
      state.lastHeartbeat = Date.now();
      state.missingSince = 0;
      return true;
    }
    async function restoreSession() {
      if (!restoredSession?.scope || !restoredSession?.planSettings) return;
      await ensureCache();
      if (store.scope !== restoredSession.scope) {
        sessionStorage.removeItem(resumeKey);
        status("账号已变化，请重新查找课程");
        return;
      }
      const saved = JSON.parse(localStorage.getItem(estimateKey()) || "null");
      if (!saved || saved.source !== "已学列表" || saved.year !== restoredSession.year) {
        status("平台学年数据不可用，请重新查找课程");
        return;
      }
      annual.annualYear = saved.year;
      state.annualBase = saved.base;
      annual.learnedSnapshot = { total: saved.base.total };
      state.planSettings = {
        ...restoredSession.planSettings,
        unit: "hours",
        targetMode: restoredSession.planSettings.targetMode || "increment",
      };
      state.roundStart = restoredSession.roundStart;
      state.total = restoredSession.total || 0;
      state.roundDone = !!restoredSession.roundDone;
      for (const id of restoredSession.finished || []) finished.add(id);
      state.current = restoredSession.current || null;
      state.active = !!restoredSession.active;
      state.paused = !!restoredSession.paused;
      state.heartbeatPaused = !!restoredSession.heartbeatPaused;
      state.manualPaused = restoredSession.manualPaused ?? (state.paused && !state.heartbeatPaused);
      if (state.current && !state.current.complete && !state.current.skipped) {
        let completion = null;
        try {
          completion = JSON.parse(
            localStorage.getItem(`hz-helper-completion:${session}:${state.current.job}`) || "null",
          );
        } catch {}
        if (
          String(completion?.id) === String(state.current.course.id) &&
          number(completion?.credits) > 0
        ) {
          const wasPaused = state.paused,
            wasHeartbeatPaused = state.heartbeatPaused;
          markComplete(state.current);
          state.paused = wasPaused;
          state.heartbeatPaused = wasHeartbeatPaused;
          void annual.refreshLearnedInBackground();
        }
      }
      rebuild(state.planSettings);
      render();
      $("#plan").textContent = "重新查找课程";
      $("#start").disabled = !state.pending.length && !state.current;
      if (state.active) await lock();
      if (state.current && !(await reconnectCourse())) {
        if (!state.active || state.paused) {
          render();
          status("已恢复暂停的学习计划，继续时重新连接课程");
          return;
        }
        if (state.current.complete || state.current.skipped) {
          state.child = { closed: true };
        } else {
          try {
            await probePlayers();
            await new Promise((resolve, reject) =>
              navigator.locks
                .request("hz-helper-player-v1", { ifAvailable: true }, (token) =>
                  token ? resolve() : reject(new Error("课程页仍在运行，无法确认位置")),
                )
                .catch(reject),
            );
            if (!openCourse(state.current.course)) return;
            status("已恢复学习计划，重新打开当前课程");
          } catch (error) {
            state.active = false;
            state.paused = true;
            render();
            status(`计划已恢复，自动继续失败：${error.message}；请检查课程页后点击继续学习`);
            return;
          }
        }
      }
      render();
      if (!state.paused && !state.current) {
        status("已恢复学习计划，正在继续调度");
        void tick().catch((error) => {
          stop();
          fail(error);
        });
      } else
        status(
          state.paused ? "已恢复暂停的学习计划" : state.current ? "正在学习" : "已恢复学习计划",
        );
    }
    return { snapshotSession, reconnectCourse, restoreSession };
  }

  // src/ui/course-progress.js
  function renderCourseProgress($, snapshot) {
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

  // src/center-monitor.js
  function createCenterMonitor({
    repository,
    readAPI,
    annual,
    panel,
    getState,
    markComplete,
    messageWorker,
    approveClose,
    render,
  }) {
    const { state: store, identity } = repository;
    const { $, status } = panel;
    let monitorBusy = false,
      nextCheckAt = 0,
      fastCheckTimer = null;
    window.addEventListener("pagehide", () => clearTimeout(fastCheckTimer), {
      once: true,
    });
    async function checkLearningCenter(force = false, manual = false) {
      if (
        (!manual &&
          (!getState().active ||
            getState().manualPaused ||
            (getState().paused && !getState().heartbeatPaused))) ||
        !getState().current ||
        getState().current.complete ||
        getState().current.skipped ||
        (getState().child?.closed && !force) ||
        (getState().recovering && !force) ||
        monitorBusy ||
        (!force && Date.now() < nextCheckAt)
      )
        return;
      const job = getState().current,
        id = String(job.course.id);
      monitorBusy = true;
      $("#check-course-progress").disabled = true;
      $("#check-course-progress").setAttribute("aria-busy", "true");
      clearTimeout(fastCheckTimer);
      fastCheckTimer = null;
      nextCheckAt = Date.now() + 6e4;
      const report = (message, level = "info", extra = {}) => {
        recordEvent("progress", "学习中心核对", message, { level, ...extra });
        $("#center-status").hidden = true;
        $("#center-status").textContent = `学习中心：${message}
上次核对 ${/* @__PURE__ */ new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}`;
      };
      let checkingPage = 1;
      let pageSummary = null;
      try {
        let tryClose = function () {
          if (getState().current !== job || !job.complete || !closing || closing.closed) return;
          closeAttempts++;
          try {
            closing.close();
            recordEvent(
              "page",
              "请求关闭已完成课页",
              `主面板第 ${closeAttempts} 次请求；完成已由平台列表交叉确认`,
            );
          } catch {
            recordEvent("error", "关闭课页失败", "浏览器未执行关闭请求；保留当前课程，不另开课程");
          }
          setTimeout(() => {
            if (getState().current !== job || closing.closed) return;
            if (closeAttempts < 3) tryClose();
            else {
              report("已确认完成，但浏览器尚未关闭课页，请手动关闭后继续");
              recordEvent(
                "error",
                "已完成课页仍未关闭",
                "已请求 3 次；可能仍有浏览器离开确认或关闭限制，不并行开新课",
              );
            }
          }, ACTION_DELAY_MS);
        };
        if ((await identity()) !== store.scope) throw new Error("账号已变化");
        let page = 1,
          expected = null,
          size = null,
          found = null;
        const signatures = /* @__PURE__ */ new Set();
        while (true) {
          checkingPage = page;
          const response = await readAPI(
            "/api/index/Course/index",
            { page, limit: 100 },
            () => {},
            0,
          );
          const parsed = parsePage(response, "data", page),
            data = response.data;
          const count = number(data.total),
            pageSize = number(data.per_page);
          pageSummary = {
            page,
            total: count,
            pageSize,
            received: data.data.length,
          };
          found = data.data.find((row) => String(row.courseid) === id) || null;
          if (found) break;
          if (
            !Number.isInteger(count) ||
            !Number.isInteger(pageSize) ||
            pageSize < 1 ||
            data.data.length !== Math.min(pageSize, Math.max(0, count - (page - 1) * pageSize))
          )
            throw new Error("学习中心分页不完整");
          if (expected === null) {
            expected = count;
            size = pageSize;
          } else if (expected !== count || size !== pageSize)
            throw new Error("学习中心列表在查询中变化");
          if (data.data.length && signatures.has(parsed.signature))
            throw new Error("学习中心分页重复");
          signatures.add(parsed.signature);
          if (parsed.exhausted) break;
          if (page >= 200) throw new Error("学习中心分页过多");
          page++;
        }
        if (
          (await identity()) !== store.scope ||
          getState().current !== job ||
          job.complete ||
          job.skipped ||
          (!manual &&
            (getState().manualPaused || (getState().paused && !getState().heartbeatPaused)))
        )
          return;
        job.centerMonitor || (job.centerMonitor = { seen: false, missing: 0 });
        if (found) {
          job.centerMonitor.seen = true;
          job.centerMonitor.missing = 0;
          const studied = number(found.validstudytime),
            duration = number(found.coursetimes);
          observePlatformProgress(job, studied);
          const progress =
            Number.isFinite(studied) && studied >= 0 && duration > 0
              ? `当前课程 ${Math.min(100, Math.max(0, Math.round((studied * 100) / duration)))}%`
              : "当前课程仍在列表";
          if (Number.isFinite(studied) && studied >= 0 && duration > 0) {
            job.centerMonitor.percent = Math.min(
              100,
              Math.max(0, Math.round((studied * 100) / duration)),
            );
            job.centerMonitor.checkedAt = Date.now();
            renderCourseProgress($, job.centerMonitor);
          }
          report(progress);
          return;
        }
        if (manual && (getState().manualPaused || getState().paused || !getState().active)) {
          report("未找到当前课程；当前已暂停，未自动切课", "warning");
          return;
        }
        if (!job.centerMonitor.seen) {
          report("未见过当前课程，暂无法判断");
          return;
        }
        job.centerMonitor.missing++;
        if (job.centerMonitor.missing < 2) {
          report("暂未找到当前课程，5秒后再次核对");
          nextCheckAt = Date.now() + 5e3;
          fastCheckTimer = setTimeout(checkLearningCenter, 5e3);
          return;
        }
        const result = await annual.calculateLearned(true);
        if (
          getState().current !== job ||
          job.complete ||
          job.skipped ||
          getState().manualPaused ||
          (getState().paused && !getState().heartbeatPaused)
        )
          return;
        if (!result || !result.ids.includes(id)) {
          job.centerMonitor.missing = 0;
          report("已学列表未找到该课程，继续等待");
          return;
        }
        job.centerMonitor.percent = 100;
        job.centerMonitor.checkedAt = Date.now();
        markComplete(job, "学习中心消失并存在于已学列表");
        render();
        report("已从学习中心消失，且已学列表可查");
        status("学习中心已移除课程，已学列表可查，正在关闭课页");
        try {
          approveClose(job);
        } catch {
          recordEvent(
            "error",
            "关页许可保存失败",
            "仍通知播放页关闭，并由主面板尝试关闭已确认完成的课程",
          );
        }
        messageWorker("list-complete");
        const closing = getState().child;
        let closeAttempts = 0;
        setTimeout(tryClose, ACTION_DELAY_MS);
      } catch (error) {
        if (getState().current === job) {
          if (job.centerMonitor) job.centerMonitor.missing = 0;
          const reason = String(error.message || "未知错误").slice(0, 180);
          const context = pageSummary
            ? `；第 ${checkingPage} 页，返回 ${pageSummary.received}/${pageSummary.pageSize} 条，总数 ${pageSummary.total}`
            : `；第 ${checkingPage} 页`;
          report(`核对未完成：${reason}${context}；15秒后重试`, "warning", {
            courseId: id,
            page: checkingPage,
            pagination: pageSummary,
          });
          nextCheckAt = Date.now() + 15e3;
          fastCheckTimer = setTimeout(checkLearningCenter, 15e3);
        }
        log("学习中心核对失败", error.message);
      } finally {
        monitorBusy = false;
        $("#check-course-progress").setAttribute("aria-busy", "false");
        const current = getState().current;
        $("#check-course-progress").disabled = !current || current.complete || current.skipped;
      }
    }
    return {
      checkLearningCenter,
      get busy() {
        return monitorBusy;
      },
    };
  }

  // src/scanner.js
  function createScanner({ repository, readAPI, status, getBase, getPending, rebuild, render }) {
    const { state: store, identity, blocked, save: save2 } = repository;
    const annualProgress = () => ({
      total: getBase().total,
      professional: getBase().professional,
      public: getBase().public,
    });
    function neededCategory(s) {
      if (s.category !== "auto") return s.category;
      if (!usesAnnual(s) || !getBase()) return "all";
      const projected = projectProgress(
        annualProgress(),
        s.targetMode === "absolute" ? getPending() : [],
      );
      const deficits = annualDeficits(s, projected),
        categories = [];
      if (s.targetMode === "absolute" && deficits.professional <= 0 && deficits.public <= 0)
        return "all";
      if (deficits.professional > 0) categories.push("专业课程");
      if (deficits.public > 0) categories.push("行业公需");
      if (deficits.public > 0 || (s.targetMode !== "absolute" && deficits.generalExtra > 0))
        categories.push("一般公需");
      if (!categories.length) return "all";
      const last = categories.indexOf(store.cache?.lastFilter),
        scans = store.cache?.categoryScans || {};
      for (let i = 1; i <= categories.length; i++) {
        const name = categories[(last + i) % categories.length],
          scan = scans[name];
        if (!scan?.exhausted || scan.staged?.length) return name;
      }
      return categories[0];
    }
    function scanFor(s, initialize = false) {
      var _a;
      const category = neededCategory(s);
      if (category === "all") return { category, scan: store.cache };
      const existing = store.cache.categoryScans?.[category];
      if (existing) return { category, scan: existing };
      const scan = {
        nextPage: 1,
        exhausted: false,
        seen: [],
        signatures: [],
        staged: [],
        stagedPages: [],
        lastPages: [],
      };
      if (initialize) {
        (_a = store.cache).categoryScans || (_a.categoryScans = {});
        store.cache.categoryScans[category] = scan;
      }
      return { category, scan };
    }
    const hasMore = (s) => {
      if (!store.cache) return true;
      const { scan } = scanFor(s);
      return !scan.exhausted || scan.staged.length > 0;
    };
    async function readBatch(s, maxRequests = 5, mineContext = null) {
      if ((await identity()) !== store.scope)
        throw new Error("登录凭据已变化，请刷新主面板重新规划");
      const mineData =
        mineContext?.data || (await readAPI("/api/index/Course/index", { page: 1, limit: 100 }));
      if (mineContext) mineContext.data = mineData;
      const minePage = parsePage(mineData, "data", 1);
      const mine = new Map(minePage.rows.map((row) => [String(row.courseid), row]));
      for (const row of minePage.rows) {
        if (number(row.coursetimes) > 0 && number(row.validstudytime) >= number(row.coursetimes)) {
          const id = String(row.courseid);
          if (!store.records[id])
            store.records[id] = {
              id,
              name: row.coursename,
              kind: "platform",
              at: Date.now(),
            };
        }
      }
      store.cache.coverage = `${minePage.rows.length}/${minePage.total}`;
      let { category, scan } = scanFor(s, true),
        budget = Math.max(0, maxRequests - scan.stagedPages.length);
      if (category !== "all" && !store.cache.typeMap) {
        status("读取平台课程类别…");
        const metadata = await readAPI("/api/index/index/SelectCourse", {
          page: 1,
          limit: 1,
        });
        budget--;
        if (!Array.isArray(metadata.type)) throw new Error("平台没有返回课程类别，无法按类别筛选");
        const map = {};
        for (const name of ["专业课程", "行业公需", "一般公需"]) {
          const matches = metadata.type.filter(
            (x) =>
              String(x.coursetype || "").trim() === name &&
              x.typeid !== null &&
              x.typeid !== void 0,
          );
          if (matches.length !== 1 || !String(matches[0].typeid).trim())
            throw new Error(`无法确定平台课程类别：${name}`);
          map[name] = matches[0].typeid;
        }
        if (new Set(Object.values(map).map(String)).size !== 3)
          throw new Error("平台返回的课程类别 ID 重复");
        store.cache.typeMap = map;
        save2();
        if (budget <= 0) return false;
      }
      const seen = new Set(scan.seen),
        signatures = new Set(scan.signatures);
      let used = 0;
      for (let count = 0; count < budget && !scan.exhausted; count++) {
        used++;
        const page = scan.nextPage;
        status(`正在读取${category === "all" ? "" : category}第 ${page} 页；正在查找`);
        const body = {
          page,
          limit: 30,
          ...(category === "all" ? {} : { type: store.cache.typeMap[category] }),
        };
        const result = parsePage(
          await readAPI("/api/index/index/SelectCourse", body),
          "course",
          page,
        );
        if (
          category !== "all" &&
          result.rows.some((row) => String(row.coursetype || "").trim() !== category)
        )
          throw new Error(`平台返回了其他课程类别，暂停${category}筛选`);
        if (result.rows.length && signatures.has(result.signature))
          throw new Error("接口重复返回相同课程页，已停止读取");
        if (result.rows.length) {
          signatures.add(result.signature);
          scan.signatures.push(result.signature);
        }
        for (const row of result.rows) {
          const id = String(row.courseid);
          if (!seen.has(id)) {
            scan.staged.push(row);
            seen.add(id);
            scan.seen.push(id);
          }
        }
        scan.stagedPages.push(page);
        scan.nextPage = page + 1;
        scan.exhausted = result.exhausted;
        save2(["cache"]);
        if (count < budget - 1 && !scan.exhausted) await sleep(1500);
      }
      const candidates = [];
      for (const row of scan.staged) {
        const id = String(row.courseid),
          studied = mine.get(id);
        if (blocked(id)) continue;
        const merged = {
          ...row,
          ...studied,
          coursetype: row.coursetype || studied?.coursetype,
        };
        const course = normalizeCourse(merged, studied || null);
        if (course && !course.excludedExam) candidates.push(course);
      }
      const pool = new Map(store.cache.pending.map((course) => [course.id, course]));
      for (const course of candidates) pool.set(course.id, course);
      store.cache.pending = [...pool.values()];
      scan.lastPages = [...scan.stagedPages];
      scan.staged = [];
      scan.stagedPages = [];
      store.cache.lastFilter = category;
      store.cache.lastFilteredPages = [...scan.lastPages];
      save2();
      rebuild(s);
      render();
      log("批次读取完成", {
        category,
        pages: scan.lastPages,
        candidates: getPending().length,
        nextPage: scan.nextPage,
        historyCoverage: store.cache.coverage,
      });
      const remaining = budget - used;
      if (!getPending().length && remaining > 0 && hasMore(s) && neededCategory(s) !== category) {
        await readBatch(s, remaining, mineContext);
      }
      return used > 0;
    }
    return { scanFor, hasMore, readBatch };
  }

  // src/ui/course-row.js
  var setText = (element, value) => {
    const text2 = String(value);
    if (element.textContent !== text2) element.textContent = text2;
  };
  function createCourseRow(courseAction) {
    const element = document.createElement("li");
    const ordinal = document.createElement("span");
    ordinal.className = "ordinal";
    const content = document.createElement("div");
    content.className = "course-content";
    const badge = document.createElement("span");
    badge.className = "course-current-badge";
    badge.hidden = true;
    const title = document.createElement("div");
    title.className = "course-title";
    const meta = document.createElement("div");
    meta.className = "course-meta";
    const facts = document.createElement("span");
    facts.className = "course-facts";
    const factNodes = Array.from({ length: 3 }, () => document.createElement("span"));
    facts.append(...factNodes);
    const score = document.createElement("span");
    score.className = "score";
    const actions = document.createElement("div");
    let selectedCourse = null;
    const buttons = [
      ["已学", "manual", "check"],
      ["移除", "excluded", "trash"],
    ].map(([caption, kind, name]) => {
      const button = createIconButton({
        name,
        size: 20,
        wrapped: true,
        className: "quiet-action",
        label: caption,
        title: kind === "manual" ? "已学，跳过此课" : "移除此课",
      });
      button.onclick = () => courseAction(selectedCourse.id, kind);
      actions.append(button);
      return { button, caption };
    });
    meta.append(facts, score);
    content.append(badge, title, meta);
    element.append(ordinal, content, actions);
    function update({ course, index, current, paused, unit }) {
      selectedCourse = course;
      const rowClass = current ? (paused ? "course current paused" : "course current") : "course";
      if (element.dataset.rowState !== rowClass) {
        element.className = rowClass;
        element.dataset.rowState = rowClass;
        if (current && !paused) decorateSurfaceCard(element, { tone: "accent", compact: true });
        else {
          delete element.dataset.cardTone;
          delete element.dataset.cardSize;
        }
        actions.className = current ? "row-actions pill-actions" : "row-actions icon-actions";
      }
      setText(ordinal, String(index + 1).padStart(2, "0"));
      badge.hidden = !current;
      setText(badge, paused ? "已暂停" : "正在学习");
      setText(title, course.name);
      const values = [
        course.category || "",
        `${round(course.hours)} 学时`,
        `${course.learned > 0 ? "剩余" : "时长"} ${round(course.remaining / 60)} 分钟`,
      ];
      values.forEach((value, i) => {
        setText(factNodes[i], value);
        factNodes[i].hidden = !value;
      });
      setText(score, `${round(minutesPerUnit(course, unit))} 分/学时`);
      for (const { button, caption } of buttons) {
        const label = `${caption}：${course.name}`;
        if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
        button.dataset.courseId = course.id;
      }
    }
    return { element, update };
  }

  // src/ui/plan.js
  function createPlanView({ panel, getState, courseAction, restoreRecord }) {
    const { $, info, icon: icon2 } = panel;
    const unitName = () => "学时";
    let lastRecords = null;
    let listView = null;
    function renderRecords() {
      const { records } = getState();
      const manual = Object.values(records)
        .filter((r) => r.kind === "manual" || r.kind === "excluded" || r.kind === "auto-excluded")
        .sort((a, b) => b.at - a.at);
      const signature = JSON.stringify(manual);
      if (signature === lastRecords) return;
      lastRecords = signature;
      const list = document.createElement("ul");
      list.className = "record-list";
      $("#history-details").hidden = manual.length === 0;
      for (const record of manual) {
        const row = document.createElement("li");
        row.className = "record-row";
        const name = document.createElement("span");
        name.textContent =
          record.kind === "auto-excluded"
            ? `自动跳过；${record.name || record.id}（${record.reason || "自动筛选"}）`
            : `${record.kind === "manual" ? "手动标记已学" : "手动排除"}；${record.name || record.id}`;
        const restore = document.createElement("button");
        restore.type = "button";
        restore.textContent = "恢复";
        restore.dataset.courseId = record.id;
        restore.onclick = () => {
          restoreRecord(record);
        };
        row.append(name, restore);
        list.append(row);
      }
      $("#records").replaceChildren(list);
    }
    function render() {
      const {
        planSettings,
        settings,
        total,
        pending,
        current,
        paused,
        active,
        manualPaused,
        starting,
        hasOpenCourse,
        cache,
        targetProgress,
      } = getState();
      const started = starting || (active === true && !manualPaused);
      $("#scheduler-actions").classList.toggle("has-started", started);
      $("#plan").inert = started;
      $("#plan").tabIndex = started ? -1 : 0;
      $("#plan").setAttribute("aria-hidden", String(started));
      $("#read-next").hidden = started;
      const label = starting
        ? "正在准备…"
        : active && !paused
          ? hasOpenCourse
            ? "暂停学习"
            : "暂停调度"
          : active || current
            ? "继续学习"
            : "开始学习";
      const start = $("#start");
      if (start.getAttribute("aria-label") !== label) {
        start.innerHTML = `${icon2(active && !paused && !starting ? "pause" : "play", 20)}<span>${label}</span>`;
        start.setAttribute("aria-label", label);
      }
      start.setAttribute("aria-busy", String(!!starting));
      start.disabled = !!starting || (!active && !pending.length && !current);
      const s = planSettings || settings();
      const visibleSettings = settings();
      renderCourseProgress($, current?.centerMonitor);
      $("#check-course-progress").disabled = !current || current.complete || current.skipped;
      $("#window-current").textContent =
        `开课时段：${(active && planSettings ? planSettings.window : visibleSettings.window) || "全天"}`;
      $("#annual-total-field").hidden =
        visibleSettings.targetMode === "absolute" && visibleSettings.category === "auto";
      $("#target-unit").textContent = unitName(s);
      $("#earned-unit").textContent = unitName(s);
      $("#earned").textContent = round(total);
      $("#queued").textContent = pending.length;
      renderProgressBar(
        $("#round-progress-bar"),
        $("#bar"),
        (targetProgress(s) / s.target) * 100 || 0,
      );
      $("#progress").hidden = true;
      $("#progress").textContent = "";
      renderRecords();
      if (!listView) {
        const wrapper = document.createElement("details");
        wrapper.className = "plan-disclosure";
        wrapper.open = true;
        const title = document.createElement("summary");
        title.className = "list-title";
        const name = document.createElement("b");
        name.textContent = "学习计划";
        const subtitle = document.createElement("span");
        title.append(name, subtitle);
        const empty = document.createElement("div");
        empty.className = "empty";
        const list = document.createElement("ol");
        list.className = "course-list";
        wrapper.append(title, empty, list);
        $("#preview").replaceChildren(wrapper);
        const rows = createKeyedList({
          container: list,
          key: (item) => item.course.id,
          create: () => createCourseRow(courseAction),
          update: (row, item) => row.update(item),
        });
        listView = { subtitle, empty, list, rows, description: null };
      }
      const description = `按预计播放分钟筛选，每学时少于 ${s.maxRatio} 分钟；只安排凑够目标的课程。已学和排除记录保存在本机。`;
      if (description !== listView.description) {
        listView.subtitle.innerHTML = info("queue-info", "关于课程排序", description);
        listView.description = description;
      }
      listView.empty.hidden = pending.length > 0;
      listView.empty.textContent = cache ? "暂无课程" : "点击查找课程，查看计划";
      listView.list.hidden = pending.length === 0;
      listView.rows.render(
        pending.map((course, index) => ({
          course,
          index,
          paused,
          unit: s.unit,
          current:
            !!current && !current.complete && !current.skipped && current.course.id === course.id,
        })),
      );
    }
    return { render };
  }

  // src/repository.js
  function createRepository({ panel, accountScope, accountDigest }) {
    const { $ } = panel;
    const state = {
      cache: null,
      scope: "",
      records: /* @__PURE__ */ Object.create(null),
      history: [],
      historyYears: [],
      historyIds: /* @__PURE__ */ new Set(),
      historySynced: false,
    };
    const store = state;
    const CACHE_KEY = "hz-helper-batches-v2";
    const blankCache = (identity2) => ({
      version: 2,
      scope: identity2,
      nextPage: 1,
      exhausted: false,
      seen: [],
      completed: [],
      pending: [],
      staged: [],
      stagedPages: [],
      signatures: [],
      lastPages: [],
      coverage: "",
    });
    const durableKey = () => `hz-helper-batches-v3:${store.scope}`;
    const recordsKey = () => `hz-helper-records-v1:${store.scope}`;
    const historyKey = () => `hz-helper-history-v1:${store.scope}`;
    const estimateKey = () => estimateStorageKey(store.scope);
    const settingsKey = () => `hz-helper-settings-v1:${store.scope}`;
    const saveSettings = () => {
      if (store.scope)
        writeJSON(
          settingsKey(),
          Object.fromEntries(
            PERSISTED_SETTING_IDS.map((id) => [
              id,
              isCheckboxSetting(id) ? $("#" + id).checked : $("#" + id).value,
            ]),
          ),
        );
    };
    const blocked = (id) =>
      !!store.records[id] ||
      store.historyIds.has(String(id)) ||
      !!store.cache?.completed.includes(id);
    const save2 = (parts = ["cache", "records"]) => {
      if (!store.cache || !store.scope) return;
      if (parts.includes("cache")) writeJSON(durableKey(), store.cache);
      if (parts.includes("records")) writeJSON(recordsKey(), store.records);
      if (parts.includes("history"))
        writeJSON(historyKey(), {
          years: store.historyYears,
          items: store.history,
          synced: store.historySynced,
        });
    };
    const digest = accountDigest;
    const identity = accountScope;
    async function ensureCache() {
      const value = await identity();
      if (store.scope && store.scope !== value)
        throw new Error("平台账户已变化，请关闭课页并刷新面板");
      if (store.cache) return;
      store.scope = value;
      try {
        const storedSettings = JSON.parse(localStorage.getItem(settingsKey()) || "null");
        if (storedSettings && typeof storedSettings === "object")
          for (const id of PERSISTED_SETTING_IDS) {
            const v = storedSettings[id];
            if (isCheckboxSetting(id) && typeof v === "boolean") $("#" + id).checked = v;
            else if (typeof v === "string") $("#" + id).value = v;
          }
      } catch {}
      try {
        const storedRecords = JSON.parse(localStorage.getItem(recordsKey()) || "{}");
        store.records = Object.assign(
          /* @__PURE__ */ Object.create(null),
          storedRecords && typeof storedRecords === "object" && !Array.isArray(storedRecords)
            ? storedRecords
            : {},
        );
      } catch {
        store.records = /* @__PURE__ */ Object.create(null);
      }
      try {
        const savedHistory = JSON.parse(localStorage.getItem(historyKey()) || "null");
        if (Array.isArray(savedHistory?.years) && Array.isArray(savedHistory?.items)) {
          store.historyYears = savedHistory.years;
          store.history = savedHistory.items;
          store.historyIds = new Set(store.history.map((item) => String(item.id)));
          store.historySynced = savedHistory.synced === true;
        }
      } catch {
        store.historyYears = [];
        store.history = [];
        store.historyIds = /* @__PURE__ */ new Set();
        store.historySynced = false;
      }
      try {
        let saved = JSON.parse(localStorage.getItem(durableKey()) || "null");
        if (!saved) {
          const legacy = JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null");
          const tokenScope = await digest(localStorage.getItem("front_token"));
          if (legacy?.scope === tokenScope || legacy?.scope === store.scope)
            saved = { ...legacy, scope: store.scope };
        }
        store.cache =
          saved?.version === 2 && saved.scope === store.scope ? saved : blankCache(store.scope);
        if (
          !Number.isSafeInteger(store.cache.nextPage) ||
          store.cache.nextPage < 1 ||
          ![
            "seen",
            "completed",
            "pending",
            "staged",
            "stagedPages",
            "signatures",
            "lastPages",
          ].every((key) => Array.isArray(store.cache[key]))
        )
          throw new Error("cache");
      } catch {
        store.cache = blankCache(store.scope);
      }
      if (!store.cache.yearAwareHistory) {
        if (Object.values(store.records).some((r) => r.kind === "platform")) {
          store.cache.nextPage = 1;
          store.cache.exhausted = false;
          store.cache.seen = [];
          store.cache.signatures = [];
          store.cache.staged = [];
          store.cache.stagedPages = [];
          store.cache.lastPages = [];
          store.cache.pending = store.cache.pending.map((c) => ({
            ...c,
            learned: 0,
            remaining: c.duration,
          }));
        }
        store.cache.yearAwareHistory = true;
      }
      for (const id of store.cache.completed)
        if (!store.records[id])
          store.records[id] = { id, name: id, kind: "complete", at: Date.now() };
      if (store.cache.frameAdapterVersion !== 2) {
        for (const [id, record] of Object.entries(store.records)) {
          if (record.kind !== "auto-excluded" || record.reason !== "iframe 课件") continue;
          delete store.records[id];
          if (
            record.course &&
            !store.historyIds.has(String(id)) &&
            !store.cache.completed.includes(id) &&
            !store.cache.pending.some((course) => course.id === id)
          )
            store.cache.pending.push(record.course);
        }
        store.cache.frameAdapterVersion = 2;
      }
      store.cache.pending = store.cache.pending.map(migrateCourse).filter((c) => !blocked(c.id));
      save2(["cache", "records", "history"]);
    }
    return {
      state,
      CACHE_KEY,
      blankCache,
      estimateKey,
      saveSettings,
      blocked,
      save: save2,
      identity,
      ensureCache,
    };
  }

  // src/controller.js
  function startController(env) {
    const { panel, annual, channel, readAPI, accountScope, accountDigest, lifecycle } = env;
    const courseLinks = createCourseLinks({ channel, lifecycle });
    const { $, status } = panel;
    const fail = (error) => {
      console.error(PREFIX, error?.message || "未知错误");
      status(`已暂停：${error?.message || "未知错误"}`);
    };
    mountControllerControls(panel);
    const state = createControllerState();
    const repository = createRepository({ panel, accountScope, accountDigest });
    const {
      state: store,
      CACHE_KEY,
      blankCache,
      estimateKey,
      saveSettings,
      blocked,
      save: save2,
      ensureCache,
    } = repository;
    const restoredSession = readSession();
    const session = restoredSession?.session || crypto.randomUUID(),
      finished = /* @__PURE__ */ new Set(),
      present = /* @__PURE__ */ new Set();
    const settings = () => readPlanSettings($);
    const samePlan = (s) => samePlanSettings(s, state.planSettings);
    const validate = (s) => validatePlanSettings(s, annual);
    const messageWorker = (type) =>
      state.current && channel.postMessage({ type, run: session, job: state.current.job });
    annual.onEstimateUpdated = async (value, saved) => {
      if (!store.cache) await ensureCache();
      if (store.scope !== value || saved.year !== annual.annualYear) return;
      state.annualBase = saved.base;
      if (state.roundStart !== null)
        state.total = Math.max(0, round(saved.base.total - state.roundStart));
      if (state.planSettings) rebuild(state.planSettings);
      render();
    };
    const annualProgress = () => ({
      total: state.annualBase.total,
      professional: state.annualBase.professional,
      public: state.annualBase.public,
    });
    const targetProgress = (s) =>
      s.targetMode === "absolute"
        ? (state.annualBase?.[
            {
              专业课程: "professional",
              行业公需: "industry",
              一般公需: "general",
            }[s.category] || "total"
          ] ?? 0)
        : state.total;
    const reached = (s) => goalReached(s, targetProgress(s), state.annualBase);
    function rebuild(s) {
      const ranked = rank(
        (store.cache?.pending || []).filter(
          (c) =>
            !blocked(c.id) &&
            eligible(c, s) &&
            (s.category === "auto" || c.category === s.category),
        ),
      );
      if (state.current && !state.current.complete && !state.current.skipped) {
        const selected = ranked.find((c) => c.id === state.current.course.id);
        if (selected) {
          ranked.splice(ranked.indexOf(selected), 1);
          ranked.unshift(selected);
        }
      }
      state.pending =
        usesAnnual(s) && state.annualBase
          ? annualChoose(ranked, s, annualProgress(), targetProgress(s))
          : chooseForGoal(ranked, s.target, targetProgress(s));
    }
    function courseAction(id, kind, explicitName = "") {
      if (!store.cache || state.busy) {
        status("请等待当前查询完成后再操作");
        return;
      }
      const course =
        store.cache.pending.find((c) => c.id === id) ||
        (state.current?.course.id === id ? state.current.course : null);
      store.records[id] = {
        id,
        name: course?.name || explicitName || id,
        kind,
        at: Date.now(),
        ...(kind === "auto-excluded" ? { reason: "iframe 课件" } : {}),
        ...(course ? { course } : {}),
      };
      store.cache.pending = store.cache.pending.filter((c) => c.id !== id);
      if (state.current?.course.id === id && !state.current.complete) {
        state.current.skipped = true;
        if (state.active && samePlan(settings())) state.paused = false;
        messageWorker("skip");
        const closing = state.child;
        lifecycle.timeout(() => {
          if (closing && !closing.closed && state.child === closing) closing.close();
        }, 1500);
      }
      save2();
      rebuild(state.planSettings || settings());
      render();
      $("#start").disabled = !state.pending.length && !state.current;
      status(
        state.current?.course.id === id
          ? "此课已移出计划，等待课页关闭后继续"
          : "已移出计划，并补入下一门合适课程",
      );
    }
    function restoreRecord(record) {
      delete store.records[record.id];
      store.cache.completed = store.cache.completed.filter((id) => id !== record.id);
      if (record.course && !store.cache.pending.some((c) => c.id === record.id))
        store.cache.pending.push(record.course);
      save2();
      rebuild(state.planSettings || settings());
      render();
      status("已恢复该课程，可重新加入计划");
    }
    const { hasMore, readBatch } = createScanner({
      repository,
      readAPI,
      status,
      getBase: () => state.annualBase,
      getPending: () => state.pending,
      rebuild,
      render: () => render(),
    });
    const { render } = createPlanView({
      panel,
      courseAction,
      restoreRecord,
      getState: () => ({
        records: store.records,
        planSettings: state.planSettings,
        settings,
        total: state.total,
        pending: state.pending,
        active: state.active,
        manualPaused: state.manualPaused,
        starting: state.starting,
        hasOpenCourse:
          !!state.current &&
          !!state.child &&
          !state.child.closed &&
          !state.current.complete &&
          !state.current.skipped,
        current: state.current,
        paused: state.paused,
        cache: store.cache,
        targetProgress,
      }),
    });
    const openPanelBefore = panel.onPanelOpened;
    panel.onPanelOpened = () => {
      openPanelBefore();
      if (!store.cache && !state.busy)
        void ensureCache()
          .then(() => render())
          .catch((error) => fail(error));
    };
    function stop(reason = "已暂停；继续时接着当前课程", dueToHeartbeat = false) {
      pausePlan(state, dueToHeartbeat);
      if (!dueToHeartbeat) messageWorker("pause");
      status(reason);
      render();
    }
    for (const id of PLAN_SETTING_IDS)
      $("#" + id).onchange = () => {
        saveSettings();
        annual.showAnnualGoals({
          "goal-total": $("#goal-total").value,
          "goal-professional": $("#goal-professional").value,
          "goal-public": $("#goal-public").value,
          target: $("#target").value,
          targetMode: $("#targetMode").value,
          category: $("#category").value,
        });
        if (state.active) stop("设置已改变，请先关闭播放页，再重新预览");
        $("#start").disabled = true;
        $("#plan").textContent = "重新查找课程";
        render();
      };
    $("#auto").onchange = saveSettings;
    $("#auto-refresh").onchange = () => {
      saveSettings();
      checkAutoRefresh();
    };
    $("#refresh-minutes").onchange = () => {
      saveSettings();
      const value = number($("#refresh-minutes").value);
      if (!validRefreshMinutes(value)) status("定时刷新间隔需为 5–240 分钟");
      checkAutoRefresh();
    };
    const markComplete = createCompletionHandler({
      state,
      store,
      finished,
      save: save2,
    });
    async function lock() {
      if (state.acquired) return;
      if (!navigator.locks) throw new Error("浏览器不支持 Web Locks，无法启用单实例调度");
      await new Promise((resolve, reject) => {
        navigator.locks
          .request("hz-helper-controller-v1", { ifAvailable: true }, async (token) => {
            if (lifecycle.disposed) {
              reject(new Error("调度页面已卸载"));
              return;
            }
            if (!token) {
              reject(new Error("另一面板正在调度，请先关闭它"));
              return;
            }
            state.acquired = true;
            resolve();
            await new Promise((r) => {
              state.release = r;
            });
            state.acquired = false;
          })
          .catch(reject);
      });
    }
    async function probePlayers() {
      state.probe = crypto.randomUUID();
      present.clear();
      channel.postMessage({ type: "probe", probe: state.probe });
      await sleep(1200);
      if (present.size) throw new Error("检测到其他播放页，请先关闭它们");
    }
    const { planSatisfied, searchUntilSatisfied, makePlan } = createPlanning({
      state,
      repository,
      annual,
      panel,
      settings,
      validate,
      targetProgress,
      rebuild,
      render,
      hasMore,
      readBatch,
      stop,
      fail,
      finished,
      reached,
    });
    $("#plan").onclick = () => makePlan(false);
    $("#read-next").onclick = () => makePlan(true);
    $("#reset").onclick = () => {
      if (state.busy || (state.current && state.child && !state.child.closed)) {
        status("请先暂停并关闭播放页，再重置页码");
        return;
      }
      state.active = false;
      state.paused = true;
      store.cache = store.scope ? blankCache(store.scope) : null;
      sessionStorage.removeItem(CACHE_KEY);
      state.pending = [];
      state.total = 0;
      state.roundStart = null;
      finished.clear();
      state.current = null;
      state.roundDone = false;
      save2();
      $("#start").disabled = true;
      $("#plan").textContent = "查找课程";
      render();
      status("已重置页码，下次从第1页开始");
      state.release?.();
    };
    $("#sync-history").onclick = createHistorySync({
      state,
      repository,
      readAPI,
      panel,
      rebuild,
      settings,
      render,
      fail,
    });
    function finish(reason) {
      finishRound(state);
      state.release?.();
      localStorage.removeItem(configKey(session));
      status(reason);
      $("#start").disabled = true;
      $("#plan").textContent = "查找下一轮";
      render();
    }
    const { launch, openCourse } = createCourseLauncher({
      state,
      repository,
      session,
      panel,
      settings,
      samePlan,
      reached,
      render,
      stop,
      fail,
      readAPI,
      messageWorker,
      lock,
      probePlayers,
      reconnectCourse: () => reconnectCourse(),
      rebuild,
      tick,
      lifecycle,
    });
    async function tick() {
      if (!canSchedule(state)) return;
      if (state.current) {
        if (state.child?.closed) {
          if (!state.current.complete && !state.current.skipped) {
            if (!state.missingSince) state.missingSince = Date.now();
            if (Date.now() - state.missingSince < 3e3) return;
            stop("课页未确认完成就关闭了，请重新预览，不自动跳过");
            return;
          }
          state.completing = true;
          try {
            status("课页已关闭，2秒后继续调度");
            await sleep(ACTION_DELAY_MS);
            const needsReplenishment =
              state.current.skipped &&
              store.records[state.current.course.id]?.kind === "auto-excluded";
            store.cache.pending = store.cache.pending.filter(
              (c) => c.id !== state.current.course.id,
            );
            localStorage.removeItem(`hz-helper-completion:${session}:${state.current.job}`);
            localStorage.removeItem(closeApprovalKey(session, state.current.job));
            state.current = null;
            state.child = null;
            $("#center-status").textContent = "";
            $("#center-status").hidden = true;
            save2();
            rebuild(state.planSettings);
            render();
            if (reached(state.planSettings)) {
              finish("已达到目标或年度要求，学习结束");
              return;
            }
            if (
              needsReplenishment &&
              !state.paused &&
              !planSatisfied(state.planSettings) &&
              hasMore(state.planSettings)
            ) {
              status("已跳过 iframe，正在补充学习计划…");
              await searchUntilSatisfied(state.planSettings);
            }
          } finally {
            state.completing = false;
          }
        } else if (state.current.complete) {
          status("课程已确认完成，等待课页关闭；如浏览器有离开提示请手动处理");
          return;
        } else if (Date.now() - state.lastHeartbeat > 2e4) {
          if (!state.missingSince) state.missingSince = Date.now();
          if (Date.now() - state.missingSince > 18e4)
            stop("播放页3分钟无响应，继续核对学习中心；不会另开一门", true);
          else status("播放页暂未响应，继续核对学习中心");
          return;
        } else return;
      }
      if (state.paused || state.catalogBusy) return;
      if (!inWindow(state.planSettings.window)) {
        status("等待新开课时间段；不会提前读取下一批");
        return;
      }
      state.busy = true;
      try {
        if (!state.pending.length) {
          if (!hasMore(state.planSettings)) {
            finish("当前所需类别已读至末页，暂无下一批");
            return;
          }
          status("正在继续查找课程…");
          await searchUntilSatisfied(state.planSettings);
          if (!state.pending.length) {
            stop("没有找到符合条件的所需课程");
            $("#plan").textContent = "继续查找";
            return;
          }
        }
        await launch();
      } catch (error) {
        stop();
        fail(error);
      } finally {
        state.busy = false;
      }
    }
    const centerMonitor = createCenterMonitor({
      repository,
      readAPI,
      annual,
      panel,
      getState: () => ({
        active: state.active,
        paused: state.paused,
        heartbeatPaused: state.heartbeatPaused,
        manualPaused: state.manualPaused,
        recovering: state.recovering,
        current: state.current,
        child: state.child,
      }),
      markComplete,
      messageWorker,
      approveClose: (job) =>
        localStorage.setItem(
          closeApprovalKey(session, job.job),
          JSON.stringify({
            id: String(job.course.id),
            source: "learning-center",
            at: Date.now(),
          }),
        ),
      render,
    });
    const { checkLearningCenter } = centerMonitor;
    $("#check-course-progress").onclick = () => checkLearningCenter(true, true);
    const recovery = createRecovery({
      state,
      repository,
      channel,
      panel,
      session,
      openCourse,
      probePlayers,
      checkCenter: checkLearningCenter,
      isMonitorBusy: () => centerMonitor.busy,
      lifecycle,
    });
    lifecycle.on(
      channel,
      "message",
      createControllerMessageHandler({
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
      }),
    );
    lifecycle.interval(
      () =>
        void recovery
          .checkStall()
          .catch((error) =>
            recordEvent("error", "恢复检查失败", String(error.message || "未知错误")),
          ),
      3e4,
    );
    const checkAutoRefresh = createAutoRefresh({
      state,
      panel,
      annual,
      centerMonitor,
    });
    bindDebugHooks(env, {
      checkLearningCenter,
      checkAutoRefresh,
      checkStall: recovery.checkStall,
    });
    lifecycle.interval(
      () =>
        tick().catch((error) => {
          stop();
          fail(error);
        }),
      2e3,
    );
    checkAutoRefresh();
    lifecycle.interval(checkAutoRefresh, 1e3);
    lifecycle.interval(() => void checkLearningCenter(), 3e4);
    const { snapshotSession, reconnectCourse, restoreSession } = createSessionManager({
      state,
      repository,
      annual,
      panel,
      session,
      finished,
      restoredSession,
      rebuild,
      render,
      lock,
      probePlayers,
      openCourse,
      tick,
      stop,
      fail,
      markComplete,
      courseLinks,
    });
    lifecycle.on(window, "pagehide", () => {
      snapshotSession();
      state.release?.();
    });
    render();
    status("等待预览");
    void restoreSession().catch((error) => {
      state.active = false;
      state.paused = true;
      status(`恢复学习计划失败：${error.message}`);
    });
  }

  // src/main.js
  if (window.top !== window.self && FRAME_ORIGINS.includes(location.origin)) startFrameWorker();
  else if (location.pathname === "/" && window.top === window.self && location.origin === ORIGIN) {
    let mount = function () {
      const panel = createPanel({ lifecycle });
      platform.callbacks.onNetworkRetry = panel.status;
      const diagnostics = createDiagnostics({ $: panel.$, lifecycle });
      const annual = createAnnualService({
        $: panel.$,
        status: panel.status,
        ...platform,
        channel,
        panel,
      });
      const env = {
        panel,
        runtime,
        annual,
        diagnostics,
        channel,
        lifecycle,
        ...platform,
      };
      installDebugHooks(env, platform.readAPI);
      lifecycle.on(channel, "message", (event) => {
        if (event.data?.type === "probe" && route() === "#/class")
          channel.postMessage({
            type: "presence",
            probe: event.data.probe,
            run: runtime.run,
            job: runtime.job,
          });
      });
      lifecycle.on(channel, "message", (event) => {
        const m = event.data;
        if (m?.type === "recovery-close" && route() === "#/class") {
          runtime.exitBridge.arm();
          for (const video of document.querySelectorAll(".video_wrap video")) video.pause();
          recordEvent("recovery", "收到课程页重试关闭指令", "仅退出当前课程页，不记录为完成");
          window.close();
        }
      });
      bindCourseLinkResponder({ channel, runtime, lifecycle });
      if (runtime.run && runtime.job && route() === "#/class") startPlayer(env);
      else startController(env);
      lifecycle.defer(() => channel.close?.());
      window.addEventListener("pagehide", () => lifecycle.dispose(), {
        once: true,
      });
    };
    const lifecycle = createLifecycle();
    const runtime = createRuntime({ lifecycle });
    recordEvent("page", "页面载入", route() === "#/class" ? "课程播放页" : "调度主页面");
    const platform = createPlatform();
    platform.callbacks.observeAuthResponse = runtime.observeAuthResponse;
    const channel = new BroadcastChannel(CHANNEL);
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", mount, { once: true });
    else mount();
  }
})();

// 本项目（MIT）
// MIT License
//
// Copyright (c) 2026 miunerofrade
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// Material Color Utilities（Apache-2.0）
//
//                                  Apache License
//                            Version 2.0, January 2004
//                         http://www.apache.org/licenses/
//
//    TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION
//
//    1. Definitions.
//
//       "License" shall mean the terms and conditions for use, reproduction,
//       and distribution as defined by Sections 1 through 9 of this document.
//
//       "Licensor" shall mean the copyright owner or entity authorized by
//       the copyright owner that is granting the License.
//
//       "Legal Entity" shall mean the union of the acting entity and all
//       other entities that control, are controlled by, or are under common
//       control with that entity. For the purposes of this definition,
//       "control" means (i) the power, direct or indirect, to cause the
//       direction or management of such entity, whether by contract or
//       otherwise, or (ii) ownership of fifty percent (50%) or more of the
//       outstanding shares, or (iii) beneficial ownership of such entity.
//
//       "You" (or "Your") shall mean an individual or Legal Entity
//       exercising permissions granted by this License.
//
//       "Source" form shall mean the preferred form for making modifications,
//       including but not limited to software source code, documentation
//       source, and configuration files.
//
//       "Object" form shall mean any form resulting from mechanical
//       transformation or translation of a Source form, including but
//       not limited to compiled object code, generated documentation,
//       and conversions to other media types.
//
//       "Work" shall mean the work of authorship, whether in Source or
//       Object form, made available under the License, as indicated by a
//       copyright notice that is included in or attached to the work
//       (an example is provided in the Appendix below).
//
//       "Derivative Works" shall mean any work, whether in Source or Object
//       form, that is based on (or derived from) the Work and for which the
//       editorial revisions, annotations, elaborations, or other modifications
//       represent, as a whole, an original work of authorship. For the purposes
//       of this License, Derivative Works shall not include works that remain
//       separable from, or merely link (or bind by name) to the interfaces of,
//       the Work and Derivative Works thereof.
//
//       "Contribution" shall mean any work of authorship, including
//       the original version of the Work and any modifications or additions
//       to that Work or Derivative Works thereof, that is intentionally
//       submitted to Licensor for inclusion in the Work by the copyright owner
//       or by an individual or Legal Entity authorized to submit on behalf of
//       the copyright owner. For the purposes of this definition, "submitted"
//       means any form of electronic, verbal, or written communication sent
//       to the Licensor or its representatives, including but not limited to
//       communication on electronic mailing lists, source code control systems,
//       and issue tracking systems that are managed by, or on behalf of, the
//       Licensor for the purpose of discussing and improving the Work, but
//       excluding communication that is conspicuously marked or otherwise
//       designated in writing by the copyright owner as "Not a Contribution."
//
//       "Contributor" shall mean Licensor and any individual or Legal Entity
//       on behalf of whom a Contribution has been received by Licensor and
//       subsequently incorporated within the Work.
//
//    2. Grant of Copyright License. Subject to the terms and conditions of
//       this License, each Contributor hereby grants to You a perpetual,
//       worldwide, non-exclusive, no-charge, royalty-free, irrevocable
//       copyright license to reproduce, prepare Derivative Works of,
//       publicly display, publicly perform, sublicense, and distribute the
//       Work and such Derivative Works in Source or Object form.
//
//    3. Grant of Patent License. Subject to the terms and conditions of
//       this License, each Contributor hereby grants to You a perpetual,
//       worldwide, non-exclusive, no-charge, royalty-free, irrevocable
//       (except as stated in this section) patent license to make, have made,
//       use, offer to sell, sell, import, and otherwise transfer the Work,
//       where such license applies only to those patent claims licensable
//       by such Contributor that are necessarily infringed by their
//       Contribution(s) alone or by combination of their Contribution(s)
//       with the Work to which such Contribution(s) was submitted. If You
//       institute patent litigation against any entity (including a
//       cross-claim or counterclaim in a lawsuit) alleging that the Work
//       or a Contribution incorporated within the Work constitutes direct
//       or contributory patent infringement, then any patent licenses
//       granted to You under this License for that Work shall terminate
//       as of the date such litigation is filed.
//
//    4. Redistribution. You may reproduce and distribute copies of the
//       Work or Derivative Works thereof in any medium, with or without
//       modifications, and in Source or Object form, provided that You
//       meet the following conditions:
//
//       (a) You must give any other recipients of the Work or
//           Derivative Works a copy of this License; and
//
//       (b) You must cause any modified files to carry prominent notices
//           stating that You changed the files; and
//
//       (c) You must retain, in the Source form of any Derivative Works
//           that You distribute, all copyright, patent, trademark, and
//           attribution notices from the Source form of the Work,
//           excluding those notices that do not pertain to any part of
//           the Derivative Works; and
//
//       (d) If the Work includes a "NOTICE" text file as part of its
//           distribution, then any Derivative Works that You distribute must
//           include a readable copy of the attribution notices contained
//           within such NOTICE file, excluding those notices that do not
//           pertain to any part of the Derivative Works, in at least one
//           of the following places: within a NOTICE text file distributed
//           as part of the Derivative Works; within the Source form or
//           documentation, if provided along with the Derivative Works; or,
//           within a display generated by the Derivative Works, if and
//           wherever such third-party notices normally appear. The contents
//           of the NOTICE file are for informational purposes only and
//           do not modify the License. You may add Your own attribution
//           notices within Derivative Works that You distribute, alongside
//           or as an addendum to the NOTICE text from the Work, provided
//           that such additional attribution notices cannot be construed
//           as modifying the License.
//
//       You may add Your own copyright statement to Your modifications and
//       may provide additional or different license terms and conditions
//       for use, reproduction, or distribution of Your modifications, or
//       for any such Derivative Works as a whole, provided Your use,
//       reproduction, and distribution of the Work otherwise complies with
//       the conditions stated in this License.
//
//    5. Submission of Contributions. Unless You explicitly state otherwise,
//       any Contribution intentionally submitted for inclusion in the Work
//       by You to the Licensor shall be under the terms and conditions of
//       this License, without any additional terms or conditions.
//       Notwithstanding the above, nothing herein shall supersede or modify
//       the terms of any separate license agreement you may have executed
//       with Licensor regarding such Contributions.
//
//    6. Trademarks. This License does not grant permission to use the trade
//       names, trademarks, service marks, or product names of the Licensor,
//       except as required for reasonable and customary use in describing the
//       origin of the Work and reproducing the content of the NOTICE file.
//
//    7. Disclaimer of Warranty. Unless required by applicable law or
//       agreed to in writing, Licensor provides the Work (and each
//       Contributor provides its Contributions) on an "AS IS" BASIS,
//       WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
//       implied, including, without limitation, any warranties or conditions
//       of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
//       PARTICULAR PURPOSE. You are solely responsible for determining the
//       appropriateness of using or redistributing the Work and assume any
//       risks associated with Your exercise of permissions under this License.
//
//    8. Limitation of Liability. In no event and under no legal theory,
//       whether in tort (including negligence), contract, or otherwise,
//       unless required by applicable law (such as deliberate and grossly
//       negligent acts) or agreed to in writing, shall any Contributor be
//       liable to You for damages, including any direct, indirect, special,
//       incidental, or consequential damages of any character arising as a
//       result of this License or out of the use or inability to use the
//       Work (including but not limited to damages for loss of goodwill,
//       work stoppage, computer failure or malfunction, or any and all
//       other commercial damages or losses), even if such Contributor
//       has been advised of the possibility of such damages.
//
//    9. Accepting Warranty or Additional Liability. While redistributing
//       the Work or Derivative Works thereof, You may choose to offer,
//       and charge a fee for, acceptance of support, warranty, indemnity,
//       or other liability obligations and/or rights consistent with this
//       License. However, in accepting such obligations, You may act only
//       on Your own behalf and on Your sole responsibility, not on behalf
//       of any other Contributor, and only if You agree to indemnify,
//       defend, and hold each Contributor harmless for any liability
//       incurred by, or claims asserted against, such Contributor by reason
//       of your accepting any such warranty or additional liability.
//
//    END OF TERMS AND CONDITIONS
//
//    Copyright 2021 Google LLC
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//
//        http://www.apache.org/licenses/LICENSE-2.0
//
//    Unless required by applicable law or agreed to in writing, software
//    distributed under the License is distributed on an "AS IS" BASIS,
//    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//    See the License for the specific language governing permissions and
//    limitations under the License.

// Lucide 与 Feather 图标（ISC / MIT）
// ISC License
//
// Copyright (c) 2026 Lucide Icons and Contributors
//
// Permission to use, copy, modify, and/or distribute this software for any
// purpose with or without fee is hereby granted, provided that the above
// copyright notice and this permission notice appear in all copies.
//
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
// WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
// ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
// WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
// ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
// OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
//
// ---
//
// The following Lucide icons are derived from the Feather project:
//
// airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out
//
// The MIT License (MIT) (for the icons listed above)
//
// Copyright (c) 2013-present Cole Bemis
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
