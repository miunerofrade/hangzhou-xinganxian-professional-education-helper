import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../fixture.mjs";
import { catalogResponse, listedResponse } from "./catalogs.mjs";

await test("platform annual total and default-year labels, independent credits, missing/zero handling, lazy refresh, direct sync action and recoverable manual exclusions.", async () => {
  let f = fixture();

  // Annual total comes from the management dashboard's total row; year is explicitly the platform default.
  const annualResponse = (url, body) => {
    if (url.endsWith("/Study.UserIndex/index"))
      return {
        status: 200,
        data: {
          study: [
            { typeid: "1", s: "4.25", r: "60" },
            { typeid: 0, s: "12.50", r: "90" },
          ],
        },
      };
    if (url.endsWith("/myStudyList"))
      return {
        status: 200,
        year: [
          { schoolyearid: "2026", yeartitle: "2026学年" },
          { schoolyearid: "2025", yeartitle: "2025学年" },
        ],
      };
    return catalogResponse(url, body);
  };
  f = fixture(null, { controller: true, response: annualResponse });
  await f.refreshAnnualOnly();
  assert.equal(f.nodes.get("#annual-total").textContent, "12.5");
  assert.equal(f.nodes.get("#annual-year").textContent, "平台默认学年：2026学年");
  assert.equal(
    f.nodes.get("#earned").textContent,
    0,
    "annual total does not change session credits",
  );
  assert.equal(f.requests.filter((r) => r.url.endsWith("/Study.UserIndex/index")).length, 1);
  assert.equal(f.requests.filter((r) => r.url.endsWith("/myStudyList")).length, 1);
  assert.equal(f.nodes.get("#status-line").hidden, true, "idle status does not occupy a card");
  assert.match(f.ui.innerHTML, /学时预计/);
  assert.match(f.ui.innerHTML, /id="estimate-total"/);
  assert.doesNotMatch(f.ui.innerHTML, /status-card/);
  assert.doesNotMatch(f.nodes.get("#controls").innerHTML, /课程过滤/);
  assert.match(
    f.nodes.get("#controls").innerHTML.replace(/>\s+</g, "><"),
    /<details><summary>设置<\/summary>[\s\S]*id="sync-history"[\s\S]*<\/details><details id="history-details" hidden><summary>排除<\/summary>/,
    "sync is in settings and exclusions are renamed",
  );
  assert.match(f.nodes.get("#controls").innerHTML, /id="history-details" hidden/);

  // A genuine zero remains zero; missing or ambiguous values do not become zero.
  const zeroAnnual = (url, body) =>
    url.endsWith("/Study.UserIndex/index")
      ? { status: 200, data: { study: [{ typeid: 0, s: 0 }] } }
      : annualResponse(url, body);
  f = fixture(null, { controller: true, response: zeroAnnual });
  await f.refreshAnnualOnly();
  assert.equal(f.nodes.get("#annual-total").textContent, "0");
  const missingAnnual = (url, body) =>
    url.endsWith("/Study.UserIndex/index")
      ? { status: 200, data: { study: [{ typeid: 0, s: null }] } }
      : annualResponse(url, body);
  f = fixture(null, { controller: true, response: missingAnnual });
  await f.refreshAnnualOnly();
  assert.equal(f.nodes.get("#annual-total").textContent, "—");
  assert.equal(f.nodes.get("#status-line").hidden, true);
  assert.match(f.nodes.get("#state").textContent, /无法读取年度学时/);
  const noYear = (url, body) =>
    url.endsWith("/myStudyList") ? { status: 200, year: [] } : annualResponse(url, body);
  f = fixture(null, { controller: true, response: noYear });
  await f.refreshAnnualOnly();
  assert.equal(f.nodes.get("#annual-total").textContent, "12.5");
  assert.equal(f.nodes.get("#annual-year").textContent, "平台默认学年：未能读取");

  // The first menu opening starts the read and manual exclusions remain recoverable.
  f = fixture(null, { controller: true, response: annualResponse });
  f.nodes.get("#launcher").onclick();
  for (let i = 0; i < 25 && f.nodes.get("#annual-total").textContent !== "12.5"; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.nodes.get("#annual-total").textContent, "12.5");
  assert.equal(f.nodes.get("#history-details").hidden, true);
  await f.nodes.get("#plan").onclick();
  const manual = f.courseButton("p1", "移除");
  assert.ok(manual);
  manual.onclick();
  assert.equal(f.nodes.get("#history-details").hidden, false);
  assert.ok(f.courseButton("p1", "恢复", "#records"));
});

