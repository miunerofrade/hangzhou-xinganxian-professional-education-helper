import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture.mjs";

function catalog(url, body) {
  if (url.endsWith("/SelectCourse"))
    return {
      status: 200,
      course: {
        data: [
          {
            courseid: "a",
            coursename: "课程A",
            period: 0.5,
            coursetimes: 900,
            coursetype: "一般公需",
            examtype_text: "无",
          },
          {
            courseid: "b",
            coursename: "课程B",
            period: 0.5,
            coursetimes: 900,
            coursetype: "一般公需",
            examtype_text: "无",
          },
        ],
        current_page: body.page,
        per_page: 100,
        total: 2,
      },
    };
  if (url.endsWith("/myStudyList"))
    return !body.schoolyearid
      ? { status: 200, year: [{ schoolyearid: "year", yeartitle: "学年" }] }
      : {
          status: 200,
          data: { data: [], total: 0, current_page: 1, per_page: 100 },
        };
  return {
    status: 200,
    data: { data: [], current_page: body.page, per_page: 100, total: 0 },
  };
}
async function running(options = {}) {
  let monitoring = false,
    gone = false,
    studied = 800;
  const f = fixture(null, {
    controller: true,
    simulateListCompletion: false,
    ...options,
    response: (url, body) => {
      if (monitoring && url.endsWith("/Course/index"))
        return {
          status: 200,
          data: {
            data: gone
              ? []
              : [
                  {
                    courseid: "a",
                    coursename: "课程A",
                    validstudytime: studied,
                    coursetimes: 900,
                  },
                ],
            current_page: body.page,
            per_page: 100,
            total: gone ? 0 : 1,
          },
        };
      if (monitoring && gone && url.endsWith("/myStudyList") && body.schoolyearid)
        return {
          status: 200,
          data: {
            data: [{ courseid: "a", period: 0.5, coursetype_text: "一般公需" }],
            total: 1,
            current_page: 1,
            per_page: 100,
          },
        };
      return catalog(url, body);
    },
  });
  f.nodes.get("#target").value = "1";
  await f.nodes.get("#plan").onclick();
  await f.nodes.get("#start").onclick();
  const [key, value] = [...f.storage].find(
    ([key]) => key.startsWith("hz-helper:") && key !== "hz-helper:R",
  );
  const task = JSON.parse(value),
    run = key.slice("hz-helper:".length);
  monitoring = true;
  await f.monitor();
  return {
    f,
    run,
    task,
    progress(value) {
      studied = value;
    },
    disappear() {
      gone = true;
    },
    message(type, extra = {}) {
      f.deliver({ type, run, job: task.job, id: task.course.id, ...extra });
    },
  };
}
test("multiple-dialog automatic pause keeps platform monitoring and closes verified completion", async () => {
  let proofBeforeClose = false;
  const r = await running({
    onChildClose(child) {
      proofBeforeClose = [...r.f.storage.keys()].some((key) =>
        key.startsWith("hz-helper-close-approved:"),
      );
      child.closed = true;
    },
  });
  r.message("paused", {
    reason: "遇到未识别或多个弹窗，请手动处理后继续",
    manual: false,
  });
  assert.match(r.f.nodes.get("#state").textContent, /继续核对完成状态/);
  r.disappear();
  r.f.advance(60000);
  await r.f.monitor();
  assert.equal(r.f.savedCache().completed.length, 0);
  r.f.advance(5000);
  await r.f.monitor();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(r.f.savedRecords().a.source, "学习中心消失并存在于已学列表");
  assert.equal(
    proofBeforeClose,
    true,
    "store verified close proof before the parent attempts close",
  );
  assert.equal(r.f.child.closed, true);
  assert.ok(r.f.sent.some((m) => m.type === "list-complete"));
  r.message("paused", { reason: "迟到的自动暂停", manual: false });
  await r.f.tick();
  const newTask = JSON.parse(r.f.storage.get(`hz-helper:${r.run}`));
  assert.equal(newTask.course.id, "b", "automatically continue after the verified old page closes");
});
test("manual pause wins over late automatic-pause and automatic-resume messages", async () => {
  const r = await running();
  r.f.nodes.get("#start").onclick();
  r.message("paused", {
    reason: "遇到未识别或多个弹窗，请手动处理后继续",
    manual: false,
  });
  r.message("resumed", { manual: false });
  r.disappear();
  r.f.advance(60000);
  const before = r.f.requests.length;
  await r.f.monitor();
  assert.equal(r.f.requests.length, before);
  assert.equal(r.f.savedCache().completed.length, 0);
  r.message("resumed", { manual: true });
  await r.f.monitor();
  assert.ok(r.f.requests.length > before, "explicit user continuation releases the manual pause");
});
test("automatic hold survives reload while manual pause stays paused", async () => {
  const r = await running();
  r.message("paused", {
    reason: "遇到未识别或多个弹窗，请手动处理后继续",
    manual: false,
  });
  const player = r.f.child;
  player.location = {
    href: "https://learning.hzrs.hangzhou.gov.cn/#/class",
    hash: `#/class?__hzRun=${r.run}&__hzJob=${r.task.job}`,
  };
  r.f.dispatchWindow("pagehide", {});
  const snapshot = JSON.parse(r.f.storage.get("hz-helper-controller-session-v1"));
  assert.equal(snapshot.manualPaused, false);
  assert.equal(snapshot.heartbeatPaused, true);
  const restored = fixture(null, {
    controller: true,
    storage: [...r.f.storage],
    reconnectWindow: player,
    response: catalog,
  });
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  const before = restored.requests.length;
  await restored.monitor();
  assert.ok(restored.requests.length > before, "restored automatic hold keeps checking platform");
});
test("close proof is task-bound and honored by unload even without a channel message", () => {
  const f = fixture(null);
  f.addBeforeUnload((e) => {
    e.preventDefault();
    e.returnValue = "";
  });
  assert.equal(f.fireUnload().defaultPrevented, true);
  f.storage.set(
    "hz-helper-close-approved:R:J",
    JSON.stringify({ id: "other", source: "learning-center", at: 1 }),
  );
  assert.equal(f.fireUnload().defaultPrevented, true, "mismatched course never authorizes exit");
  f.storage.set(
    "hz-helper-close-approved:R:J",
    JSON.stringify({ id: "7", source: "learning-center", at: 1 }),
  );
  assert.equal(
    f.fireUnload().defaultPrevented,
    false,
    "verified proof is read synchronously during unload",
  );
});
test("nested semantic wrapper is one dialog; multiple known dialogs no longer pause the plan", async () => {
  const visible = () => [{}];
  const box = {
    getClientRects: visible,
    contains: () => false,
    querySelector: () => ({ textContent: "是否继续学习？" }),
    querySelectorAll: () => [],
  };
  const wrapper = { getClientRects: visible, contains: (node) => node === box };
  const f = fixture(null, { messageBoxes: [box], semanticDialogs: [wrapper] });
  await f.tick();
  assert.equal(
    f.sent.some((m) => m.type === "paused"),
    false,
  );
  const multi = fixture(null, {
    messageBoxes: [box, { ...box }],
    semanticDialogs: [wrapper],
  });
  await multi.tick();
  assert.equal(
    multi.sent.some((m) => m.type === "paused"),
    false,
  );
});

