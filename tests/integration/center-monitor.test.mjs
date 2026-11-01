import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../fixture.mjs";
import { catalogResponse } from "./catalogs.mjs";

await test("learning-center fallback verifies complete pagination, presence, two absences and learned-list membership.", async () => {
  let monitoring = false,
    courseGone = false,
    listHasCourse = false,
    brokenPage = false;
  const monitorResponse = (url, body) => {
    if (url.endsWith("/Course/index")) {
      if (!monitoring)
        return { status: 200, data: { data: [], current_page: 1, per_page: 100, total: 0 } };
      const d = [
        { courseid: "x", coursename: "x" },
        { courseid: "y", coursename: "y" },
      ];
      const rows = courseGone
        ? d
        : [...d, { courseid: "p1", coursename: "课程", validstudytime: 108, coursetimes: 600 }];
      const pageRows =
        brokenPage && body.page === 2 ? [] : rows.slice((body.page - 1) * 2, body.page * 2);
      return {
        status: 200,
        data: { data: pageRows, current_page: body.page, per_page: 2, total: rows.length },
      };
    }
    if (url.endsWith("/myStudyList")) {
      if (!body.schoolyearid)
        return { status: 200, year: [{ schoolyearid: "2026", yeartitle: "2026学年" }] };
      const rows = listHasCourse
        ? [{ courseid: "p1", period: 0.5, coursetype_text: "一般公需" }]
        : [];
      return {
        status: 200,
        data: { data: rows, current_page: 1, per_page: 100, total: rows.length },
      };
    }
    return catalogResponse(url, body);
  };
  const monitorFixture = fixture(null, {
    controller: true,
    response: monitorResponse,
    simulateListCompletion: false,
  });
  monitorFixture.nodes.get("#target").value = "1";
  await monitorFixture.nodes.get("#plan").onclick();
  await monitorFixture.nodes.get("#start").onclick();
  monitoring = true;
  brokenPage = true;
  await monitorFixture.monitor();
  assert.equal(
    monitorFixture.savedCache().completed.length,
    0,
    "incomplete paginated response cannot establish presence",
  );
  assert.match(monitorFixture.nodes.get("#center-status").textContent, /核对未完成/);
  brokenPage = false;
  monitorFixture.advance(60000);
  await monitorFixture.monitor();
  assert.ok(
    monitorFixture.requests.some((r) => r.url.endsWith("/Course/index") && r.body.page === 2),
    "presence checked on second page",
  );
  assert.match(monitorFixture.nodes.get("#center-status").textContent, /当前课程 18%/);
  courseGone = true;
  listHasCourse = true;
  monitorFixture.advance(60000);
  await monitorFixture.monitor();
  assert.equal(monitorFixture.savedCache().completed.length, 0, "one absence is not sufficient");
  assert.match(monitorFixture.nodes.get("#center-status").textContent, /5秒后再次核对/);
  const quickRecheck = monitorFixture.timeouts.filter((timer) => timer.ms === 5000).at(-1);
  assert.ok(quickRecheck, "first absence schedules an independent 5-second check");
  const beforeQuickCheck = monitorFixture.requests.length;
  monitorFixture.advance(4999);
  await monitorFixture.monitor();
  assert.equal(
    monitorFixture.requests.length,
    beforeQuickCheck,
    "fast recheck cannot run before its deadline",
  );
  monitorFixture.advance(1);
  await quickRecheck.fn();
  assert.equal(monitorFixture.savedRecords().p1.source, "学习中心消失并存在于已学列表");
  assert.ok(monitorFixture.sent.some((m) => m.type === "list-complete"));
  assert.equal(
    monitorFixture.nodes.get("#earned").textContent,
    0.5,
    "progress comes from actual platform list",
  );
  const notSeen = fixture(null, {
    controller: true,
    response: monitorResponse,
    simulateListCompletion: false,
  });
  monitoring = false;
  courseGone = true;
  listHasCourse = false;
  notSeen.nodes.get("#target").value = "1";
  await notSeen.nodes.get("#plan").onclick();
  await notSeen.nodes.get("#start").onclick();
  monitoring = true;
  await notSeen.monitor();
  notSeen.advance(60000);
  await notSeen.monitor();
  assert.equal(
    notSeen.savedCache().completed.length,
    0,
    "absence without prior presence never confirms completion",
  );

  for (const scenario of ["paused", "reappeared", "not-in-learned-list"]) {
    monitoring = false;
    courseGone = false;
    listHasCourse = false;
    const fast = fixture(null, {
      controller: true,
      response: monitorResponse,
      simulateListCompletion: false,
    });
    fast.nodes.get("#target").value = "1";
    await fast.nodes.get("#plan").onclick();
    await fast.nodes.get("#start").onclick();
    monitoring = true;
    await fast.monitor();
    courseGone = true;
    fast.advance(60000);
    await fast.monitor();
    const timer = fast.timeouts.filter((t) => t.ms === 5000).at(-1);
    assert.ok(timer);
    if (scenario === "paused") fast.nodes.get("#start").onclick();
    if (scenario === "reappeared") courseGone = false;
    const requestsBefore = fast.requests.length;
    fast.advance(5000);
    await timer.fn();
    assert.equal(fast.savedCache().completed.length, 0, `${scenario} cannot confirm completion`);
    if (scenario === "paused")
      assert.equal(
        fast.requests.length,
        requestsBefore,
        "manual pause blocks scheduled fast query",
      );
    const after = fast.requests.length;
    fast.advance(5000);
    await fast.monitor();
    assert.equal(fast.requests.length, after, "non-completion returns to normal polling cadence");
  }
});
