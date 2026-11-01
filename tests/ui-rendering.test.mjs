import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeyedList } from "../src/ui/keyed-list.js";
import { createPlanView } from "../src/ui/plan.js";
import { createLogView } from "../src/ui/log.js";
import { logSummary } from "../src/ui/log-summary.js";
import { icon } from "../src/ui/icons.js";

class Element {
  constructor(tag = "div") {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.style = {};
    this.className = "";
    this.textContent = "";
    this.hidden = false;
    this.scrollTop = 0;
    this.classList = {
      add: (name) => {
        this.className = [...new Set([...this.className.split(" ").filter(Boolean), name])].join(
          " ",
        );
      },
      toggle: (name, on) => {
        const names = new Set(this.className.split(" ").filter(Boolean));
        if (on) names.add(name);
        else names.delete(name);
        this.className = [...names].join(" ");
      },
    };
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "class") this.className = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  append(...children) {
    for (const child of children) this.insertBefore(child, null);
  }
  insertBefore(child, before) {
    child.remove();
    const index = before ? this.children.indexOf(before) : this.children.length;
    assert.ok(index >= 0);
    this.children.splice(index, 0, child);
    child.parentElement = this;
  }
  remove() {
    if (this.parentElement) {
      const parent = this.parentElement;
      parent.children.splice(parent.children.indexOf(this), 1);
      this.parentElement = null;
    }
  }
  replaceChildren(...children) {
    for (const child of [...this.children]) child.remove();
    this.append(...children);
  }
}
function withDocument(run) {
  const old = globalThis.document;
  globalThis.document = { createElement: (tag) => new Element(tag) };
  try {
    return run();
  } finally {
    if (old === undefined) delete globalThis.document;
    else globalThis.document = old;
  }
}

test("keyed reconciliation reuses, reorders and removes rows without resetting the container", () => {
  const container = new Element("ol"),
    created = [];
  const list = createKeyedList({
    container,
    key: (x) => x.id,
    create: (x) => {
      const entry = { element: new Element("li") };
      created.push(entry);
      return entry;
    },
    update: (entry, x) => (entry.element.textContent = x.name),
  });
  list.render([
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ]);
  const [a, b] = container.children;
  container.scrollTop = 120;
  a.focused = true;
  list.render([
    { id: "b", name: "B2" },
    { id: "a", name: "A" },
  ]);
  assert.deepEqual(container.children, [b, a]);
  assert.equal(b.textContent, "B2");
  assert.equal(a.focused, true);
  assert.equal(container.scrollTop, 120);
  assert.equal(created.length, 2);
  list.render([
    { id: "a", name: "A" },
    { id: "c", name: "C" },
  ]);
  assert.equal(container.children[0], a);
  assert.equal(b.parentElement, null);
  assert.equal(created.length, 3);
});