test("blocked browser close is retried at most three times without parallel courses", async () => {
  let attempts = 0;
  const r = await running({
    onChildClose() {
      attempts++;
    },
  });
  r.message("paused", { reason: "遇到多个弹窗", manual: false });
  r.disappear();
  r.f.advance(60000);
  await r.f.monitor();
  r.f.advance(5000);
  await r.f.monitor();
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(attempts, 3);
  assert.equal(r.f.child.closed, false);
  assert.match(r.f.nodes.get("#center-status").textContent, /浏览器尚未关闭课页/);
  await r.f.tick();
  assert.equal(JSON.parse(r.f.storage.get(`hz-helper:${r.run}`)).course.id, "a");
});

test("twenty minutes without platform progress reopens the same course without completing it", async () => {
  const r = await running({
    onChildClose(page) {
      page.closed = true;
    },
  });
  const old = r.f.child;
  r.f.advance(20 * 60 * 1000 + 1);
  await r.f.stall();
  assert.equal(old.closed, true);
  const fresh = JSON.parse(r.f.storage.get(`hz-helper:${r.run}`));
  assert.equal(fresh.course.id, "a");
  assert.notEqual(fresh.job, r.task.job);
  assert.equal(r.f.savedCache().completed.length, 0);
  assert.ok(r.f.sent.some((m) => m.type === "recovery-close"));
});
test("manual pause disables the twenty-minute watchdog", async () => {
  const r = await running({
    onChildClose(page) {
      page.closed = true;
    },
  });
  r.f.nodes.get("#start").onclick();
  r.f.advance(21 * 60 * 1000);
  await r.f.stall();
  assert.equal(r.f.child.closed, false);
  assert.equal(
    r.f.sent.some((m) => m.type === "recovery-close"),
    false,
  );
});

