import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createControllerState,
  pausePlan,
  pauseFromWorker,
  resumeFromWorker,
  finishRound,
  canSchedule,
} from "../src/controller-state.js";
import { createControllerMessageHandler } from "../src/controller-messages.js";
import { createAnnualQueries } from "../src/annual-query.js";
import { readConfirmedHours, readLearnedHours } from "../src/annual-data.js";
import { readPlanSettings, validatePlanSettings, samePlanSettings } from "../src/settings.js";
import { SETTINGS, settingDefault, validRefreshMinutes } from "../src/settings-schema.js";

test("controller transitions preserve manual intent and scheduling waits on each operation gate", () => {
  const state = createControllerState();
  state.active = true;
  resumeFromWorker(state);
  assert.equal(canSchedule(state), true);
  for (const flag of ["paused", "busy", "catalogBusy", "completing", "recovering"]) {
    state[flag] = true;
    assert.equal(canSchedule(state), false, flag);
    state[flag] = false;
  }
  state.searching = true;
  pausePlan(state);
  assert.equal(state.cancelSearch, true);
  pauseFromWorker(state, false);
  assert.equal(state.manualPaused, true);
  assert.equal(state.heartbeatPaused, false);
  resumeFromWorker(state);
  pausePlan(state, true);
  assert.equal(state.manualPaused, false);
  assert.equal(state.heartbeatPaused, true);
  finishRound(state);
  assert.equal(state.active, false);
  assert.equal(state.roundDone, true);
});

test("controller messages validate the task and only explicit manual resume releases manual pause", () => {
  const state = createControllerState();
  state.current = { job: "job", course: { id: "7" } };
  let rendered = 0;
  const handle = createControllerMessageHandler({
    state,
    store: {},
    session: "run",
    render: () => rendered++,
    status: () => {},
  });
  const send = (type, more = {}) =>
    handle({ data: { type, run: "run", job: "job", id: "7", ...more } });
  send("paused", { run: "other", manual: true });
  send("paused", { job: "other", manual: true });
  send("paused", { id: "other", manual: true });
  assert.equal(rendered, 0);
  send("paused", { manual: true, reason: "已手动暂停" });
  assert.equal(state.manualPaused, true);
  send("resumed");
  assert.equal(state.paused, true);
  send("resumed", { manual: true });
  assert.equal(state.paused, false);
  assert.equal(state.manualPaused, false);
});

test("refresh metadata is reused only within its account-scoped refresh context", async () => {
  let account = "a",
    calls = 0,
    rejectNext = false;
  const queries = createAnnualQueries({
    accountScope: async () => account,
    readAPI: async () => {
      calls++;
      if (rejectNext) {
        rejectNext = false;
        throw new Error("network");
      }
      return { year: [{ schoolyearid: account, yeartitle: "2026" }] };
    },
  });
  const context = {};
  const [a, b] = await Promise.all([
    queries.readMetadata("a", 3, context),
    queries.readMetadata("a", 3, context),
  ]);
  assert.equal(a, b);
  assert.equal(calls, 1);
  await queries.readMetadata("a", 3, {});
  assert.equal(calls, 2);
  account = "b";
  const changed = await queries.readMetadata("b", 3, context);
  assert.equal(changed.year[0].schoolyearid, "b");
  rejectNext = true;
  const retry = {};
  await assert.rejects(queries.readMetadata("b", 3, retry), /network/);
  await queries.readMetadata("b", 3, retry);
  await assert.rejects(queries.readMetadata("a"), /账户已变化/);
});

test("official totals and learned-list totals stay separate, and malformed learned pages fail", async () => {
  const official = readConfirmedHours({
    data: {
      study: [
        { typeid: 0, s: 15 },
        { typeid: 1, coursetype: "专业课程", s: 10 },
        { typeid: 2, coursetype: "行业公需", s: 2 },
        { typeid: 3, coursetype: "一般公需", s: 3 },
      ],
    },
  });
  assert.equal(official.total, 15);
  assert.equal(official.snapshot.public, 5);
  const options = {
    accountScope: async () => "a",
    scope: "a",
    year: { schoolyearid: "2026", yeartitle: "2026" },
    requestRetries: 0,
  };
  const page = {
    data: [{ courseid: "1", period: 2.5, coursetype_text: "专业课程" }],
    total: 1,
    per_page: 100,
    current_page: 1,
  };
  const learned = await readLearnedHours({ ...options, readAPI: async () => ({ data: page }) });
  assert.equal(learned.total, 2.5);
  assert.equal(official.total, 15);
  await assert.rejects(
    readLearnedHours({ ...options, readAPI: async () => ({ data: { ...page, total: 2 } }) }),
    /缺少数据/,
  );
  await assert.rejects(
    readLearnedHours({
      ...options,
      accountScope: async () => "b",
      readAPI: async () => ({ data: page }),
    }),
    /账户已变化/,
  );
});

test("settings use schema defaults and retain validation boundaries and plan comparison", () => {
  const nodes = new Map(
    Object.entries(SETTINGS).map(([id, field]) => [
      "#" + id,
      { value: String(field.defaultValue), checked: field.defaultValue === true },
    ]),
  );
  const settings = readPlanSettings((id) => nodes.get(id));
  assert.equal(settings.target, Number(settingDefault("target")));
  assert.equal(settings.maxRatio, Number(settingDefault("maxRatio")));
  assert.equal(settings.targetMode, "absolute");
  const annual = { annualYear: "2026", learnedSnapshot: { total: 0 } };
  validatePlanSettings(settings, annual);
  assert.throws(() => validatePlanSettings({ ...settings, target: 0 }, annual), /学习目标/);
  assert.throws(() => validatePlanSettings({ ...settings, maxRatio: 601 }, annual), /每学时/);
  assert.throws(() => validatePlanSettings({ ...settings, category: "unknown" }, annual), /类别/);
  assert.throws(() => validatePlanSettings(settings, {}), /刷新平台学时/);
  assert.equal(samePlanSettings({ ...settings, autoContinue: false }, settings), true);
  assert.equal(samePlanSettings({ ...settings, target: 20 }, settings), false);
  for (const value of [5, 15, 240]) assert.equal(validRefreshMinutes(value), true);
  for (const value of [NaN, 4, 241]) assert.equal(validRefreshMinutes(value), false);
});
