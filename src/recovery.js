import { ORIGIN, closeApprovalKey, ACTION_DELAY_MS } from "./constants.js";
import { sleep } from "./utils.js";
import { recordEvent } from "./event-log.js";
export const STALL_MS = 20 * 60 * 1000;
export function observePlatformProgress(job, seconds, now = Date.now()) {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  if (job.lastPlatformSeconds === undefined || seconds > job.lastPlatformSeconds) {
    if (job.lastPlatformSeconds !== undefined || seconds > 0) job.lastProgressAt = now;
    job.lastPlatformSeconds = seconds;
  }
}
export function createRecovery({
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
  const allowed = (job) =>
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
      if (!allowed(task.job)) {
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
    if (!job || !allowed(job)) {
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
    const windows = new Set();
    if (state.child) {
      try {
        const page = state.child;
        // Channel-backed links already validate the exact task; real handles may
        // have been navigated to unrelated work since the course was opened.
        if (
          !page.location ||
          (page.location.origin === ORIGIN &&
            page.location.hash?.split("?")[0].toLowerCase() === "#/class")
        )
          windows.add(page);
        else if (!page.location.origin && page.location.href?.startsWith(`${ORIGIN}/#/class?`))
          windows.add(page);
      } catch {
        /* A window navigated cross-origin is left untouched. */
      }
    }
    // Other live workers receive recovery-close and exit themselves. Historical
    // config keys are not evidence of an open tab; never probe them with open().
    retryPermission(session, job.job, job.course.id);
    for (const page of windows) {
      try {
        if (!page.closed) page.close();
      } catch {}
    }
    return windows;
  }
  async function recover(job, reason, onlyIfStalled = false) {
    if (!job || !allowed(job) || state.recovering) return;
    if (state.busy) {
      enqueue(job, reason, onlyIfStalled);
      return;
    }
    if (Date.now() - lastRecoveryAt < 60000) {
      enqueue(job, reason, onlyIfStalled, 60000 - (Date.now() - lastRecoveryAt));
      return;
    }
    lastRecoveryAt = Date.now();
    pending = null;
    state.recovering = true;
    state.busy = true;
    recordEvent("recovery", "开始恢复当前课程", `${reason}；关闭课程页后重开同一课程，不计入完成`);
    status("正在恢复：关闭其他课程页，然后重开当前课程");
    try {
      if ((await identity()) !== store.scope) throw new Error("账户已变化，停止恢复");
      await checkCenter(true);
      if (job.centerMonitor?.missing > 0 && !job.complete) {
        await sleep(5000);
        await checkCenter(true);
      }
      if (
        onlyIfStalled &&
        Date.now() - Math.max(job.lastProgressAt ?? job.startedAt, job.resumedAt ?? 0) < STALL_MS
      )
        return;
      if (!allowed(job)) return;
      retryPermission(session, job.job, job.course.id);
      channel.postMessage({
        type: "recovery-close",
        run: session,
        recovery: crypto.randomUUID(),
      });
      const windows = closeKnownWindows(job);
      for (let attempt = 0; attempt < 3; attempt++) {
        await sleep(ACTION_DELAY_MS);
        if (!allowed(job)) return;
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
      if (!allowed(job) || (await identity()) !== store.scope) return;
      // Keep the old job until all old windows are confirmed closed. openCourse
      // creates a fresh job for the same course and retains platform progress.
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
      enqueue(job, reason, onlyIfStalled, 60000);
    } finally {
      state.recovering = false;
      state.busy = false;
    }
  }
  async function checkStall() {
    const job = state.current;
    if (!job || !allowed(job) || checking || state.recovering || state.busy || isMonitorBusy())
      return;
    if (pending?.job === job && Date.now() - lastRecoveryAt >= 60000) {
      await recover(job, pending.reason, pending.onlyIfStalled);
      return;
    }
    job.startedAt ??= Date.now();
    if (Date.now() - Math.max(job.lastProgressAt ?? job.startedAt, job.resumedAt ?? 0) < STALL_MS)
      return;
    checking = true;
    try {
      // Give completion/progress verification priority over restarting a course.
      await checkCenter(true);
      if (
        allowed(job) &&
        Date.now() - Math.max(job.lastProgressAt ?? job.startedAt, job.resumedAt ?? 0) >= STALL_MS
      )
        await recover(job, "平台进度超过20分钟没有增长", true);
    } finally {
      checking = false;
    }
  }
  return { recover, request, checkStall };
}