test("a fresh authoritative increase prevents the stalled-course retry", async () => {
  const r = await running({
    onChildClose(page) {
      page.closed = true;
    },
  });
  r.f.advance(21 * 60 * 1000);
  r.progress(810);
  await r.f.stall();
  assert.equal(r.f.child.closed, false);
  assert.equal(
    r.f.sent.some((m) => m.type === "recovery-close"),
    false,
  );
});
test("recovery closes other helper course pages while preserving a window navigated to unrelated work", async () => {
  const other = {
    closed: false,
    location: {
      href: "https://learning.hzrs.hangzhou.gov.cn/#/class?courseId=z",
      origin: "https://learning.hzrs.hangzhou.gov.cn",
      hash: "#/class?courseId=z",
    },
    close() {
      this.closed = true;
    },
  };
  const work = {
    closed: false,
    location: {
      href: "https://example.com/work",
      origin: "https://example.com",
      hash: "",
    },
    close() {
      this.closed = true;
    },
  };
  const r = await running({
    namedWindows: { "hz-helper-other": other, "hz-helper-work": work },
    onChildClose(page) {
      page.closed = true;
    },
  });
  r.f.storage.set("hz-helper:other", JSON.stringify({ job: "other-job", course: { id: "z" } }));
  r.f.storage.set("hz-helper:work", JSON.stringify({ job: "work-job", course: { id: "w" } }));
  r.f.advance(21 * 60 * 1000);
  await r.f.stall();
  assert.equal(other.closed, true);
  assert.equal(work.closed, false);
});

test("old automatic iframe exclusions are retried on adapter upgrade; manual exclusions remain", async () => {
  const initial = fixture(null, { controller: true, response: catalog });
  initial.nodes.get("#target").value = "1";
  await initial.nodes.get("#plan").onclick();
  const cacheKey = [...initial.storage.keys()].find((key) =>
    key.startsWith("hz-helper-batches-v3:"),
  );
  const recordsKey = [...initial.storage.keys()].find((key) =>
    key.startsWith("hz-helper-records-v1:"),
  );
  const cache = JSON.parse(initial.storage.get(cacheKey)),
    course = cache.pending.find((c) => c.id === "a");
  cache.frameAdapterVersion = 1;
  cache.pending = cache.pending.filter((c) => c.id !== "a");
  initial.storage.set(cacheKey, JSON.stringify(cache));
  initial.storage.set(
    recordsKey,
    JSON.stringify({
      a: { id: "a", kind: "auto-excluded", reason: "iframe 课件", course },
      manual: { id: "manual", kind: "excluded" },
    }),
  );
  const upgraded = fixture(null, {
    controller: true,
    response: catalog,
    storage: [...initial.storage],
  });
  await upgraded.nodes.get("#plan").onclick();
  assert.equal(upgraded.savedRecords().a, undefined);
  assert.equal(upgraded.savedRecords().manual.kind, "excluded");
  assert.ok(upgraded.savedCache().pending.some((c) => c.id === "a"));
  assert.equal(upgraded.savedCache().frameAdapterVersion, 2);
});
test("next-course dispatch uses the requested two-second action wait", async () => {
  const r = await running();
  r.message("complete", { credits: 0.5 });
  r.f.child.closed = true;
  r.f.timeouts.length = 0;
  await r.f.tick();
  assert.ok(r.f.timeouts.some((t) => t.ms === 2000));
  assert.equal(
    r.f.timeouts.some((t) => t.ms >= 6000 && t.ms <= 10000),
    false,
  );
});

