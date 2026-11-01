import { number } from "./utils.js";
const resumeKey = "hz-helper-controller-session-v1";
export function readSession() {
  try {
    return JSON.parse(sessionStorage.getItem(resumeKey) || "null");
  } catch {
    return null;
  }
}
export function createSessionManager({
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
      status(state.paused ? "已恢复暂停的学习计划" : state.current ? "正在学习" : "已恢复学习计划");
  }
  return { snapshotSession, reconnectCourse, restoreSession };
}
