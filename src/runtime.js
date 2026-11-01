import { recordEvent, migrateLogs } from "./event-log.js";
import { ORIGIN, configKey, route, courseId, closeApprovalKey } from "./constants.js";
export function createRuntime({ lifecycle }) {
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
    } catch {
      /* direct takeover */
    }
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
  // 只观察平台 XHR 返回的状态，不保存响应体、令牌、请求参数或个人信息。
  let onAuthObservation = () => {},
    onStudyObservation = (http, platform, finish) =>
      recordEvent(
        "report",
        "平台进度上报",
        `HTTP ${Number(http) || 0}；平台状态 ${Number.isFinite(Number(platform)) ? Number(platform) : "未知"}；完成标记 ${[0, 1, "0", "1"].includes(finish) ? finish : "未知"}`,
      ),
    lastAuthSuccess = -Infinity;
  const knownAuthPaths = new Set([
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
      platform === null || platform === undefined || platform === "" ? null : Number(platform);
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
      if (Date.now() - lastAuthSuccess < 300000) return;
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
    } catch {
      /* 日志失败不影响平台请求 */
    }
  }
  function installAuthObserver() {
    const proto = window.XMLHttpRequest?.prototype;
    if (!proto || typeof proto.open !== "function") return;
    const originalOpen = proto.open,
      states = new WeakMap();
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
          } catch {
            /* 不干扰平台响应 */
          }
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
  }, 5000);
  // 仅助手任务页安装早期卸载适配；手动关掉未完成课程时仍保留原提示。
  const exitBridge = installExitBridge();
  function installExitBridge() {
    let config;
    try {
      config = directConfig || JSON.parse(localStorage.getItem(configKey(run)) || "null");
    } catch {
      /* invalid task */
    }
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
    const wrappers = new WeakMap();
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
        map = new Map();
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
            // 仍调用网站处理函数（包括其原生 finishStudy）；仅忽略取消离开的指令。
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
