import { goalReached, projectProgress, usesAnnual } from "./planner.js";
import { round, sleep } from "./utils.js";
export function createPlanning({
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
      if (hasMore(s) && (forceRead || !planSatisfied(s))) await searchUntilSatisfied(s, forceRead);
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
                  predicted.public < s.public ? `公需差 ${round(s.public - predicted.public)}` : "",
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