test("history sync reports records read separately from newly imported records", async () => {
  let syncing = false;
  const progress = [];
  const f = fixture(null, {
    controller: true,
    simulateListCompletion: false,
    response: (url, body) => {
      if (!syncing || !url.endsWith("/myStudyList")) return catalog(url, body);
      progress.push(f.nodes.get("#history-progress").textContent);
      const years = [
        { schoolyearid: "2026", yeartitle: "2026学年" },
        { schoolyearid: "2025", yeartitle: "2025学年" },
      ];
      if (!body.schoolyearid) return { status: 200, year: years };
      return {
        status: 200,
        data: {
          data: body.page === 1 ? [{ courseid: "old1" }] : [{ courseid: "old2" }],
          total: 2,
          per_page: 1,
          current_page: body.page,
        },
      };
    },
  });
  await f.nodes.get("#plan").onclick();
  syncing = true;
  await f.nodes.get("#sync-history").onclick();
  assert.match(
    f.nodes.get("#history-progress").textContent,
    /已读取 4 条学习记录；新增 4 条；本地共 4 条/,
  );
  await f.nodes.get("#sync-history").onclick();
  assert.match(
    f.nodes.get("#history-progress").textContent,
    /已读取 4 条学习记录；新增 0 条；本地共 4 条/,
  );
  assert.ok(progress.some((p) => /2025学年（2\/2 学年）/.test(p)));
  assert.ok(progress.some((p) => /第 2 页/.test(p)));
  assert.equal(f.nodes.get("#earned").textContent, 0);
});

test("a slow history sync does not stop playback or prevent next-course dispatch", async () => {
  let syncing = false,
    held = false,
    resolvePage,
    pageStarted;
  const pageReady = new Promise((resolve) => (pageStarted = resolve));
  const f = fixture(null, {
    controller: true,
    simulateListCompletion: false,
    response: (url, body) => {
      if (syncing && !held && url.endsWith("/myStudyList") && body.schoolyearid) {
        held = true;
        pageStarted();
        return new Promise((resolve) => (resolvePage = resolve));
      }
      return catalog(url, body);
    },
  });
  f.nodes.get("#target").value = "1";
  await f.nodes.get("#plan").onclick();
  await f.nodes.get("#start").onclick();
  const [key, raw] = [...f.storage].find(
    ([k]) => k.startsWith("hz-helper:") && k !== "hz-helper:R",
  );
  const job = JSON.parse(raw);
  const child = f.child;
  const before = f.sent.length;
  syncing = true;
  const sync = f.nodes.get("#sync-history").onclick();
  await pageReady;
  await f.nodes.get("#sync-history").onclick();
  assert.equal(f.nodes.get("#sync-history").disabled, true);
  assert.equal(
    f.sent.slice(before).some((m) => m.type === "pause"),
    false,
  );
  f.deliver({
    type: "complete",
    run: key.slice("hz-helper:".length),
    job: job.job,
    id: job.course.id,
    credits: 0.5,
  });
  child.closed = true;
  await f.tick();
  assert.notEqual(f.child, child, "next course dispatches while history request is pending");
  resolvePage({
    status: 200,
    data: { data: [], total: 0, per_page: 100, current_page: 1 },
  });
  await sync;
  assert.equal(f.nodes.get("#sync-history").disabled, false);
  assert.equal(
    f.sent.slice(before).some((m) => m.type === "pause"),
    false,
  );
});

test("continue searching while playing preserves the job, including query failure", async () => {
  let failRead = false;
  const f = fixture(null, {
    controller: true,
    simulateListCompletion: false,
    response: (url, body) => {
      if (failRead && url.endsWith("/SelectCourse")) return { status: 403 };
      const response = catalog(url, body);
      if (url.endsWith("/SelectCourse")) {
        response.course.total = 1000;
        if (body.page > 1)
          for (const row of response.course.data) row.courseid += String(body.page);
      }
      return response;
    },
  });
  f.nodes.get("#target").value = "0.5";
  await f.nodes.get("#plan").onclick();
  await f.nodes.get("#start").onclick();
  const child = f.child,
    before = f.sent.length;
  const requestCount = f.requests.filter((r) => r.url.endsWith("/SelectCourse")).length;
  await f.nodes.get("#read-next").onclick();
  assert.ok(f.requests.filter((r) => r.url.endsWith("/SelectCourse")).length > requestCount);
  assert.equal(f.child, child);
  assert.match(f.nodes.get("#state").textContent, /课程查询完成/);
  failRead = true;
  await f.nodes.get("#read-next").onclick();
  assert.equal(f.child, child);
  assert.equal(
    f.sent.slice(before).some((m) => m.type === "pause"),
    false,
  );
  assert.match(f.nodes.get("#state").textContent, /当前学习状态保持不变/);
});

