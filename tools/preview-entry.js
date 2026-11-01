import { createPanel } from "../src/ui/panel.js";
import { mountControllerControls, mountPlayerControls } from "../src/ui/controls.js";
import { createPlanView } from "../src/ui/plan.js";
import { createDiagnostics } from "../src/diagnostics.js";
import { recordEvent, LOG_KEY } from "../src/event-log.js";
// This entry imports UI only: no platform, authentication, scheduler or player runtime.
localStorage.removeItem(LOG_KEY);
localStorage.setItem("hz-helper-keep-awake-v1", "0");
const mode = new URLSearchParams(location.search).get("mode") || "controller";

function mount(mode) {
  const p = createPanel(),
    $ = p.$;
  Object.assign(p.ui.host.style, {
    position: "relative",
    inset: "auto",
    zIndex: "1",
    display: "block",
  });
  document.querySelector("#previews").append(p.ui.host);
  const style = document.createElement("style");
  style.textContent =
    "#launcher{display:none}#panel{position:relative;inset:auto;height:auto;max-height:none;overflow:visible}";
  p.ui.append(style);
  $("#panel").hidden = false;
  $("#keep-awake").checked = false;
  $("#keep-awake").onchange = () => {};
  if (mode === "player") mountPlayerControls(p);
  else mountControllerControls(p);
  $("#panel").classList.toggle("player-panel", mode === "player");
  $("#estimate-total").textContent = "46.5";
  $("#estimate-professional").textContent = "44";
  $("#estimate-public").textContent = "2.5";
  $("#annual-total").textContent = "33.5";
  $("#annual-year").textContent = "平台默认学年：2026";
  $("#mute-video").checked = true;
  $("#mute-video").onchange();
  $("#refresh-annual").onclick = () =>
    recordEvent("info", "预览：刷新学时", "展示示例学时，不访问平台");
  createDiagnostics({ $, lifecycle: p.lifecycle });
  if (mode === "player") {
    let playing = true;
    const render = () => {
      const label = playing ? "暂停" : "继续播放";
      $("#playback-toggle").innerHTML =
        `${p.icon(playing ? "pause" : "play", 20)}<span>${label}</span>`;
      $("#playback-toggle").setAttribute("aria-label", label);
      $("#panel").classList.toggle("is-paused", !playing);
    };
    $("#progress").textContent =
      "当前课程：智慧交通与交通大数据：第一章 大数据应用——交通信息处理（上）";
    $("#playback-toggle").onclick = () => {
      playing = !playing;
      render();
    };
    for (const id of ["worker-learned", "worker-remove"])
      $("#" + id).onclick = () => recordEvent("info", "预览操作", "仅演示按钮，不改变平台记录");
    render();
    return;
  }
  const initial = [
    {
      id: "1",
      name: "智慧交通与交通大数据：第一章 大数据应用——交通信息处理（上）",
      category: "专业课程",
      hours: 1,
      remaining: 1800,
      learned: 0,
    },
    {
      id: "2",
      name: "绿色发展与低碳转型",
      category: "一般公需",
      hours: 0.5,
      remaining: 900,
      learned: 0,
    },
    {
      id: "3",
      name: "城市交通治理与公共服务创新",
      category: "专业课程",
      hours: 1,
      remaining: 1800,
      learned: 0,
    },
    {
      id: "4",
      name: "基础设施数字化与智能养护",
      category: "专业课程",
      hours: 1,
      remaining: 1800,
      learned: 0,
    },
  ];
  let active = false,
    paused = true,
    starting = false,
    pending = [...initial],
    current = null;
  const settings = () => ({
    target: Number($("#target").value) || 60,
    targetMode: $("#targetMode").value,
    maxRatio: 45,
    category: $("#category").value,
    window: $("#window").value,
  });
  $("#target").value = "60";
  $("#category").value = "专业课程";
  $("#refresh-countdown").hidden = false;
  const view = createPlanView({
    panel: p,
    getState: () => ({
      records: {},
      planSettings: settings(),
      settings,
      total: 20.5,
      pending,
      current,
      paused,
      active,
      manualPaused: paused,
      starting,
      hasOpenCourse: !!current,
      cache: {},
      finished: new Set(),
      targetProgress: () => 46.5,
      scanFor: () => ({ category: "专业课程", scan: { nextPage: 4 } }),
    }),
    courseAction: (id, action) => {
      pending = pending.filter((c) => c.id !== id);
      if (current?.course.id === id)
        current = pending.length
          ? {
              course: pending[0],
              centerMonitor: { percent: 20, checkedAt: Date.now() },
            }
          : null;
      recordEvent(
        "info",
        "预览操作",
        action === "excluded" ? "从示例计划移除课程" : "从示例计划跳过课程",
      );
      render();
    },
    restoreRecord: () => {},
  });
  function render() {
    view.render();
    $("#refresh-countdown").textContent = active && !paused ? "刷新 14:59" : "刷新已暂停";
  }
  $("#start").onclick = () => {
    if (starting) return;
    if (active && !paused) {
      paused = true;
      render();
      return;
    }
    if (!pending.length) pending = [...initial];
    starting = true;
    render();
    setTimeout(() => {
      starting = false;
      active = true;
      paused = false;
      current ||= {
        course: pending[0],
        centerMonitor: { percent: 20, checkedAt: Date.now() },
      };
      render();
    }, 450);
  };
  $("#plan").onclick = () => {
    pending = [...initial];
    render();
    recordEvent("info", "预览：安排课程", "已使用示例课程更新计划");
  };
  $("#read-next").onclick = () => {
    pending = [...pending, { ...initial[0], id: String(Date.now()), name: "新增示例课程" }];
    render();
  };
  $("#check-course-progress").onclick = () => {
    if (current) {
      current.centerMonitor = {
        percent: Math.min(100, (current.centerMonitor?.percent || 0) + 5),
        checkedAt: Date.now(),
      };
      render();
    }
  };
  $("#reset").onclick = () => {
    active = false;
    paused = true;
    current = null;
    pending = [...initial];
    render();
  };
  $("#sync-history").onclick = () => {
    $("#history-progress").textContent = "预览：已读取 12 条；新增 0 条；本地共 12 条";
    recordEvent("info", "预览：同步已学", "仅展示示例结果，不访问平台");
  };
  for (const id of ["target", "targetMode", "category", "window"]) $("#" + id).onchange = render;
  render();
}
if (mode !== "player") mount("controller");
if (mode !== "controller") mount("player");
recordEvent("info", "独立交互预览", "所有内容均为示例，按钮只操作本页，不连接平台");
