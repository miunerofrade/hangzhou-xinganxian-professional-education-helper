import { renderCourseProgress } from "./ui/course-progress.js";
import { ACTION_DELAY_MS } from "./constants.js";
import { observePlatformProgress } from "./recovery.js";
import { recordEvent } from "./event-log.js";
import { parsePage } from "./planner.js";
import { number, log } from "./utils.js";
export function createCenterMonitor({
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
    nextCheckAt = Date.now() + 60000;
    const report = (message, level = "info", extra = {}) => {
      recordEvent("progress", "学习中心核对", message, { level, ...extra });
      $("#center-status").hidden = true;
      $("#center-status").textContent =
        `学习中心：${message}\n上次核对 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}`;
    };
    let checkingPage = 1;
    let pageSummary = null;
    try {
      if ((await identity()) !== store.scope) throw new Error("账号已变化");
      let page = 1,
        expected = null,
        size = null,
        found = null;
      const signatures = new Set();
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
        // A positively identified course does not require proving that other
        // rows are present. Full pagination integrity is required for absence.
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
        (!manual && (getState().manualPaused || (getState().paused && !getState().heartbeatPaused)))
      )
        return;
      job.centerMonitor ||= { seen: false, missing: 0 };
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
        nextCheckAt = Date.now() + 5000;
        fastCheckTimer = setTimeout(checkLearningCenter, 5000);
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
      function tryClose() {
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
      }
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
        nextCheckAt = Date.now() + 15000;
        fastCheckTimer = setTimeout(checkLearningCenter, 15000);
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
