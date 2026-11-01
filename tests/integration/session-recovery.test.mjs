import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../fixture.mjs";
import { catalogResponse } from "./catalogs.mjs";

await test("resuming after pause and tab close reopens the same course without marking it complete.", async () => {
  const resumeClosed = fixture(null, { controller: true, response: catalogResponse });
  resumeClosed.nodes.get("#target").value = "1";
  await resumeClosed.nodes.get("#plan").onclick();
  await resumeClosed.nodes.get("#start").onclick();
  const resumeEntry = [...resumeClosed.storage.entries()].find(
    ([key]) => key.startsWith("hz-helper:") && key !== "hz-helper:R",
  );
  const oldConfig = JSON.parse(resumeEntry[1]),
    oldWindow = resumeClosed.child;
  resumeClosed.nodes.get("#start").onclick();
  oldWindow.closed = true;
  await resumeClosed.nodes.get("#start").onclick();
  const newConfig = JSON.parse(resumeClosed.storage.get(resumeEntry[0]));
  assert.notEqual(resumeClosed.child, oldWindow, "resume reopens the closed course tab");
  assert.equal(newConfig.course.id, oldConfig.course.id, "resume reopens the same course");
  assert.notEqual(newConfig.job, oldConfig.job, "reopened course receives a fresh worker job");
  assert.equal(
    resumeClosed.nodes.get("#earned").textContent,
    0,
    "reopening does not mark the course complete",
  );
  assert.equal(resumeClosed.savedCache().completed.length, 0);
});

await test("refresh restores the plan and reconnects the existing course without pausing it.", async () => {
  const beforeReload = fixture(null, { controller: true, response: catalogResponse });
  beforeReload.nodes.get("#target").value = "1";
  await beforeReload.nodes.get("#plan").onclick();
  await beforeReload.nodes.get("#start").onclick();
  const reloadEntry = [...beforeReload.storage.entries()].find(
    ([key]) => key.startsWith("hz-helper:") && key !== "hz-helper:R",
  );
  const reloadTask = JSON.parse(reloadEntry[1]);
  const reloadRun = reloadEntry[0].slice("hz-helper:".length);
  const existingPlayer = beforeReload.child;
  existingPlayer.location = {
    href: "https://learning.hzrs.hangzhou.gov.cn/#/class",
    hash: `#/class?__hzRun=${reloadRun}&__hzJob=${reloadTask.job}`,
  };
  beforeReload.dispatchWindow("pagehide", {});
  assert.ok(beforeReload.storage.has("hz-helper-controller-session-v1"));
  assert.equal(
    beforeReload.sent.some((m) => m.type === "pause" && m.run === reloadRun),
    false,
    "refresh does not pause the course",
  );
  const afterReload = fixture(null, {
    controller: true,
    response: catalogResponse,
    storage: [...beforeReload.storage],
    reconnectWindow: existingPlayer,
  });
  for (
    let i = 0;
    i < 50 && afterReload.nodes.get("#start").getAttribute("aria-label") !== "暂停学习";
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(afterReload.child, existingPlayer, "reconnects the existing course");
  assert.equal(
    afterReload.openCalls.some((call) => call.url === "" || call.url === "about:blank"),
    false,
    "reconnection never opens a blank lookup tab",
  );
  assert.equal(afterReload.nodes.get("#start").getAttribute("aria-label"), "暂停学习");
  assert.equal(afterReload.nodes.get("#queued").textContent, 2, "restores the planned courses");
  assert.equal(afterReload.nodes.get("#earned").textContent, 0);
  assert.equal(
    JSON.parse(afterReload.storage.get(reloadEntry[0])).job,
    reloadTask.job,
    "does not replace worker job",
  );

  const lostPlayer = fixture(null, {
    controller: true,
    response: catalogResponse,
    storage: [...beforeReload.storage],
  });
  for (
    let i = 0;
    i < 50 && lostPlayer.nodes.get("#start").getAttribute("aria-label") !== "暂停学习";
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  const restartedTask = JSON.parse(lostPlayer.storage.get(reloadEntry[0]));
  assert.equal(
    restartedTask.course.id,
    reloadTask.course.id,
    "a missing course page is reopened for the same course",
  );
  assert.notEqual(restartedTask.job, reloadTask.job, "reopened page has a fresh job");
  assert.equal(lostPlayer.nodes.get("#start").getAttribute("aria-label"), "暂停学习");
  const pausedSnapshot = new Map(beforeReload.storage);
  const pausedSession = JSON.parse(pausedSnapshot.get("hz-helper-controller-session-v1"));
  pausedSession.paused = true;
  pausedSession.heartbeatPaused = false;
  pausedSnapshot.set("hz-helper-controller-session-v1", JSON.stringify(pausedSession));
  const pausedReload = fixture(null, {
    controller: true,
    response: catalogResponse,
    storage: [...pausedSnapshot],
  });
  for (
    let i = 0;
    i < 50 && pausedReload.nodes.get("#start").getAttribute("aria-label") !== "继续学习";
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(
    JSON.parse(pausedReload.storage.get(reloadEntry[0])).job,
    reloadTask.job,
    "refresh preserves a manual pause and does not reopen the course",
  );

  const completionDuringReload = new Map(beforeReload.storage);
  completionDuringReload.set(
    `hz-helper-completion:${reloadRun}:${reloadTask.job}`,
    JSON.stringify({ id: reloadTask.course.id, credits: 0.5 }),
  );
  const recoveredCompletion = fixture(null, {
    controller: true,
    response: catalogResponse,
    storage: [...completionDuringReload],
    reconnectWindow: existingPlayer,
  });
  for (let i = 0; i < 50 && !recoveredCompletion.savedRecords()[reloadTask.course.id]; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(
    recoveredCompletion.savedRecords()[reloadTask.course.id].kind,
    "complete",
    "completion arriving during refresh is recovered",
  );
  assert.equal(
    recoveredCompletion.savedCache().completed.filter((id) => id === reloadTask.course.id).length,
    1,
  );
});
