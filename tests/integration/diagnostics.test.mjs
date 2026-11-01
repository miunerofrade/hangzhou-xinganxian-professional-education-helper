import { ObservedXHR } from "./observed-xhr.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, source } from "../fixture.mjs";
import { catalogResponse } from "./catalogs.mjs";

await test("passive renewal diagnostics capture safe metadata, handle reused XHR, ignore third parties and clear records.", async () => {
  const authFixture = fixture(null, { controller: true, XMLHttpRequest: ObservedXHR });
  const request = new ObservedXHR();
  request.open("POST", "/api/index/Study.Index/updateStudy?secret=query-secret");
  request.complete({ status: 100, data: "test-token-never-to-store" });
  let authRows = JSON.parse(authFixture.storage.get("hz-helper-events-v1")).filter(
    (row) => row.kind === "auth",
  );
  assert.equal(authRows.length, 1);
  assert.equal(authRows[0].platform, 100);
  assert.equal(authRows[0].path, "/api/index/Study.Index/updateStudy");
  assert.doesNotMatch(
    JSON.stringify(authRows),
    /test-token|query-secret/,
    "tokens and query strings are never recorded",
  );
  assert.equal(
    authFixture.nodes
      .get("#event-log")
      .children.some((row) => row.children[0].children[0].textContent.includes("收到续期响应")),
    true,
  );
  request.open("POST", "/api/index/Study.Index/updateStudy");
  request.complete({ status: -1, msg: "private-data" });
  authRows = JSON.parse(authFixture.storage.get("hz-helper-events-v1")).filter(
    (row) => row.kind === "auth",
  );
  assert.equal(authRows.length, 2);
  assert.equal(authRows[1].platform, -1);
  assert.doesNotMatch(JSON.stringify(authRows), /private-data/);
  request.open("POST", "https://third-party.example/api/index/Study.Index/updateStudy");
  request.complete({ status: 100, data: "other-token" });
  assert.equal(
    JSON.parse(authFixture.storage.get("hz-helper-events-v1")).filter((row) => row.kind === "auth")
      .length,
    2,
    "third-party traffic ignored",
  );
  authFixture.nodes.get("#clear-log").onclick();
  assert.equal(authFixture.storage.has("hz-helper-events-v1"), false);

  // Renewal evidence is observed without copying or altering credentials.
  authFixture.nodes.get("#clear-log").onclick();
  authFixture.storage.set("front_token", "private-rotated-token");
  authFixture.tokenCheck();
  const tokenEvents = JSON.parse(authFixture.storage.get("hz-helper-events-v1"));
  assert.equal(tokenEvents.at(-1).event, "登录凭据已更新");
  assert.doesNotMatch(JSON.stringify(tokenEvents), /private-rotated|fixture-not-a-real-token/);
  assert.equal(authFixture.storage.get("front_token"), "private-rotated-token");
  // Normal playback reports are collected even while the video is actively playing.
  const reporting = fixture(null, { XMLHttpRequest: ObservedXHR });
  const studyRequest = new ObservedXHR();
  studyRequest.open("POST", "/api/index/Study.Index/updateStudy?token=private-query");
  studyRequest.complete({ status: 200, data: { finish: 1, token: "private-response" } });
  const studyEvents = JSON.parse(reporting.storage.get("hz-helper-events-v1"));
  assert.ok(
    studyEvents.some((row) => row.event === "平台进度上报" && /完成标记 1/.test(row.detail)),
  );
  assert.doesNotMatch(JSON.stringify(studyEvents), /private-query|private-response/);
  assert.match(reporting.ui.innerHTML, /<section class="log-section"/);
  assert.doesNotMatch(reporting.ui.innerHTML, /<details[^>]*id="(?:playback|auth)-diagnostics"/);
  assert.match(reporting.ui.innerHTML, /role="switch"/);
});

await test("legacy logs migrate into a combined 30-entry log without token data.", async () => {
  const oldAuthRows = Array.from({ length: 25 }, (_, i) => ({
    time: new Date(1700000000000 + i * 1000).toISOString(),
    path: "/api/index/Course/index",
    http: 200,
    platform: 200,
    transport: "平台 XHR",
  }));
  const capped = fixture(null, {
    controller: true,
    storage: [["hz-helper-auth-observations-v1", JSON.stringify(oldAuthRows)]],
  });
  let kept = JSON.parse(capped.storage.get("hz-helper-events-v1"));
  assert.equal(kept.length, 26);
  assert.equal(kept[0].time, oldAuthRows[0].time);
  assert.equal(
    capped.storage.has("hz-helper-auth-observations-v1"),
    false,
    "legacy store removed only after migration",
  );
  assert.equal(capped.nodes.get("#event-log").children.length, 26);
  // This fixture must install its own XHR wrapper to observe its own storage context.
  const cappedXHR = fixture(null, { controller: true, XMLHttpRequest: ObservedXHR });
  for (let i = 0; i < 35; i++) {
    const x = new ObservedXHR();
    x.open("POST", "/api/index/Study.Index/updateStudy");
    x.complete({ status: 100, data: "secret" });
  }
  kept = JSON.parse(cappedXHR.storage.get("hz-helper-events-v1"));
  assert.equal(kept.length, 30);
  assert.equal(cappedXHR.nodes.get("#event-log").children.length, 30);
  assert.doesNotMatch(JSON.stringify(kept), /secret/);
});

await test("production bundle boots controller and player without test hooks or external runtime dependencies.", async () => {
  // The shipped bundle has no test hooks and runs the same browser entry paths.
  assert.doesNotMatch(source, /__hzTest|testHooks|__TEST__|@require/);
  const shippedController = fixture(null, {
    production: true,
    controller: true,
    response: catalogResponse,
  });
  shippedController.nodes.get("#target").value = "1";
  await shippedController.nodes.get("#plan").onclick();
  assert.equal(shippedController.nodes.get("#queued").textContent, 2);
  await shippedController.nodes.get("#start").onclick();
  assert.equal(shippedController.child.closed, false);
  const shippedPlayer = fixture(null, { production: true, video: { paused: true } });
  await shippedPlayer.tick();
  assert.equal(shippedPlayer.video.paused, false);
});