await test("default-year learned-list totals and categories, pagination, deduplication, incomplete data and automatic baseline adoption.", async () => {
  // Sum the platform's default-year list, not its (possibly delayed) annual dashboard.

  let listed = fixture(null, { controller: true, response: listedResponse });
  await listed.refreshAnnualOnly();
  await listed.sumLearned();
  assert.equal(
    listed.nodes.get("#annual-total").textContent,
    "0",
    "official total remains separate",
  );
  assert.equal(listed.nodes.get("#learned-summary").textContent, "");
  assert.equal(listed.nodes.get("#estimate-total").textContent, "2");
  assert.equal(listed.nodes.get("#estimate-public").textContent, "2");
  assert.equal(
    listed.requests.filter((r) => r.url.endsWith("/myStudyList") && r.body.schoolyearid === "2026")
      .length,
    2,
  );
  let listEstimate = JSON.parse(
    [...listed.storage.entries()].find(([key]) =>
      key.startsWith("hz-helper-annual-estimate-v1:"),
    )[1],
  );
  assert.equal(listEstimate.base.total, 2);
  assert.equal(listEstimate.base.public, 2);
  assert.equal(listEstimate.source, "已学列表");
  const duplicateResponse = (url, body) => {
    if (!url.endsWith("/myStudyList") || !body.schoolyearid) return listedResponse(url, body);
    const rows =
      body.page === 1
        ? [
            { courseid: "a", period: ".5", coursetype_text: "一般公需" },
            { courseid: "b", period: "1", coursetype_text: "专业课程" },
          ]
        : [{ courseid: "a", period: ".5", coursetype_text: "一般公需" }];
    return { status: 200, data: { data: rows, total: 3, current_page: body.page, per_page: 2 } };
  };
  listed = fixture(null, { controller: true, response: duplicateResponse });
  await listed.sumLearned();
  assert.equal(
    listed.nodes.get("#estimate-total").textContent,
    "1.5",
    "duplicate course IDs are counted once",
  );
  assert.equal(listed.nodes.get("#learned-summary").textContent, "");
  const malformedResponse = (url, body) => {
    if (!url.endsWith("/myStudyList") || !body.schoolyearid) return listedResponse(url, body);
    return {
      status: 200,
      data: {
        data: [{ courseid: "a", period: null, coursetype_text: "一般公需" }],
        total: 1,
        current_page: 1,
        per_page: 100,
      },
    };
  };
  listed = fixture(null, { controller: true, response: malformedResponse });
  await listed.sumLearned();
  assert.match(
    listed.nodes.get("#learned-summary").textContent,
    /统计失败/,
    "missing hours are not treated as zero",
  );
});