test("history query failure leaves the running scheduler able to switch courses", async () => {
  let failHistory = false;
  const f = fixture(null, {
    controller: true,
    simulateListCompletion: false,
    response: (url, body) =>
      failHistory && url.endsWith("/myStudyList") ? { status: 403 } : catalog(url, body),
  });
  f.nodes.get("#target").value = "1";
  await f.nodes.get("#plan").onclick();
  await f.nodes.get("#start").onclick();
  const [key, raw] = [...f.storage].find(
    ([k]) => k.startsWith("hz-helper:") && k !== "hz-helper:R",
  );
  const task = JSON.parse(raw),
    child = f.child,
    before = f.sent.length;
  failHistory = true;
  await f.nodes.get("#sync-history").onclick();
  assert.match(f.nodes.get("#history-progress").textContent, /同步未完成/);
  assert.equal(f.nodes.get("#sync-history").disabled, false);
  assert.equal(
    f.sent.slice(before).some((m) => m.type === "pause"),
    false,
  );
  failHistory = false;
  f.deliver({
    type: "complete",
    run: key.slice("hz-helper:".length),
    job: task.job,
    id: task.course.id,
    credits: 0.5,
  });
  child.closed = true;
  await f.tick();
  assert.notEqual(f.child, child);
});

test("monitor reads a found course on a short page but requires complete pages to prove absence", async () => {
  let mode = "setup";
  const f = fixture(null, {
    controller: true,
    simulateListCompletion: false,
    response: (url, body) => {
      if (mode !== "setup" && url.endsWith("/Course/index"))
        return {
          status: 200,
          data: {
            data:
              mode === "short"
                ? [
                    {
                      courseid: "a",
                      coursename: "课程A",
                      validstudytime: 450,
                      coursetimes: 900,
                    },
                  ]
                : [],
            total: 2,
            per_page: 100,
            current_page: body.page,
          },
        };
      return catalog(url, body);
    },
  });
  f.nodes.get("#target").value = "1";
  await f.nodes.get("#plan").onclick();
  await f.nodes.get("#start").onclick();
  mode = "short";
  await f.monitor(true);
  assert.match(f.nodes.get("#center-status").textContent, /当前课程 50%/);
  assert.equal(f.nodes.get("#center-status").hidden, true);
  assert.equal(f.nodes.get("#center-progress").hidden, false);
  assert.equal(f.nodes.get("#center-progress-fill").style.width, "50%");
  assert.equal(f.nodes.get("#center-progress-bar").getAttribute("aria-valuenow"), "50");
  const checked = f.nodes.get("#center-check-time").textContent;
  assert.match(checked, /^核对 /);
  mode = "absent";
  await f.monitor(true);
  assert.match(f.nodes.get("#center-status").textContent, /分页不完整/);
  assert.equal(f.nodes.get("#center-status").hidden, true);
  assert.equal(f.nodes.get("#center-progress-fill").style.width, "50%");
  assert.equal(
    f.nodes.get("#center-check-time").textContent,
    checked,
    "failed checks retain the last verified progress time",
  );
  assert.match(f.nodes.get("#center-status").textContent, /返回 0\/100 条，总数 2/);
  assert.equal(f.savedCache().completed.length, 0);
  const rows = JSON.parse(f.storage.get("hz-helper-events-v1"));
  assert.equal(rows.at(-1).level, "warning");
  mode = "short";
  const before = f.requests.length;
  f.advance(14999);
  await f.monitor();
  assert.equal(f.requests.length, before);
  f.advance(1);
  await f.monitor();
  assert.match(f.nodes.get("#center-status").textContent, /当前课程 50%/);
});

test("non-auth business refusals show their code and do not imply expired login", async () => {
  let refusing = false;
  const f = fixture(null, {
    controller: true,
    response: (url, body) =>
      refusing && url.endsWith("/Course/index") ? { status: 409 } : catalog(url, body),
  });
  f.nodes.get("#target").value = "1";
  await f.nodes.get("#plan").onclick();
  await f.nodes.get("#start").onclick();
  refusing = true;
  await f.monitor(true);
  assert.match(f.nodes.get("#center-status").textContent, /平台状态 409/);
  assert.doesNotMatch(f.nodes.get("#center-status").textContent, /登录已过期/);
  const rows = JSON.parse(f.storage.get("hz-helper-events-v1"));
  assert.ok(
    rows.some((row) => row.event === "查询失败" && row.platform === 409 && row.level === "error"),
  );
  assert.equal(f.savedCache().completed.length, 0);
});

