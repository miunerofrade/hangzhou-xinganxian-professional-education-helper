import { createControllerState, pausePlan, finishRound, canSchedule } from "./controller-state.js";
import { createControllerMessageHandler } from "./controller-messages.js";
import { readPlanSettings, samePlanSettings, validatePlanSettings } from "./settings.js";
import { PLAN_SETTING_IDS, validRefreshMinutes } from "./settings-schema.js";
import { bindDebugHooks } from "#debug-hooks";
import { createAutoRefresh } from "./auto-refresh.js";
import { createCompletionHandler } from "./completion.js";
import { createCourseLauncher } from "./course-launcher.js";
import { createCourseLinks } from "./course-links.js";
import { createRecovery } from "./recovery.js";
import { mountControllerControls } from "./ui/controls.js";
import { recordEvent } from "./event-log.js";
import { createHistorySync } from "./history.js";
import { createPlanning } from "./planning.js";
import { createSessionManager, readSession } from "./session.js";
import { createCenterMonitor } from "./center-monitor.js";
import { createScanner } from "./scanner.js";
import { createPlanView } from "./ui/plan.js";
import { createRepository } from "./repository.js";
import { PREFIX, configKey, closeApprovalKey, ACTION_DELAY_MS } from "./constants.js";
import { number, round, sleep } from "./utils.js";
import {
  goalReached,
  usesAnnual,
  rank,
  inWindow,
  eligible,
  chooseForGoal,
  annualChoose,
} from "./planner.js";
export function startController(env) {
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
    save,
    ensureCache,
  } = repository;

  const restoredSession = readSession();
  const session = restoredSession?.session || crypto.randomUUID(),
    finished = new Set(),
    present = new Set();

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
          !blocked(c.id) && eligible(c, s) && (s.category === "auto" || c.category === s.category),
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
    save();
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
    save();
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
    save,
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
    save();
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
          if (Date.now() - state.missingSince < 3000) return;
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
          store.cache.pending = store.cache.pending.filter((c) => c.id !== state.current.course.id);
          localStorage.removeItem(`hz-helper-completion:${session}:${state.current.job}`);
          localStorage.removeItem(closeApprovalKey(session, state.current.job));
          state.current = null;
          state.child = null;
          $("#center-status").textContent = "";
          $("#center-status").hidden = true;
          save();
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
      } else if (Date.now() - state.lastHeartbeat > 20000) {
        if (!state.missingSince) state.missingSince = Date.now();
        if (Date.now() - state.missingSince > 180000)
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
    30000,
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
    2000,
  );
  checkAutoRefresh();
  lifecycle.interval(checkAutoRefresh, 1000);
  lifecycle.interval(() => void checkLearningCenter(), 30000);
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