await test("list refresh excludes local additions and rejects incomplete final pages.", async () => {
  // Refreshing the list uses platform values only and preserves older local data separately.
  const reconcile = fixture(null, { controller: true, response: listedResponse });
  await reconcile.refreshAnnualOnly();
  await reconcile.sumLearned();
  const estimateKey = [...reconcile.storage.keys()].find((key) =>
    key.startsWith("hz-helper-annual-estimate-v1:"),
  );
  const prior = JSON.parse(reconcile.storage.get(estimateKey));
  prior.entries = [
    { id: "a", hours: 0.5, category: "一般公需" },
    { id: "x", hours: 1, category: "专业课程" },
  ];
  prior.total = 1.5;
  prior.earned = { professional: 1, public: 0.5 };
  prior.included = [];
  reconcile.storage.set(estimateKey, JSON.stringify(prior));
  await reconcile.sumLearned();
  let reconciled = JSON.parse(reconcile.storage.get(estimateKey));
  assert.equal(reconciled.base.total, 2);
  assert.equal(reconciled.total, undefined, "local increments are excluded");
  assert.equal(reconciled.entries, undefined);
  assert.equal(reconcile.nodes.get("#estimate-total").textContent, "2");
  assert.equal(reconcile.nodes.get("#estimate-professional").textContent, "0");
  assert.ok(
    [...reconcile.storage.keys()].some((key) => key.startsWith("hz-helper-legacy-estimate-v1:")),
    "prior local estimate is retained as a backup",
  );
  assert.equal(reconcile.nodes.get("#estimate-public").textContent, "2");
  await reconcile.sumLearned();
  reconciled = JSON.parse(reconcile.storage.get(estimateKey));
  assert.equal(reconciled.total, undefined, "repeated refresh keeps platform data only");
  const incompleteLast = (url, body) => {
    if (url.endsWith("/myStudyList") && body.schoolyearid && body.page === 2)
      return { status: 200, data: { data: [], total: 3, current_page: 2, per_page: 2 } };
    return listedResponse(url, body);
  };
  const truncated = fixture(null, { controller: true, response: incompleteLast });
  await truncated.sumLearned();
  assert.match(truncated.nodes.get("#learned-summary").textContent, /分页缺少数据/);
  assert.equal(
    [...truncated.storage.keys()].some((key) => key.startsWith("hz-helper-annual-estimate-v1:")),
    false,
    "partial result is never saved",
  );
});

await test("courses already in the platform list are not added locally; prior local amounts are backed up.", async () => {
  // Completing a course already present in the just-summed list must not count it twice.
  const includedCourseResponse = (url, body) => {
    if (url.endsWith("/SelectCourse"))
      return {
        status: 200,
        course: {
          data: [
            {
              courseid: "a",
              coursename: "已在列表中的课程",
              period: 0.5,
              coursetimes: 900,
              coursetype: "一般公需",
              examtype_text: "无",
            },
          ],
          current_page: body.page,
          per_page: 30,
          total: 1,
        },
      };
    return listedResponse(url, body);
  };
  const includedCourse = fixture(null, { controller: true, response: includedCourseResponse });
  includedCourse.nodes.get("#target").value = "1";
  await includedCourse.refreshAnnualOnly();
  await includedCourse.sumLearned();
  await includedCourse.nodes.get("#plan").onclick();
  await includedCourse.nodes.get("#start").onclick();
  const includedTask = [...includedCourse.storage.entries()].find(
    ([key]) => key.startsWith("hz-helper:") && key !== "hz-helper:R",
  );
  const includedConfig = JSON.parse(includedTask[1]);
  includedCourse.deliver({
    type: "complete",
    run: includedTask[0].slice("hz-helper:".length),
    job: includedConfig.job,
    id: "a",
    credits: 0.5,
  });
  const includedSaved = JSON.parse(
    [...includedCourse.storage.entries()].find(([key]) =>
      key.startsWith("hz-helper-annual-estimate-v1:"),
    )[1],
  );
  assert.equal(includedSaved.base.total, 2);
  assert.equal(includedSaved.total, undefined, "course already present in list is not added again");
  assert.equal(includedCourse.nodes.get("#estimate-total").textContent, "2");
  const legacy = fixture(null, { controller: true, response: listedResponse });
  await legacy.refreshAnnualOnly();
  await legacy.sumLearned();
  const legacyKey = [...legacy.storage.keys()].find((key) =>
    key.startsWith("hz-helper-annual-estimate-v1:"),
  );
  const legacyData = JSON.parse(legacy.storage.get(legacyKey));
  legacyData.total = 1;
  delete legacyData.entries;
  legacy.storage.set(legacyKey, JSON.stringify(legacyData));
  await legacy.sumLearned();
  assert.equal(
    JSON.parse(legacy.storage.get(legacyKey)).total,
    undefined,
    "local value is not included in platform totals",
  );
  assert.ok(
    [...legacy.storage.keys()].some((key) => key.startsWith("hz-helper-legacy-estimate-v1:")),
    "prior local value is retained as a backup",
  );
});