test("starting reclaims the planning button and hides manual catalog lookup without losing automatic dispatch", async () => {
  const r = await running();
  assert.equal(r.f.nodes.get("#plan").inert, true);
  assert.equal(r.f.nodes.get("#plan").tabIndex, -1);
  assert.equal(r.f.nodes.get("#plan").getAttribute("aria-hidden"), "true");
  assert.equal(r.f.nodes.get("#read-next").hidden, true);
  r.f.nodes.get("#start").onclick();
  assert.equal(r.f.nodes.get("#plan").inert, false, "manual pause restores the planning button");
  assert.equal(r.f.nodes.get("#plan").tabIndex, 0);
  assert.equal(r.f.nodes.get("#plan").getAttribute("aria-hidden"), "false");
  await r.f.nodes.get("#start").onclick();
  assert.equal(r.f.nodes.get("#plan").inert, true, "resuming expands the learning button again");
});

test("refresh countdown follows the configured deadline and reports deferred or disabled refresh", async () => {
  let reloads = 0;
  const r = await running({ onReload: () => reloads++ });
  const f = r.f,
    timer = f.nodes.get("#refresh-countdown");
  f.nodes.get("#refresh-minutes").value = "15";
  f.autoRefresh();
  assert.equal(timer.textContent, "刷新 15:00");
  f.advance(61000);
  f.autoRefresh();
  assert.equal(timer.textContent, "刷新 13:59");
  f.nodes.get("#auto-refresh").checked = false;
  f.autoRefresh();
  assert.equal(timer.textContent, "刷新已关闭");
  f.nodes.get("#auto-refresh").checked = true;
  f.ui.activeElement = { tagName: "INPUT" };
  f.advance(900000);
  f.autoRefresh();
  assert.equal(timer.textContent, "等待刷新");
  assert.equal(reloads, 0);
  f.ui.activeElement = null;
  f.autoRefresh();
  assert.equal(timer.textContent, "正在刷新");
  assert.equal(reloads, 1);
  f.nodes.get("#start").onclick();
  f.autoRefresh();
  assert.equal(timer.textContent, "刷新已暂停");
});