test("plan updates preserve rows and scroll while current-course actions, pause and ordering change", () =>
  withDocument(() => {
    const nodes = new Map(),
      $ = (id) => {
        if (!nodes.has(id)) nodes.set(id, new Element());
        return nodes.get(id);
      };
    const settings = {
      target: 10,
      maxRatio: 45,
      unit: "hours",
      targetMode: "increment",
      category: "专业课程",
      window: "",
    };
    const a = {
      id: "a",
      name: "课程A",
      category: "专业课程",
      hours: 1,
      learned: 0,
      remaining: 1800,
    };
    const b = {
      id: "b",
      name: "课程B",
      category: "一般公需",
      hours: 0.5,
      learned: 0,
      remaining: 900,
    };
    const state = {
      records: {},
      settings: () => settings,
      total: 0,
      pending: [a, b],
      current: {
        course: a,
        centerMonitor: { percent: 10, checkedAt: Date.now() },
      },
      paused: false,
      active: true,
      manualPaused: false,
      hasOpenCourse: true,
      finished: new Set(),
      cache: null,
      targetProgress: () => 0,
    };
    const commands = [];
    const view = createPlanView({
      panel: { $, icon, info: () => "<help>" },
      getState: () => state,
      courseAction: (...args) => commands.push(args),
      restoreRecord: () => {},
    });
    view.render();
    const wrapper = $("#preview").children[0],
      list = wrapper.children[2],
      [rowA, rowB] = list.children;
    assert.equal(wrapper.tagName, "details");
    assert.equal(wrapper.open, true);
    assert.equal(wrapper.children[0].tagName, "summary");
    wrapper.open = false;
    list.scrollTop = 94;
    assert.match(rowA.children[2].className, /pill-actions/);
    state.paused = true;
    state.total = 1;
    view.render();
    assert.equal($("#preview").children[0], wrapper);
    assert.equal(wrapper.open, false, "plan collapse survives playback/progress updates");
    assert.equal(list.children[0], rowA);
    assert.equal(list.children[1], rowB);
    assert.equal(list.scrollTop, 94);
    assert.match(rowA.className, /paused/);
    state.pending = [{ ...b, name: "课程B改名" }, a];
    state.current = { course: b };
    state.paused = false;
    view.render();
    assert.equal(list.children[0], rowB);
    assert.equal(list.children[1], rowA);
    assert.match(rowB.children[2].className, /pill-actions/);
    assert.match(rowA.children[2].className, /icon-actions/);
    rowB.children[2].children[0].onclick();
    assert.deepEqual(commands, [["b", "manual"]]);
    assert.match(rowB.children[2].children[0].getAttribute("aria-label"), /课程B改名/);
    state.pending = [];
    view.render();
    assert.equal(list.children.length, 0);
    assert.equal(list.hidden, true);
    assert.equal(wrapper.children[1].hidden, false);
  }));

test("playback symbols are filled while unrelated icons retain outline rendering", () => {
  for (const name of ["play", "pause"]) {
    assert.match(icon(name), /fill="currentColor"/);
    assert.match(icon(name), /stroke="none"/);
  }
  assert.match(icon("refresh"), /fill="none"/);
  assert.match(icon("refresh"), /stroke="currentColor"/);
});

test("log accordion keeps expanded details as new events arrive and preserves raw diagnostics", () =>
  withDocument(() => {
    const oldStorage = globalThis.localStorage,
      oldWindow = globalThis.window;
    const box = new Element(),
      handlers = [];
    let rows = [
      {
        time: 1000,
        event: "运行状态",
        detail: "播放页暂未响应，继续核对学习中心；HTTP 200",
        level: "warning",
        debug: { code: 3 },
      },
    ];
    globalThis.localStorage = {
      getItem: () => JSON.stringify(rows),
      removeItem: () => {
        rows = [];
      },
    };
    globalThis.window = {};
    try {
      const view = createLogView({
        $: () => box,
        lifecycle: { on: (...args) => handlers.push(args) },
        key: "logs",
        selector: "#logs",
        empty: "暂无日志",
        describe: (row) => ({ label: row.event, detail: row.detail, level: row.level }),
      });
      const original = box.children[0];
      assert.equal(original.tagName, "details");
      assert.equal(original.children[0].children[0].textContent, "等待播放页响应");
      assert.equal(original.children[0].children[1].children[1].textContent, "WARNING");
      assert.equal(original.children[1].children[0].textContent, rows[0].detail);
      assert.deepEqual(JSON.parse(original.children[1].children[1].textContent), { code: 3 });
      original.open = true;
      rows.push({ time: 2000, event: "查询完成", detail: "index；HTTP 200", level: "info" });
      view.render();
      assert.equal(box.children[1], original);
      assert.equal(original.open, true);
      box.children[0].open = true;
      handlers.find(([target, type]) => target === box && type === "toggle")[2]({
        target: box.children[0],
      });
      assert.equal(original.open, false);
      view.clear();
      assert.equal(box.children.length, 0);
      assert.equal(box.textContent, "暂无日志");
    } finally {
      if (oldStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = oldStorage;
      if (oldWindow === undefined) delete globalThis.window;
      else globalThis.window = oldWindow;
    }
  }));

test("log headlines summarize generic status while specific event names remain intact", () => {
  assert.equal(logSummary("运行状态", "正在重新打开课程；不会改写令牌；HTTP 200"), "正在重开课程");
  assert.equal(logSummary("平台进度上报", "HTTP 200；完成标记 0"), "平台进度上报");
  assert.equal(logSummary("运行状态", "新的状态；诊断数据"), "新的状态");
});