await test("completion refresh runs in the background, platform list drives round progress, and stale data is not guessed.", async () => {
  // Course scheduling continues while a platform refresh is pending.
  let courseFinished = false,
    releasePlatform;
  const platformGate = new Promise((resolve) => {
    releasePlatform = resolve;
  });
  const gatedResponse = async (url, body) => {
    if (url.endsWith("/myStudyList")) {
      if (!body.schoolyearid)
        return { status: 200, year: [{ schoolyearid: "2026", yeartitle: "2026学年" }] };
      if (courseFinished) await platformGate;
      const rows = courseFinished
        ? [{ courseid: "p1", period: 0.5, coursetype_text: "一般公需" }]
        : [];
      return {
        status: 200,
        data: { data: rows, current_page: 1, per_page: 100, total: rows.length },
      };
    }
    return catalogResponse(url, body);
  };
  const gated = fixture(null, {
    controller: true,
    response: gatedResponse,
    simulateListCompletion: false,
  });
  gated.nodes.get("#target").value = "1";
  await gated.nodes.get("#plan").onclick();
  await gated.nodes.get("#start").onclick();
  const gateEntry = [...gated.storage.entries()].find(
    ([key]) => key.startsWith("hz-helper:") && key !== "hz-helper:R",
  );
  const gateConfig = JSON.parse(gateEntry[1]),
    firstChild = gated.child;
  courseFinished = true;
  gated.deliver({
    type: "complete",
    run: gateEntry[0].slice("hz-helper:".length),
    job: gateConfig.job,
    id: gateConfig.course.id,
    credits: 0.5,
  });
  firstChild.closed = true;
  const gatedTick = gated.tick();
  for (
    let i = 0;
    i < 10 && gated.requests.filter((r) => r.url.endsWith("/myStudyList")).length < 4;
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  await gatedTick;
  assert.notEqual(gated.child, firstChild, "opens the next course while list refresh is pending");
  assert.equal(
    gated.nodes.get("#earned").textContent,
    0,
    "no local credit is added before platform response",
  );
  releasePlatform();
  for (let i = 0; i < 30 && Number(gated.nodes.get("#earned").textContent) !== 0.5; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(
    gated.nodes.get("#earned").textContent,
    0.5,
    "round progress is the difference between platform list totals",
  );
  assert.notEqual(gated.child, firstChild, "course remains open after refresh");
  const staleResponse = (url, body) =>
    url.endsWith("/myStudyList")
      ? !body.schoolyearid
        ? { status: 200, year: [{ schoolyearid: "2026", yeartitle: "2026学年" }] }
        : { status: 200, data: { data: [], current_page: 1, per_page: 100, total: 0 } }
      : catalogResponse(url, body);
  const staleCase = fixture(null, {
    controller: true,
    response: staleResponse,
    simulateListCompletion: false,
  });
  staleCase.nodes.get("#target").value = "1";
  await staleCase.nodes.get("#plan").onclick();
  await staleCase.nodes.get("#start").onclick();
  const staleEntry = [...staleCase.storage.entries()].find(
    ([key]) => key.startsWith("hz-helper:") && key !== "hz-helper:R",
  );
  const staleConfig = JSON.parse(staleEntry[1]),
    staleChild = staleCase.child;
  staleCase.deliver({
    type: "complete",
    run: staleEntry[0].slice("hz-helper:".length),
    job: staleConfig.job,
    id: staleConfig.course.id,
    credits: 0.5,
  });
  staleChild.closed = true;
  await staleCase.tick();
  assert.notEqual(
    staleCase.child,
    staleChild,
    "a stale platform list does not block the next course",
  );
  assert.equal(
    staleCase.nodes.get("#earned").textContent,
    0,
    "stale platform list does not cause a guessed increment",
  );
  assert.equal(staleCase.nodes.get("#earned").textContent, 0);
});

await test("background refresh retries three times and never blocks the next course.", async () => {
  let failRefresh = false,
    failedAttempts = 0;
  const retryResponse = (url, body) => {
    if (url.endsWith("/myStudyList") && failRefresh) {
      failedAttempts++;
      return { status: 500 };
    }
    return url.endsWith("/myStudyList")
      ? !body.schoolyearid
        ? { status: 200, year: [{ schoolyearid: "2026", yeartitle: "2026学年" }] }
        : { status: 200, data: { data: [], current_page: 1, per_page: 100, total: 0 } }
      : catalogResponse(url, body);
  };
  const retryCase = fixture(null, {
    controller: true,
    response: retryResponse,
    simulateListCompletion: false,
  });
  retryCase.nodes.get("#target").value = "1";
  await retryCase.nodes.get("#plan").onclick();
  await retryCase.nodes.get("#start").onclick();
  const retryEntry = [...retryCase.storage.entries()].find(
    ([key]) => key.startsWith("hz-helper:") && key !== "hz-helper:R",
  );
  const retryConfig = JSON.parse(retryEntry[1]);
  failRefresh = true;
  retryCase.deliver({
    type: "complete",
    run: retryEntry[0].slice("hz-helper:".length),
    job: retryConfig.job,
    id: retryConfig.course.id,
    credits: 0.5,
  });
  const retryChild = retryCase.child;
  retryChild.closed = true;
  await retryCase.tick();
  for (let i = 0; i < 50 && failedAttempts < 4; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(failedAttempts, 4, "one initial query plus three retries");
  assert.notEqual(retryCase.child, retryChild, "failed background query does not stop scheduling");
});

await test("annual goal counters and combined public category update from platform records and saved settings.", async () => {
  const categoryTotalResponse = (url, body) => {
    if (url.endsWith("/myStudyList"))
      return !body.schoolyearid
        ? { status: 200, year: [{ schoolyearid: "2026", yeartitle: "2026学年" }] }
        : {
            status: 200,
            data: {
              data: [
                { courseid: "p", period: 2, coursetype_text: "专业课程" },
                { courseid: "i", period: 1, coursetype_text: "行业公需" },
                { courseid: "g", period: 1.5, coursetype_text: "一般公需" },
              ],
              total: 3,
              current_page: 1,
              per_page: 100,
            },
          };
    return catalogResponse(url, body);
  };
  const progressFixture = fixture(null, { controller: true, response: categoryTotalResponse });
  await progressFixture.sumLearned();
  assert.equal(progressFixture.nodes.get("#estimate-total").textContent, "4.5");
  assert.equal(progressFixture.nodes.get("#estimate-professional").textContent, "2");
  assert.equal(progressFixture.nodes.get("#estimate-public").textContent, "2.5");
  assert.equal(progressFixture.nodes.get("#goal-display-professional").textContent, "60");
  progressFixture.nodes.get("#goal-total").value = "90";
  progressFixture.nodes.get("#goal-professional").value = "45";
  progressFixture.nodes.get("#goal-public").value = "20";
  progressFixture.nodes.get("#goal-professional").onchange();
  assert.equal(progressFixture.nodes.get("#goal-display-professional").textContent, "45");
  assert.equal(progressFixture.nodes.get("#goal-display-public").textContent, "20");
  await progressFixture.sumLearned();
  assert.equal(progressFixture.nodes.get("#goal-display-professional").textContent, "45");
});

await test("single refresh updates official and paginated learned-list totals.", async () => {
  const singleRefresh = fixture(null, { controller: true, response: listedResponse });
  assert.doesNotMatch(singleRefresh.ui.innerHTML, /id="sum-learned"/);
  assert.doesNotMatch(singleRefresh.nodes.get("#controls").innerHTML, /id="reset-estimate"/);
  await singleRefresh.nodes.get("#refresh-annual").onclick();
  assert.equal(singleRefresh.nodes.get("#annual-total").textContent, "0");
  assert.equal(singleRefresh.nodes.get("#estimate-total").textContent, "2");
  assert.equal(singleRefresh.nodes.get("#estimate-public").textContent, "2");
  assert.equal(singleRefresh.nodes.get("#refresh-annual").disabled, false);
  assert.equal(
    singleRefresh.requests.filter((r) => r.url.endsWith("/myStudyList") && !r.body.schoolyearid)
      .length,
    1,
    "one refresh shares its account-scoped year metadata",
  );
  assert.equal(
    singleRefresh.requests.filter(
      (r) => r.url.endsWith("/myStudyList") && r.body.schoolyearid === "2026",
    ).length,
    2,
    "refresh includes every learned-list page",
  );
});