test("start immediately animates to preparing and reserves a window before async course checks", async () => {
  let preparing = false,
    resolveDetail,
    notifyDetail;
  const detailStarted = new Promise((resolve) => (notifyDetail = resolve));
  const f = fixture(null, {
    controller: true,
    simulateListCompletion: false,
    response: (url, body) => {
      if (preparing && url.endsWith("/getCourseInfo")) {
        notifyDetail();
        return new Promise((resolve) => (resolveDetail = resolve));
      }
      const response = catalog(url, body);
      for (const row of response.course?.data || []) delete row.examtype_text;
      return response;
    },
  });
  f.nodes.get("#target").value = "1";
  await f.nodes.get("#plan").onclick();
  preparing = true;
  const pending = f.nodes.get("#start").onclick({ isTrusted: true });
  assert.equal(f.nodes.has("#stop"), false, "one button handles start, pause and resume");
  assert.equal(f.nodes.get("#start").getAttribute("aria-label"), "正在准备…");
  assert.equal(f.nodes.get("#plan").inert, true, "planning space collapses in the click stack");
  assert.equal(f.openCalls.at(-1).url, "about:blank", "window is reserved before awaited work");
  await detailStarted;
  assert.equal(f.nodes.get("#start").disabled, true);
  resolveDetail({ status: 200, data: { examtype: "W" } });
  await pending;
  assert.match(f.child.location.href, /#\/class\?/);
  assert.equal(f.nodes.get("#start").getAttribute("aria-label"), "暂停学习");
  assert.equal(f.nodes.get("#start").disabled, false);
  await f.nodes.get("#start").onclick({ isTrusted: true });
  assert.equal(f.nodes.get("#start").getAttribute("aria-label"), "继续学习");
  const child = f.child;
  await f.nodes.get("#start").onclick({ isTrusted: true });
  assert.equal(f.nodes.get("#start").getAttribute("aria-label"), "暂停学习");
  assert.equal(f.child, child, "resume uses the existing course window");
});

test("a blocked popup or rejected course check restores the control and cleans the preparation window", async () => {
  for (const blocked of [true, false]) {
    let failing = false;
    const f = fixture(null, {
      controller: true,
      blockPopups: blocked,
      response: (url, body) => {
        if (failing && url.endsWith("/getCourseInfo")) return { status: 409 };
        const response = catalog(url, body);
        for (const row of response.course?.data || []) delete row.examtype_text;
        return response;
      },
    });
    f.nodes.get("#target").value = "1";
    await f.nodes.get("#plan").onclick();
    failing = true;
    await f.nodes.get("#start").onclick({ isTrusted: true });
    assert.equal(f.nodes.get("#start").disabled, false);
    assert.notEqual(f.nodes.get("#start").getAttribute("aria-label"), "暂停学习");
    assert.equal(f.nodes.get("#plan").inert, false);
    assert.match(f.nodes.get("#state").textContent, blocked ? /允许本站弹窗/ : /平台状态 409/);
    if (!blocked) assert.equal(f.child.requestedClose, true);
  }
});

test("course progress stays visible before the first result without claiming zero percent", () => {
  const f = fixture(null, { controller: true, response: catalog });
  assert.equal(f.nodes.get("#center-progress").hidden, false);
  assert.equal(f.nodes.get("#center-progress-label").textContent, "课程进度");
  assert.equal(f.nodes.get("#center-progress-bar").getAttribute("aria-valuenow"), null);
  assert.equal(f.nodes.get("#center-check-time").textContent, "—");
  assert.equal(f.nodes.get("#check-course-progress").disabled, true);
});

test("manual progress checks bypass the interval and work while paused without resuming", async () => {
  const r = await running();
  const f = r.f,
    before = f.requests.length;
  r.progress(810);
  await f.nodes.get("#check-course-progress").onclick();
  assert.ok(f.requests.length > before, "manual click queries immediately");
  assert.equal(f.nodes.get("#center-progress-bar").getAttribute("aria-valuenow"), "90");
  await f.nodes.get("#start").onclick();
  const sent = f.sent.length;
  r.progress(840);
  await f.nodes.get("#check-course-progress").onclick();
  assert.equal(f.nodes.get("#center-progress-bar").getAttribute("aria-valuenow"), "93");
  assert.equal(f.nodes.get("#start").getAttribute("aria-label"), "继续学习");
  assert.equal(
    f.sent.slice(sent).some((m) => m.type === "resume"),
    false,
  );
  assert.equal(f.nodes.get("#check-course-progress").getAttribute("aria-busy"), "false");
});

test("heartbeat status stays in warning logs instead of cluttering the progress area", async () => {
  const r = await running(),
    f = r.f;
  f.advance(25000);
  await f.tick();
  assert.equal(f.nodes.get("#status-line").hidden, true);
  assert.equal(f.nodes.get("#center-progress").hidden, false);
  const rows = JSON.parse(f.storage.get("hz-helper-events-v1"));
  assert.ok(
    rows.some(
      (row) => row.detail === "播放页暂未响应，继续核对学习中心" && row.level === "warning",
    ),
  );
  await f.tick();
  assert.equal(
    JSON.parse(f.storage.get("hz-helper-events-v1")).length,
    rows.length,
    "unchanged consecutive statuses are not logged repeatedly",
  );
});

test("recovery ignores hundreds of stale task keys without creating blank lookup windows", async () => {
  const r = await running({
    onChildClose(page) {
      page.closed = true;
    },
  });
  for (let i = 0; i < 150; i++)
    r.f.storage.set(
      `hz-helper:stale-${i}`,
      JSON.stringify({ job: `old-${i}`, course: { id: `old-course-${i}` } }),
    );
  const before = r.f.openCalls.length;
  r.f.advance(21 * 60 * 1000);
  await r.f.stall();
  const opens = r.f.openCalls.slice(before);
  assert.equal(opens.filter((call) => call.url === "" || call.url === "about:blank").length, 0);
  assert.equal(opens.length, 1, "only the same real course is reopened");
  assert.match(opens[0].url, /courseId=a/);
});

test("recovery does not close its old course handle after the user navigates it to unrelated work", async () => {
  const r = await running({
    onChildClose(page) {
      page.closed = true;
    },
  });
  const work = r.f.child;
  work.location = {
    href: "https://example.com/work",
    origin: "https://example.com",
    hash: "",
  };
  r.f.advance(21 * 60 * 1000);
  await r.f.stall();
  assert.equal(work.closed, false);
  assert.notEqual(r.f.child, work);
  assert.equal(
    r.f.openCalls.some((call) => call.url === ""),
    false,
  );
});
