import { createKeyedList } from "./keyed-list.js";
import { createCourseRow } from "./course-row.js";
import { renderProgressBar } from "./progress-bar.js";
import { renderCourseProgress } from "./course-progress.js";
import { round } from "../utils.js";
// The view consumes a read-only snapshot. Storage and scheduler mutations stay in commands.
export function createPlanView({ panel, getState, courseAction, restoreRecord }) {
  const { $, info, icon } = panel;
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
      start.innerHTML = `${icon(active && !paused && !starting ? "pause" : "play", 20)}<span>${label}</span>`;
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
