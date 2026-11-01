import { ORIGIN, configKey, route } from "./constants.js";
import { inWindow } from "./planner.js";
import { sleep, log } from "./utils.js";
import { recordEvent } from "./event-log.js";
export function createCourseLauncher({
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
  lock,
  probePlayers,
  reconnectCourse,
  rebuild,
  tick,
  lifecycle,
  readAPI,
  messageWorker,
}) {
  const { state: store, identity, save } = repository;
  const { $, status } = panel;
  async function launch() {
    if (state.paused || !state.active || state.current) return;
    if ((await identity()) !== store.scope) throw new Error("登录凭据已变化，请刷新主面板重新规划");
    while (state.pending.length && !state.paused) {
      const course = state.pending[0];
      if (!course.examChecked) {
        status(`正在读取课程要求：${course.name}`);
        const detail = await readAPI("/api/index/index/getCourseInfo", {
          courseid: course.id,
        });
        if (!detail.data || !["无", "W"].includes(detail.data.examtype)) {
          recordEvent("warning", "课程未加入自动播放", `${course.name}；考核类型未确认为无考核`);
          log("跳过未确认无考核的课程", { id: course.id });
          store.cache.pending = store.cache.pending.filter((c) => c.id !== course.id);
          save();
          rebuild(state.planSettings);
          render();
          await sleep(1500);
          continue;
        }
        recordEvent("query", "课程要求已确认", `${course.name}；无考核`);
        course.examChecked = true;
        const stored = store.cache.pending.find((c) => c.id === course.id);
        if (stored) stored.examChecked = true;
        save();
      }
      if (state.paused) return;
      openCourse(course);
      return;
    }
  }
  let preparedWindow = null;
  lifecycle.defer(() => {
    try {
      if (preparedWindow?.location.href === "about:blank") preparedWindow.close();
    } catch {}
    preparedWindow = null;
  });
  function openCourse(course) {
    if (lifecycle.disposed) return false;
    const id = crypto.randomUUID();
    localStorage.setItem(
      configKey(session),
      JSON.stringify({
        job: id,
        course,
        autoContinue: settings().autoContinue,
      }),
    );
    const params = new URLSearchParams({
      courseId: course.id,
      coursetitle: course.name,
      __hzRun: session,
      __hzJob: id,
    });
    const url = `${ORIGIN}/#/class?${params}`;
    let opened;
    if (preparedWindow && !preparedWindow.closed) {
      opened = preparedWindow;
      preparedWindow = null;
      if (opened.location.href !== "about:blank")
        throw new Error("准备页已跳转到其他页面，请重新开始学习");
      opened.name = `hz-helper-${session}-${id}`;
      opened.location.href = url;
    } else {
      opened = window.open(url, `hz-helper-${session}-${id}`);
    }
    if (!opened) {
      stop("请允许本站弹窗，再点击继续学习");
      return false;
    }
    state.child = opened;
    state.current = {
      job: id,
      course,
      complete: false,
      startedAt: Date.now(),
      lastProgressAt: Date.now(),
    };
    state.lastHeartbeat = Date.now();
    state.missingSince = 0;
    $("#center-status").textContent = "";
    $("#center-status").hidden = true;
    render();
    status("正在学习");
    return true;
  }
  $("#start").onclick = async (event) => {
    if (state.starting) return;
    if (state.active && !state.paused) {
      stop();
      return;
    }
    if (state.busy) return;
    state.busy = true;
    state.starting = true;
    render();
    try {
      // Reserve a course window in the real click stack, before any awaited
      // identity checks, instance probes or course-detail requests.
      if (
        event?.isTrusted &&
        state.planSettings &&
        samePlan(settings()) &&
        !reached(state.planSettings) &&
        inWindow(state.planSettings.window) &&
        (!state.current || state.child?.closed)
      ) {
        preparedWindow = window.open("about:blank", `hz-helper-prepare-${crypto.randomUUID()}`);
        if (!preparedWindow) throw new Error("浏览器阻止打开课程页，请允许本站弹窗后重试");
      }
      if (state.current && !state.child && !(await reconnectCourse())) {
        await probePlayers();
        await new Promise((resolve, reject) =>
          navigator.locks
            .request("hz-helper-player-v1", { ifAvailable: true }, (token) =>
              token
                ? resolve()
                : reject(new Error("课程页仍在运行，暂不能重新打开；请切回课程页检查")),
            )
            .catch(reject),
        );
        state.child = { closed: true };
      }
      if (route() === "#/class") throw new Error("请在学习中心或网络课程页调度，先关闭手动播放页");
      if (!state.planSettings || !samePlan(settings())) throw new Error("请先按当前设置预览课程");
      if (reached(state.planSettings)) throw new Error("目标已达到，请调整目标后重新查找");
      if (!state.pending.length && !state.current)
        throw new Error("当前批次无候选，请先预览下一批");
      if ((await identity()) !== store.scope)
        throw new Error("登录凭据已变化，请刷新主面板重新规划");
      await lock();
      const reopen =
        !!state.current &&
        !!state.child?.closed &&
        !state.current.complete &&
        !state.current.skipped;
      if (!state.current || reopen) await probePlayers();
      if (state.manualPaused && state.current) state.current.resumedAt = Date.now();
      state.active = true;
      state.paused = false;
      state.heartbeatPaused = false;
      state.manualPaused = false;

      render();
      if (reopen) {
        openCourse(state.current.course);
      } else if (state.current && state.child?.closed) {
        status("课页已关闭，正在继续调度");
        lifecycle.timeout(
          () =>
            tick().catch((error) => {
              stop();
              fail(error);
            }),
          0,
        );
      } else if (state.current) {
        messageWorker("resume");
        render();
        status("已恢复当前播放页");
      } else if (inWindow(state.planSettings.window)) await launch();
      else status("等待新开课时间段，保持本面板打开");
    } catch (error) {
      stop();
      fail(error);
    } finally {
      if (preparedWindow) {
        try {
          if (preparedWindow.location.href === "about:blank") preparedWindow.close();
        } catch {}
        preparedWindow = null;
      }
      state.starting = false;
      state.busy = false;
      render();
    }
  };
  return { launch, openCourse };
}
