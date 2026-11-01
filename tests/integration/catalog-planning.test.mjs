import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../fixture.mjs";
import {
  catalogResponse,
  shortCourse,
  exactly45,
  historyResponse,
  groupedResponse,
  generalFallback,
} from "./catalogs.mjs";

await test("search continues beyond five pages until target, deduplicates and reuses the learning-center snapshot.", async () => {
  let f;

  // Search continues page by page until the selected target is covered.

  f = fixture(null, { controller: true, response: catalogResponse });
  f.nodes.get("#target").value = "4";
  await f.nodes.get("#plan").onclick();
  assert.deepEqual(
    f.requests.filter((r) => r.url.endsWith("/SelectCourse")).map((r) => r.body.page),
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal(f.nodes.get("#queued").textContent, 7);
  assert.equal(f.savedCache().nextPage, 7);
  assert.equal(
    f.requests.filter((r) => r.url.endsWith("/Course/index")).length,
    1,
    "search reuses the same learning-center snapshot",
  );
});

await test("small-credit ROI ranking, equal-ratio duration tie and duration cap.", async () => {
  let f = fixture();

  const longCourse = f.api.normalizeCourse({
    courseid: 2,
    coursename: "long",
    period: 1.5,
    coursetimes: 4500,
  });
  assert.equal(
    f.api.eligible(shortCourse, { unit: "hours", maxMinutes: 75 }),
    true,
    "0.5 credit is eligible",
  );
  assert.equal(f.api.minutesPerUnit(shortCourse), 40);
  assert.equal(f.api.rank([longCourse, shortCourse])[0].id, "1", "20m/0.5 beats 75m/1.5");
  const thirty = f.api.normalizeCourse({
    courseid: 3,
    coursename: "30m",
    period: 0.5,
    coursetimes: 1800,
  });
  assert.equal(
    f.api.eligible(thirty, { unit: "hours", maxMinutes: 75 }),
    false,
    "30m/0.5 exceeds the strict 45-minutes-per-credit limit",
  );
  const sameRatio = f.api.normalizeCourse({
    courseid: 4,
    coursename: "40m",
    period: 1,
    coursetimes: 2400,
  });
  assert.equal(
    f.api.rank([sameRatio, shortCourse])[0].id,
    "1",
    "equal ratio prefers shorter course",
  );
  const tooLong = f.api.normalizeCourse({
    courseid: 5,
    coursename: "76m",
    period: 2,
    coursetimes: 4560,
  });
  assert.equal(f.api.eligible(tooLong, { unit: "hours", maxMinutes: 75 }), false);
  assert.throws(() =>
    f.api.parsePage(
      { course: { data: [], current_page: 1, per_page: 30, total: 100 } },
      "course",
      1,
    ),
  );
});

await test("strict ROI <45, target-sized plan, manual learned/remove/restore, no manual credit inflation, durable reinstall/token-rotation records, safe active skip and late-message rejection, automatic cross-year history filtering and hidden legacy records.", async () => {
  let f = fixture();

  // Strict ROI filter and target-sized queue instead of the full 150-item candidate pool.

  assert.equal(
    f.api.eligible(exactly45, { unit: "hours", maxMinutes: 75 }),
    false,
    "45 exactly is excluded",
  );
  assert.equal(
    f.api.eligible({ ...exactly45, remaining: 2699 }, { unit: "hours", maxMinutes: 75 }),
    true,
  );
  f = fixture(null, { controller: true, response: catalogResponse });
  f.nodes.get("#target").value = "1";
  await f.nodes.get("#plan").onclick();
  for (let i = 0; i < 4; i++) await f.nodes.get("#read-next").onclick();
  assert.equal(
    f.nodes.get("#queued").textContent,
    2,
    "only two 0.5-credit courses are planned for a 1-credit goal",
  );
  assert.equal(f.savedCache().pending.length, 6, "the rest of the batch is retained as candidates");
  const learnedButton = f.courseButton("p1", "已学");
  assert.ok(learnedButton);
  learnedButton.onclick();
  assert.equal(f.savedRecords().p1.kind, "manual");
  assert.equal(
    f.nodes.get("#earned").textContent,
    0,
    "manual learned marker is not newly earned credit",
  );
  assert.equal(
    f.nodes.get("#queued").textContent,
    2,
    "removed course is replaced from the same batch",
  );
  assert.equal(f.courseButton("p1", "已学"), null);
  const removeButton = f.courseButton("p2", "移除");
  assert.ok(removeButton);
  removeButton.onclick();
  assert.equal(f.savedRecords().p2.kind, "excluded");
  const restore = f.courseButton("p2", "恢复", "#records");
  assert.ok(restore);
  restore.onclick();
  assert.equal(f.savedRecords().p2, undefined);

  // A fresh script instance uses durable account records even if the login token rotates.
  const durable = [...f.storage.entries()].filter(
    ([k]) =>
      k.startsWith("hz-helper-batches-v3:") ||
      k.startsWith("hz-helper-records-v1:") ||
      k === "use_info",
  );
  let reinstall = fixture(null, {
    controller: true,
    storage: durable,
    token: "rotated-fixture-token",
    response: catalogResponse,
  });
  reinstall.nodes.get("#target").value = "1";
  await reinstall.nodes.get("#plan").onclick();
  assert.equal(reinstall.savedRecords().p1.kind, "manual");
  assert.equal(reinstall.courseButton("p1", "已学"), null);
  assert.equal(
    reinstall.requests.filter((r) => r.url.endsWith("/SelectCourse")).length,
    0,
    "persisted candidate pool does not reread catalog pages on reinstall",
  );
  assert.equal(reinstall.savedCache().nextPage, 6);

  // Skipping an active course waits for its old window to close before continuing, without credit.
  f = fixture(null, { controller: true, response: catalogResponse });
  f.nodes.get("#target").value = "1";
  await f.nodes.get("#plan").onclick();
  await f.nodes.get("#start").onclick();
  let entry = [...f.storage.entries()].find(
    ([k]) => k.startsWith("hz-helper:") && k !== "hz-helper:R",
  );
  let task = JSON.parse(entry[1]);
  let runId = entry[0].slice("hz-helper:".length);
  const oldChild = f.child;
  f.courseButton(task.course.id, "已学").onclick();
  assert.ok(f.sent.some((m) => m.type === "skip" && m.job === task.job));
  f.deliver({
    type: "complete",
    run: runId,
    job: task.job,
    id: task.course.id,
    credits: task.course.hours,
  });
  assert.equal(
    f.nodes.get("#earned").textContent,
    0,
    "late completion after skip cannot inflate credit",
  );
  await f.tick();
  assert.equal(f.child, oldChild, "no parallel course before old window is closed");
  oldChild.closed = true;
  await f.tick();
  assert.notEqual(f.child, oldChild, "next course starts after close");
  assert.equal(f.nodes.get("#earned").textContent, 0);

  // Platform history is used for exclusion regardless of year and is not displayed.

  f = fixture(null, { controller: true, response: historyResponse });
  await f.nodes.get("#plan").onclick();
  await f.nodes.get("#sync-history").onclick();
  assert.equal(f.savedHistory().items.length, 2);
  assert.equal(f.savedHistory().synced, true);
  assert.equal(f.requests.filter((r) => r.url.endsWith("/myStudyList")).length, 5);
  assert.equal(f.courseButton("p1", "已学"), null, "this-year history automatically excluded");
  assert.equal(f.courseButton("p2", "已学"), null, "past-year history automatically excluded");
  assert.equal(f.nodes.get("#earned").textContent, 0, "synchronizing history adds no new credit");
  assert.doesNotMatch(
    f.nodes.get("#controls").innerHTML,
    /history-year|history-list|全部学年|手动标记课程ID/,
  );
  const exclude = f.courseButton("p3", "移除");
  assert.ok(exclude);
  exclude.onclick();
  assert.equal(f.savedRecords().p3.kind, "excluded");
  assert.ok(f.courseButton("p3", "恢复", "#records"));
  const recordsBefore = f.savedRecords();
  f.nodes.get("#reset").onclick();
  assert.deepEqual(
    f.savedRecords(),
    recordsBefore,
    "resetting page cursor preserves manual exclusions",
  );

  // Previously synced yearless entries remain local and are excluded without being displayed.
  let initialHistory = fixture(null, { controller: true, response: catalogResponse });
  await initialHistory.nodes.get("#plan").onclick();
  let oldEntries = [...initialHistory.storage.entries()];
  for (let [key, value] of oldEntries) {
    if (key.startsWith("hz-helper-records-v1:"))
      initialHistory.storage.set(
        key,
        JSON.stringify({ p1: { id: "p1", name: "Old course", kind: "platform", at: 1 } }),
      );
    if (key.startsWith("hz-helper-batches-v3:")) {
      const c = JSON.parse(value);
      delete c.yearAwareHistory;
      initialHistory.storage.set(key, JSON.stringify(c));
    }
  }
  let migrated = fixture(null, {
    controller: true,
    storage: [...initialHistory.storage],
    response: catalogResponse,
  });
  await migrated.nodes.get("#plan").onclick();
  assert.equal(migrated.savedRecords().p1.kind, "platform");
  assert.equal(migrated.courseButton("p1", "已学"), null);
  assert.equal(
    migrated.courseButton("p1", "恢复", "#records"),
    null,
    "platform history is not displayed as a manual exclusion",
  );
});

await test("completed platform progress excluded, synced history persists across reinstall and remains hidden.", async () => {
  let f = fixture();

  // Explicitly completed learning-center progress is excluded, regardless of academic year.
  const yearlessProgress = (url, body) =>
    url.endsWith("/Course/index")
      ? {
          status: 200,
          data: {
            data: [
              {
                courseid: "p1",
                coursename: "page 1",
                coursetimes: 1200,
                validstudytime: 1200,
                examtype_text: "无",
              },
            ],
            current_page: 1,
            per_page: 100,
            total: 1,
          },
        }
      : catalogResponse(url, body);
  f = fixture(null, { controller: true, response: yearlessProgress });
  f.nodes.get("#target").value = "1";
  await f.nodes.get("#plan").onclick();
  assert.equal(f.courseButton("p1", "已学"), null);
  assert.equal(f.savedRecords().p1.kind, "platform");

  // Synced history remains active after reinstall without showing the history list or refetching it.
  f = fixture(null, { controller: true, response: historyResponse });
  await f.nodes.get("#plan").onclick();
  await f.nodes.get("#sync-history").onclick();
  const remembered = [...f.storage.entries()].filter(
    ([k]) =>
      k.startsWith("hz-helper-batches-v3:") ||
      k.startsWith("hz-helper-records-v1:") ||
      k.startsWith("hz-helper-history-v1:") ||
      k === "use_info",
  );
  let revisited = fixture(null, {
    controller: true,
    storage: remembered,
    response: catalogResponse,
  });
  await revisited.nodes.get("#plan").onclick();
  assert.equal(revisited.requests.filter((r) => r.url.endsWith("/SelectCourse")).length, 0);
  assert.equal(revisited.courseButton("p1", "已学"), null);
  assert.equal(revisited.courseButton("p2", "已学"), null);
  assert.equal(revisited.nodes.has("#history-year"), false);
  assert.equal(revisited.nodes.has("#history-list"), false);
});

await test("partial sync keeps successful exclusions, reports incomplete sync, and safely retries.", async () => {
  let f = fixture();

  // Interrupted history synchronization keeps successful exclusions and can be retried.
  let failPastYear = true;
  const partialSync = (url, body) => {
    if (url.endsWith("/myStudyList") && body.schoolyearid === "2025" && failPastYear)
      throw new TypeError("offline");
    return historyResponse(url, body);
  };
  f = fixture(null, { controller: true, response: partialSync });
  await f.nodes.get("#plan").onclick();
  await f.nodes.get("#sync-history").onclick();
  assert.equal(f.savedHistory().synced, false);
  assert.equal(f.courseButton("p1", "已学"), null, "successful pages remain excluded");
  assert.ok(f.courseButton("p2", "已学"), "unread history is not invented");
  failPastYear = false;
  await f.nodes.get("#sync-history").onclick();
  assert.equal(f.savedHistory().synced, true);
  assert.equal(f.courseButton("p2", "已学"), null, "retry completes filtering");
});

await test("category goals, unrecognized category exclusion, annual local estimate persistence and explicit platform reset.", async () => {
  let f;

  // Annual planning uses official category labels and carries local estimates across sessions.

  f = fixture(null, { controller: true, response: groupedResponse });
  for (const [key, value] of Object.entries({
    "#target": "2",
    "#goal-total": "2",
    "#goal-professional": "1",
    "#goal-public": "1",
  }))
    f.nodes.get(key).value = value;
  f.nodes.get("#annual-limit").checked = true;
  await f.refreshAnnualOnly();
  await f.nodes.get("#plan").onclick();
  assert.equal(
    f.nodes.get("#queued").textContent,
    2,
    "search continues into the next needed category",
  );
  assert.ok(
    f.requests.filter((r) => r.url.endsWith("/SelectCourse")).some((r) => r.body.type === 9),
    "uses platform professional type ID",
  );
  await f.nodes.get("#start").onclick();
  let annualRun = [...f.storage.entries()].find(
    ([key]) => key.startsWith("hz-helper:") && key !== "hz-helper:R",
  );
  let annualCfg = JSON.parse(annualRun[1]);
  assert.equal(annualCfg.course.category, "专业课程");
  f.deliver({
    type: "complete",
    run: annualRun[0].slice("hz-helper:".length),
    job: annualCfg.job,
    id: annualCfg.course.id,
    credits: 1,
  });
  for (let j = 0; j < 40 && f.nodes.get("#estimate-total").textContent !== "1"; j++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.nodes.get("#estimate-professional").textContent, "1");
  const estimateEntry = [...f.storage.entries()].find(([key]) =>
    key.startsWith("hz-helper-annual-estimate-v1:"),
  );
  assert.equal(JSON.parse(estimateEntry[1]).base.professional, 1);
  const persisted = [...f.storage.entries()].filter(
    ([key]) => key.startsWith("hz-helper-") || key === "use_info",
  );
  const reloadedGroup = (url, body) =>
    url.endsWith("/myStudyList") && body.schoolyearid
      ? {
          status: 200,
          year: [{ schoolyearid: "2026", yeartitle: "2026学年" }],
          data: {
            data: [{ courseid: "p", period: 1, coursetype_text: "专业课程" }],
            total: 1,
            current_page: 1,
            per_page: 100,
          },
        }
      : groupedResponse(url, body);
  let reload = fixture(null, { controller: true, response: reloadedGroup, storage: persisted });
  for (const [key, value] of Object.entries({
    "#target": "2",
    "#goal-total": "2",
    "#goal-professional": "1",
    "#goal-public": "1",
  }))
    reload.nodes.get(key).value = value;
  reload.nodes.get("#annual-limit").checked = true;
  await reload.refreshAnnualOnly();
  await reload.nodes.get("#plan").onclick();
  assert.equal(
    reload.nodes.get("#estimate-professional").textContent,
    "1",
    "platform list is reloaded",
  );
  assert.equal(reload.nodes.get("#queued").textContent, 1, "only outstanding category remains");
  await reload.sumLearned();
  assert.equal(
    JSON.parse(reload.storage.get(estimateEntry[0])).base.total,
    1,
    "explicit reset adopts platform baseline",
  );
});

await test("new-hours target independent of annual requirements, professional-first ordering and explicit missing-category feedback.", async () => {
  // A small new-hours target stops independently of annual goals; category priority overrides ROI.
  let constrained = fixture(null, { controller: true, response: groupedResponse });
  for (const [key, value] of Object.entries({
    "#target": "1",
    "#unit": "hours",
    "#goal-total": "90",
    "#goal-professional": "60",
    "#goal-public": "18",
  }))
    constrained.nodes.get(key).value = value;
  constrained.nodes.get("#annual-limit").checked = true;
  await constrained.refreshAnnualOnly();
  await constrained.nodes.get("#plan").onclick();
  assert.equal(constrained.nodes.get("#queued").textContent, 1, "new target limits the plan");
  await constrained.nodes.get("#start").onclick();
  const selected = [...constrained.storage.entries()].find(
    ([key]) => key.startsWith("hz-helper:") && key !== "hz-helper:R",
  );
  assert.equal(
    JSON.parse(selected[1]).course.category,
    "专业课程",
    "professional selected even when public course has better ROI",
  );
  const onlyPublic = (url, body) => {
    const result = groupedResponse(url, body);
    if (url.endsWith("/SelectCourse") && body.type === 9) {
      result.course.data = [];
      result.course.total = 0;
    }
    return result;
  };
  constrained = fixture(null, { controller: true, response: onlyPublic });
  for (const [key, value] of Object.entries({
    "#target": "1",
    "#unit": "hours",
    "#goal-total": "90",
    "#goal-professional": "60",
    "#goal-public": "18",
  }))
    constrained.nodes.get(key).value = value;
  constrained.nodes.get("#annual-limit").checked = true;
  await constrained.refreshAnnualOnly();
  await constrained.nodes.get("#plan").onclick();
  assert.equal(
    constrained.nodes.get("#queued").textContent,
    1,
    "falls back to a needed public course when professional is unavailable",
  );
  assert.match(constrained.nodes.get("#state").textContent, /预计可满足新增目标/);
  assert.ok(
    constrained.requests.filter((r) => r.url.endsWith("/SelectCourse")).length <= 5,
    "fallback stays within five catalogue queries",
  );
  assert.match(constrained.nodes.get("#controls").innerHTML, /id="round-target"/);
  assert.doesNotMatch(constrained.nodes.get("#controls").innerHTML, /id="goal-mode"/);
});

await test("category IDs from platform metadata, multi-page filtered searches and response validation.", async () => {
  // Platform category IDs and per-category pagination, with a strict five-request batch limit.
  const categoryPages = (url, body) => {
    if (!url.endsWith("/SelectCourse")) return groupedResponse(url, body);
    const types = [
      { typeid: 9, coursetype: "专业课程" },
      { typeid: 15, coursetype: "行业公需" },
      { typeid: 7, coursetype: "一般公需" },
    ];
    const cat = types.find((x) => x.typeid === body.type)?.coursetype;
    return {
      status: 200,
      type: types,
      course: {
        data: body.type
          ? [
              {
                courseid: `${body.type}-${body.page}`,
                coursename: "长课",
                period: 1,
                coursetimes: 3000,
                coursetype: cat,
                examtype_text: "无",
              },
            ]
          : [],
        current_page: body.page,
        per_page: 30,
        total: 360,
      },
    };
  };
  let filteredFixture = fixture(null, { controller: true, response: categoryPages });
  for (const [key, value] of Object.entries({
    "#target": "1",
    "#unit": "hours",
    "#goal-total": "90",
    "#goal-professional": "60",
    "#goal-public": "18",
  }))
    filteredFixture.nodes.get(key).value = value;
  filteredFixture.nodes.get("#annual-limit").checked = true;
  await filteredFixture.refreshAnnualOnly();
  await filteredFixture.nodes.get("#plan").onclick();
  let filteredCalls = filteredFixture.requests.filter((r) => r.url.endsWith("/SelectCourse"));
  assert.equal(filteredCalls.length, 37, "search reaches the end of all needed categories");
  for (const id of [9, 15, 7])
    assert.deepEqual(
      filteredCalls.filter((x) => x.body.type === id).map((x) => x.body.page),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    );
  assert.equal(filteredFixture.nodes.get("#queued").textContent, 0);
  assert.equal(filteredFixture.savedCache().categoryScans["专业课程"].exhausted, true);
  const unfilteredServer = (url, body) => {
    const data = categoryPages(url, body);
    if (url.endsWith("/SelectCourse") && body.type) data.course.data[0].coursetype = "一般公需";
    return data;
  };
  const mismatch = fixture(null, { controller: true, response: unfilteredServer });
  for (const [key, value] of Object.entries({
    "#target": "1",
    "#unit": "hours",
    "#goal-total": "90",
    "#goal-professional": "60",
    "#goal-public": "18",
  }))
    mismatch.nodes.get(key).value = value;
  mismatch.nodes.get("#annual-limit").checked = true;
  await mismatch.refreshAnnualOnly();
  await mismatch.nodes.get("#plan").onclick();
  assert.match(
    mismatch.nodes.get("#state").textContent,
    /其他课程类别/,
    "wrong server category is not silently accepted",
  );

  assert.match(filteredFixture.nodes.get("#state").textContent, /已查完.*没有找到.*无法满足/);
});

await test("automatic fallback from professional through industry to general public.", async () => {
  // If professional and industry categories have no candidates, search general public within the same budget.

  let fallback = fixture(null, { controller: true, response: generalFallback });
  for (const [key, value] of Object.entries({
    "#target": "1",
    "#unit": "hours",
    "#goal-total": "90",
    "#goal-professional": "60",
    "#goal-public": "18",
  }))
    fallback.nodes.get(key).value = value;
  fallback.nodes.get("#annual-limit").checked = true;
  await fallback.refreshAnnualOnly();
  await fallback.nodes.get("#plan").onclick();
  assert.equal(
    fallback.nodes.get("#queued").textContent,
    1,
    "general public available when professional is absent",
  );
  assert.deepEqual(
    fallback.requests
      .filter((r) => r.url.endsWith("/SelectCourse"))
      .map((r) => r.body.type ?? "metadata"),
    ["metadata", 9, 15, 7],
  );
  assert.match(
    fallback.nodes.get("#state").textContent,
    /找到 1 门，预计新增 0.5 学时；距新增目标还差 0.5 学时/,
  );
  await fallback.nodes.get("#start").onclick();
  const fallbackTask = [...fallback.storage.entries()].find(
    ([key]) => key.startsWith("hz-helper:") && key !== "hz-helper:R",
  );
  assert.equal(JSON.parse(fallbackTask[1]).course.category, "一般公需");
});

await test("explicit category search bypasses unrelated cached candidates and produces a category-specific plan.", async () => {
  // Explicit category selection must issue the platform filter even when a public course is cached.
  const manualSearch = fixture(null, { controller: true, response: groupedResponse });
  manualSearch.nodes.get("#target").value = "1";
  await manualSearch.nodes.get("#plan").onclick();
  assert.ok(
    manualSearch.savedCache().pending.some((c) => c.category === "行业公需"),
    "public course is cached before the manual search",
  );
  manualSearch.nodes.get("#category").value = "专业课程";
  manualSearch.nodes.get("#category").onchange();
  const callsBefore = manualSearch.requests.filter((r) => r.url.endsWith("/SelectCourse")).length;
  await manualSearch.nodes.get("#read-next").onclick();
  const manualCalls = manualSearch.requests
    .filter((r) => r.url.endsWith("/SelectCourse"))
    .slice(callsBefore);
  assert.ok(
    manualCalls.some((r) => r.body.type === 9),
    "manual category reads platform professional filter despite cached alternatives",
  );
  assert.ok(manualCalls.length <= 5, "manual category reading remains within the batch limit");
  assert.equal(manualSearch.nodes.get("#queued").textContent, 1);
  assert.match(manualSearch.nodes.get("#state").textContent, /距新增目标还差|预计可满足新增目标/);
  await manualSearch.nodes.get("#start").onclick();
  const manualTask = [...manualSearch.storage.entries()].find(
    ([key]) => key.startsWith("hz-helper:") && key !== "hz-helper:R",
  );
  assert.equal(JSON.parse(manualTask[1]).course.category, "专业课程");
});

await test("annual total remainder reserved for general public, accounting for completed hours and category deficits.", async () => {
  // Reserve the remainder of the annual requirement for general public courses.
  const gapGoals = { annualTotal: 90, professional: 60, public: 18, target: 100, unit: "hours" };
  const gapApi = fixture(null, { controller: true, response: groupedResponse }).api;
  let deficits = gapApi.annualDeficits(gapGoals, { total: 0, professional: 0, public: 0 });
  assert.equal(deficits.professional, 60);
  assert.equal(deficits.public, 18);
  assert.equal(deficits.generalExtra, 12);
  deficits = gapApi.annualDeficits(gapGoals, { total: 83, professional: 60, public: 23 });
  assert.equal(
    deficits.generalExtra,
    7,
    "already completed extra public hours reduce the remaining total",
  );
  deficits = gapApi.annualDeficits(gapGoals, { total: 80, professional: 55, public: 25 });
  assert.equal(deficits.professional, 5);
  assert.equal(
    deficits.generalExtra,
    5,
    "professional deficit is reserved before general remainder",
  );
  deficits = gapApi.annualDeficits(
    { ...gapGoals, annualTotal: 70 },
    { total: 0, professional: 0, public: 0 },
  );
  assert.equal(deficits.generalExtra, 0, "do not create negative general remainder");
  const gapCourses = [
    { id: "industry", category: "行业公需", credits: 1, hours: 1 },
    { id: "general", category: "一般公需", credits: 1, hours: 1 },
  ];
  let chosen = gapApi.annualChoose(
    gapCourses,
    { ...gapGoals, target: 1 },
    { total: 18, professional: 0, public: 18 },
    0,
  );
  assert.equal(
    chosen[0].id,
    "general",
    "general remainder can be filled while professional candidates are unavailable",
  );
  chosen = gapApi.annualChoose(
    gapCourses,
    { ...gapGoals, target: 1 },
    { total: 78, professional: 60, public: 18 },
    0,
  );
  assert.equal(
    chosen[0].id,
    "general",
    "after category minima are satisfied, total remainder uses general public",
  );
  chosen = gapApi.annualChoose(
    [gapCourses[0]],
    { ...gapGoals, target: 1 },
    { total: 78, professional: 60, public: 18 },
    0,
  );
  assert.equal(chosen.length, 0, "extra total does not silently use another category");
});

await test("category query finds general public for the annual remainder before professional is complete.", async () => {
  const fillGapResponse = (url, body) => {
    if (url.endsWith("/myStudyList") && body.schoolyearid)
      return {
        status: 200,
        data: {
          data: [{ courseid: "industry", period: 18, coursetype_text: "行业公需" }],
          total: 1,
          current_page: 1,
          per_page: 100,
        },
      };
    if (url.endsWith("/Study.UserIndex/index"))
      return {
        status: 200,
        data: {
          study: [
            { typeid: 0, s: 18 },
            { typeid: 9, coursetype: "专业课程", s: 0 },
            { typeid: 15, coursetype: "行业公需", s: 18 },
            { typeid: 7, coursetype: "一般公需", s: 0 },
          ],
        },
      };
    return generalFallback(url, body);
  };
  const fillGap = fixture(null, { controller: true, response: fillGapResponse });
  for (const [key, value] of Object.entries({
    "#target": "1",
    "#unit": "hours",
    "#goal-total": "90",
    "#goal-professional": "60",
    "#goal-public": "18",
  }))
    fillGap.nodes.get(key).value = value;
  fillGap.nodes.get("#annual-limit").checked = true;
  await fillGap.refreshAnnualOnly();
  await fillGap.nodes.get("#plan").onclick();
  assert.equal(
    fillGap.nodes.get("#queued").textContent,
    1,
    "searches general public even after public minimum is reached",
  );
  assert.deepEqual(
    fillGap.requests
      .filter((r) => r.url.endsWith("/SelectCourse"))
      .map((r) => r.body.type ?? "metadata"),
    ["metadata", 9, 7],
  );
  assert.equal(fillGap.nodes.get("#goal-display-public").textContent, "18");
});

await test("configured per-unit time limit is applied strictly.", async () => {
  let f = fixture();

  assert.equal(
    f.api.eligible(exactly45, { unit: "hours", maxMinutes: 75, maxRatio: 46 }),
    true,
    "custom ratio allows 45 under a 46-minute limit",
  );
  assert.equal(
    f.api.eligible(exactly45, { unit: "hours", maxMinutes: 75, maxRatio: 45 }),
    false,
    "ratio threshold is strict",
  );
  assert.equal(
    f.api.eligible(
      { ...exactly45, remaining: 1800 },
      { unit: "hours", maxMinutes: 75, maxRatio: 30 },
    ),
    false,
    "custom threshold excludes equality",
  );
});

await test("absolute targets require total and both category minima and use best efficiency for the remainder.", async () => {
  const absoluteCatalog = (url, body) => {
    if (url.endsWith("/myStudyList"))
      return !body.schoolyearid
        ? { status: 200, year: [{ schoolyearid: "2026", yeartitle: "2026学年" }] }
        : {
            status: 200,
            data: {
              data: [{ courseid: "old", period: 2, coursetype_text: "一般公需" }],
              total: 1,
              current_page: 1,
              per_page: 100,
            },
          };
    if (!url.endsWith("/SelectCourse")) return groupedResponse(url, body);
    const type = [
      { typeid: 9, coursetype: "专业课程" },
      { typeid: 15, coursetype: "行业公需" },
      { typeid: 7, coursetype: "一般公需" },
    ];
    const rows = [
      {
        courseid: "p1",
        coursename: "专业一",
        period: 1,
        coursetimes: 1800,
        coursetype: "专业课程",
        examtype_text: "无",
      },
      {
        courseid: "p2",
        coursename: "专业二",
        period: 1,
        coursetimes: 1800,
        coursetype: "专业课程",
        examtype_text: "无",
      },
      {
        courseid: "i1",
        coursename: "高效率行业",
        period: 1,
        coursetimes: 600,
        coursetype: "行业公需",
        examtype_text: "无",
      },
      {
        courseid: "g1",
        coursename: "低效率一般",
        period: 1,
        coursetimes: 2400,
        coursetype: "一般公需",
        examtype_text: "无",
      },
    ];
    const selected = body.type
      ? rows.filter((r) =>
          type.some((t) => t.typeid === body.type && t.coursetype === r.coursetype),
        )
      : rows;
    return {
      status: 200,
      type,
      course: { data: selected, current_page: body.page, per_page: 30, total: selected.length },
    };
  };
  const absoluteTest = fixture(null, {
    controller: true,
    response: absoluteCatalog,
    simulateListCompletion: false,
  });
  for (const [k, v] of Object.entries({
    "#target": "5",
    "#targetMode": "absolute",
    "#unit": "hours",
    "#goal-total": "90",
    "#goal-professional": "2",
    "#goal-public": "2",
    "#category": "auto",
  }))
    absoluteTest.nodes.get(k).value = v;
  await absoluteTest.nodes.get("#plan").onclick();
  assert.equal(
    absoluteTest.nodes.get("#queued").textContent,
    3,
    "plan fills total and both category minima",
  );
  assert.ok(absoluteTest.courseButton("p1", "已学"));
  assert.ok(absoluteTest.courseButton("p2", "已学"));
  assert.ok(
    absoluteTest.courseButton("i1", "已学"),
    "after minima, the most efficient category fills the total",
  );
  assert.equal(absoluteTest.courseButton("g1", "已学"), null);
  const sufficientTotal = fixture(null, {
    controller: true,
    response: absoluteCatalog,
    simulateListCompletion: false,
  });
  for (const [k, v] of Object.entries({
    "#target": "2",
    "#targetMode": "absolute",
    "#unit": "hours",
    "#goal-total": "90",
    "#goal-professional": "2",
    "#goal-public": "2",
    "#category": "auto",
  }))
    sufficientTotal.nodes.get(k).value = v;
  await sufficientTotal.nodes.get("#plan").onclick();
  assert.equal(
    sufficientTotal.nodes.get("#queued").textContent,
    2,
    "total alone cannot satisfy unmet professional minimum",
  );
  const alreadyDone = fixture(null, {
    controller: true,
    response: absoluteCatalog,
    simulateListCompletion: false,
  });
  for (const [k, v] of Object.entries({
    "#target": "2",
    "#targetMode": "absolute",
    "#unit": "hours",
    "#goal-total": "90",
    "#goal-professional": "0",
    "#goal-public": "2",
    "#category": "auto",
  }))
    alreadyDone.nodes.get(k).value = v;
  await alreadyDone.nodes.get("#plan").onclick();
  assert.match(alreadyDone.nodes.get("#state").textContent, /已达到目标/);
  assert.equal(alreadyDone.nodes.get("#queued").textContent, 0);
});
