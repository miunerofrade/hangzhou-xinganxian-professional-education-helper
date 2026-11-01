import { readFileSync } from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import * as planner from "../src/planner.js";
import { bundle } from "../build.mjs";
const testSource = await bundle({ testing: true });
export const source = readFileSync(
  new URL("../hz-learning-helper.user.js", import.meta.url),
  "utf8",
);

export function fixture(message = null, overrides = {}) {
  let now = 100000;
  const sent = [],
    intervals = [],
    timeouts = [],
    clicks = [],
    nodes = new Map(),
    listeners = [],
    requests = [],
    openCalls = [],
    uiEvents = new Map(),
    animations = [];
  let child = { closed: false },
    hostNode;
  const simulatedRows = new Map();
  const nativeEvents = new Map();
  const addNative = (type, fn, options) => {
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    const list = nativeEvents.get(type) || [];
    if (!list.some((e) => e.fn === fn && e.capture === capture)) list.push({ fn, capture });
    nativeEvents.set(type, list);
  };
  const removeNative = (type, fn, options) => {
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    nativeEvents.set(
      type,
      (nativeEvents.get(type) || []).filter((e) => e.fn !== fn || e.capture !== capture),
    );
  };
  const node = () => ({
    textContent: "",
    disabled: false,
    hidden: false,
    innerHTML: "",
    value: "",
    checked: true,
    style: {
      setProperty(k, v) {
        this[k] = v;
      },
    },
    attributes: {},
    dataset: {},
    classList: {
      add() {},
      remove() {},
      toggle() {
        return true;
      },
    },
    getAttribute(k) {
      return this.attributes[k] ?? null;
    },
    setAttribute(k, v) {
      this.attributes[k] = v;
    },
    removeAttribute(k) {
      delete this.attributes[k];
    },
    focus() {
      this.focused = true;
    },
    children: [],
    replaceChildren(...items) {
      for (const child of [...this.children]) child.remove?.();
      this.children = [];
      this.append(...items);
    },
    append(...items) {
      for (const item of items) this.insertBefore(item, null);
    },
    insertBefore(item, before) {
      item.remove?.();
      const index = before ? this.children.indexOf(before) : this.children.length;
      this.children.splice(index, 0, item);
      item.parentElement = this;
    },
    remove() {
      if (!this.parentElement) return;
      const parent = this.parentElement;
      parent.children.splice(parent.children.indexOf(this), 1);
      this.parentElement = null;
    },
  });
  for (const [key, value] of Object.entries({
    "#target": "10",
    "#unit": "credits",
    "#maxMinutes": "75",
    "#maxRatio": "45",
    "#window": "",
  })) {
    const n = node();
    n.value = value;
    nodes.set(key, n);
  }
  const ui = {
    innerHTML: "",
    addEventListener(type, fn) {
      uiEvents.set(type, fn);
    },
    querySelector(selector) {
      if (!nodes.has(selector)) {
        const n = node();
        if (selector === "#annual-limit") n.checked = false;
        if (selector === "#panel") n.hidden = true;
        if (overrides.animationEnabled && (selector === "#panel" || selector === "#state"))
          n.animate = (frames, options) => {
            let finish, reject;
            const finished = new Promise((resolve, fail) => {
              finish = resolve;
              reject = fail;
            });
            const animation = {
              selector,
              frames,
              options,
              finished,
              finish,
              cancel() {
                reject(new Error("cancelled"));
              },
            };
            animations.push(animation);
            return animation;
          };
        nodes.set(selector, n);
      }
      return nodes.get(selector);
    },
  };
  const button = (label) => ({
    textContent: label,
    disabled: false,
    getClientRects: () => [{}],
    click: () => clicks.push(label),
  });
  const box =
    message === null
      ? null
      : {
          getClientRects: () => (overrides.dialogControl?.visible === false ? [] : [{}]),
          contains: () => false,
          querySelector: () => ({
            textContent: overrides.dialogControl?.message ?? message,
          }),
          querySelectorAll: () => [button("取消"), button("确定")],
        };
  const video = {
    paused: false,
    playbackRate: 1,
    readyState: 4,
    ended: false,
    error: null,
    getClientRects: () => [{}],
    pause() {
      this.paused = true;
    },
    async play() {
      this.paused = false;
    },
    ...overrides.video,
  };
  const storageWrites = [];
  const storage = new Map(overrides.storage || []);
  storage.set("front_token", overrides.token || "fixture-not-a-real-token");
  if (!storage.has("use_info"))
    storage.set("use_info", JSON.stringify({ studentid: "test-account", studentname: "Test" }));
  storage.set(
    "hz-helper:R",
    JSON.stringify({
      job: "J",
      course: { id: "7", hours: 2 },
      autoContinue: overrides.autoContinue ?? true,
    }),
  );
  class Clock extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  }
  const context = {
    innerWidth: 1000,
    innerHeight: 800,
    XMLHttpRequest: overrides.XMLHttpRequest,
    console: { info() {}, error() {} },
    Date: Clock,
    URLSearchParams,
    Set,
    Map,
    WeakMap,
    WeakSet,
    Promise,
    crypto: webcrypto,
    TextEncoder,
    Uint8Array,
    AbortController,
    URL,
    getComputedStyle: () => ({ visibility: "visible" }),
    matchMedia: () => ({ matches: !!overrides.reduceMotion }),
    location: {
      reload() {
        overrides.onReload?.();
      },
      pathname: "/",
      href: "https://learning.hzrs.hangzhou.gov.cn/",
      origin: "https://learning.hzrs.hangzhou.gov.cn",
      hash: overrides.controller
        ? "#/learn"
        : overrides.direct
          ? "#/class?courseId=7&coursetitle=Direct"
          : "#/class?courseId=7&__hzRun=R&__hzJob=J",
    },
    localStorage: {
      get length() {
        return storage.size;
      },
      key: (index) => [...storage.keys()][index] ?? null,
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => {
        storageWrites.push(k);
        storage.set(k, v);
      },
      removeItem: (k) => storage.delete(k),
    },
    sessionStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
    navigator: {
      locks: { request: (_name, _opts, cb) => cb({}) },
      ...overrides.navigator,
    },
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    clearInterval() {},
    setTimeout: (fn, ms) => {
      timeouts.push({ fn, ms });
      if (overrides.controller && ms < 45000 && !(ms === 1800 && overrides.reconnectWindow))
        queueMicrotask(fn);
      return 1;
    },
    clearTimeout() {},
    BroadcastChannel: class {
      postMessage(m) {
        sent.push(m);
        if (
          m.type === "course-link-probe" &&
          overrides.reconnectWindow &&
          !overrides.reconnectWindow.closed
        ) {
          child = overrides.reconnectWindow;
          queueMicrotask(() =>
            listeners.forEach((fn) => fn({ data: { ...m, type: "course-link-present" } })),
          );
        }
        if (m.type === "course-link-close" && overrides.reconnectWindow) {
          overrides.reconnectWindow.close?.();
          if (overrides.reconnectWindow.closed)
            queueMicrotask(() =>
              listeners.forEach((fn) => fn({ data: { ...m, type: "course-link-closed" } })),
            );
        }
        if (m.type === "recovery-close") {
          for (const page of Object.values(overrides.namedWindows || {})) {
            if (
              page.location?.origin === "https://learning.hzrs.hangzhou.gov.cn" &&
              page.location?.hash?.split("?")[0] === "#/class"
            )
              page.close();
          }
        }
      }
      removeEventListener(_name, fn) {
        const index = listeners.indexOf(fn);
        if (index >= 0) listeners.splice(index, 1);
      }
      close() {}
      addEventListener(_name, fn) {
        listeners.push(fn);
      }
    },
    document: {
      visibilityState: overrides.visibilityState || "visible",
      addEventListener() {},
      documentElement: {
        append(n) {
          hostNode = n;
        },
      },
      createElement: () => ({ ...node(), id: "", attachShadow: () => ui }),
      querySelectorAll: (selector) =>
        selector === ".video_wrap video"
          ? overrides.iframe || overrides.noVideo
            ? []
            : [overrides.videoNode || video]
          : selector === "#app iframe"
            ? overrides.frames ||
              (overrides.iframe || overrides.visibleFrame ? [{ getClientRects: () => [{}] }] : [])
            : selector === ".video-js .vjs-error-display"
              ? overrides.mediaErrorDialogs || []
              : selector === ".el-message-box"
                ? overrides.messageBoxes || (box ? [box] : [])
                : selector === '[role="dialog"],dialog[open]'
                  ? overrides.semanticDialogs || []
                  : selector === '.el-message-box,[role="dialog"],dialog[open]'
                    ? [
                        ...(overrides.messageBoxes || (box ? [box] : [])),
                        ...(overrides.semanticDialogs || []),
                      ]
                    : [],
    },
    addEventListener: addNative,
    removeEventListener: removeNative,
    close() {
      this.closed = true;
    },
    closed: false,
    open(url, name) {
      openCalls.push({ url, name });
      if (overrides.blockPopups && url !== "") return null;
      if (url === "" && overrides.namedWindows?.[name]) return overrides.namedWindows[name];
      if (url === "" && overrides.reconnectWindow) {
        child = overrides.reconnectWindow;
        return child;
      }
      if (url === "")
        return {
          location: { href: "about:blank" },
          closed: false,
          close() {
            this.closed = true;
          },
        };
      child = {
        location: { href: url },
        closed: false,
        close() {
          this.requestedClose = true;
          overrides.onChildClose?.(this);
        },
      };
      return child;
    },
    fetch: async (url, opts) => {
      const body = JSON.parse(opts.body);
      requests.push({ url, body });
      let response = overrides.response
        ? await overrides.response(url, body, requests)
        : { status: 200 };
      if (
        url.endsWith("/myStudyList") &&
        response?.status === 200 &&
        overrides.simulateListCompletion !== false
      ) {
        if (!Array.isArray(response.year) && !body.schoolyearid)
          response = {
            status: 200,
            year: [{ schoolyearid: "2026", yeartitle: "2026学年" }],
          };
        else if (
          body.schoolyearid &&
          (!Array.isArray(response?.data?.data) ||
            (response.data.total === 0 && simulatedRows.size))
        ) {
          const rows = [...simulatedRows.values()];
          response = {
            status: 200,
            year: [{ schoolyearid: "2026", yeartitle: "2026学年" }],
            data: {
              data: rows,
              total: rows.length,
              current_page: body.page,
              per_page: 100,
            },
          };
        }
      }
      return { ok: true, json: async () => response };
    },
  };
  context.window = context;
  context.top = context;
  context.self = context;
  vm.createContext(context);
  vm.runInContext(overrides.production ? source : testSource, context);
  const { env, readAPI } = context.__hzTest || {};
  context.testAPI = { ...planner, readAPI };
  context.testRefreshAnnual = env?.annual.refreshAnnual;
  context.testCalculateLearned = env?.annual.calculateLearned;
  context.testCenterMonitor = env?.testHooks.controller?.checkLearningCenter;
  context.testAutoRefresh = env?.testHooks.controller?.checkAutoRefresh;
  return {
    sent,
    clicks,
    video,
    nodes,
    requests,
    openCalls,
    storage,
    storageWrites,
    ui,
    animations,
    timeouts,
    tokenCheck: () => intervals.find((t) => t.ms === 5000).fn(),
    refreshAnnualOnly: () => context.testRefreshAnnual(),
    sumLearned: () => context.testCalculateLearned(),
    monitor: (force = false) => context.testCenterMonitor(force),
    stall: () => env?.testHooks.controller?.checkStall(),
    autoRefresh: () => context.testAutoRefresh(),
    get host() {
      return hostNode;
    },
    setVisibility: (value) => {
      context.document.visibilityState = value;
    },
    savedCache: () =>
      JSON.parse(
        [...storage.entries()].find(([k]) => k.startsWith("hz-helper-batches-v3:"))?.[1] || "null",
      ),
    savedHistory: () =>
      JSON.parse(
        [...storage.entries()].find(([k]) => k.startsWith("hz-helper-history-v1:"))?.[1] ||
          '{\"years\":[],\"items\":[]}',
      ),
    savedRecords: () =>
      JSON.parse(
        [...storage.entries()].find(([k]) => k.startsWith("hz-helper-records-v1:"))?.[1] || "{}",
      ),
    courseButton: (id, label, root = "#preview") => {
      const walk = (n) => {
        if (
          n?.dataset?.courseId === id &&
          (n.textContent === label || n.getAttribute?.("aria-label")?.startsWith(label + "："))
        )
          return n;
        for (const child of n?.children || []) {
          const result = walk(child);
          if (result) return result;
        }
        return null;
      };
      return walk(nodes.get(root));
    },
    emitUI: (type, event) => uiEvents.get(type)?.(event),
    addBeforeUnload: (fn, options) => {
      context.testGuard = fn;
      context.testOptions = options;
      vm.runInContext("window.addEventListener('beforeunload',testGuard,testOptions)", context);
    },
    removeBeforeUnload: (fn, options) => {
      context.testGuard = fn;
      context.testOptions = options;
      vm.runInContext("window.removeEventListener('beforeunload',testGuard,testOptions)", context);
    },
    dispatchWindow: (type, event) => {
      for (const { fn } of nativeEvents.get(type) || []) fn(event);
    },
    fireUnload: () => {
      const event = {
        defaultPrevented: false,
        returnValue: true,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      for (const { fn } of nativeEvents.get("beforeunload") || []) fn(event);
      return event;
    },
    get child() {
      return child;
    },
    deliver: (m) => {
      if (m?.type === "complete" && overrides.simulateListCompletion !== false) {
        const task = JSON.parse(storage.get(`hz-helper:${m.run}`) || "null");
        if (task?.course && String(task.course.id) === String(m.id))
          simulatedRows.set(String(m.id), {
            courseid: String(m.id),
            period: m.credits,
            coursetype_text: task.course.category || "一般公需",
          });
      }
      listeners.forEach((fn) => fn({ data: m }));
    },
    api: context.testAPI,
    advance: (ms) => {
      now += ms;
    },
    tick: () => intervals.find((t) => t.ms === (overrides.controller ? 2000 : 1000)).fn(),
  };
}
