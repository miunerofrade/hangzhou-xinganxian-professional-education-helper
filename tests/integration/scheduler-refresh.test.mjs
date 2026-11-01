import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../fixture.mjs";
import { catalogResponse } from "./catalogs.mjs";

await test("configurable controller refresh and iframe-skip replenishment.", async () => {
  let reloads = 0;
  const scheduled = fixture(null, {
    controller: true,
    response: catalogResponse,
    onReload: () => reloads++,
  });
  scheduled.nodes.get("#auto-refresh").checked = true;
  scheduled.nodes.get("#refresh-minutes").value = "15";
  scheduled.nodes.get("#target").value = "1";
  await scheduled.nodes.get("#plan").onclick();
  await scheduled.nodes.get("#start").onclick();
  scheduled.advance(899999);
  scheduled.autoRefresh();
  assert.equal(reloads, 0);
  scheduled.advance(1);
  scheduled.autoRefresh();
  assert.equal(reloads, 1, "active controller reloads at the configured interval");
  scheduled.autoRefresh();
  assert.equal(reloads, 1, "does not reload repeatedly");
  scheduled.nodes.get("#auto-refresh").checked = false;
  scheduled.advance(900000);
  scheduled.autoRefresh();
  assert.equal(reloads, 1, "switch disables periodic reload");
  const replenish = fixture(null, { controller: true, response: catalogResponse });
  replenish.nodes.get("#target").value = "2";
  await replenish.nodes.get("#plan").onclick();
  await replenish.nodes.get("#start").onclick();
  const oldTask = [...replenish.storage.entries()].find(
    ([key]) => key.startsWith("hz-helper:") && key !== "hz-helper:R",
  );
  const oldCourse = JSON.parse(oldTask[1]);
  const previousChild = replenish.child;
  const priorPages = replenish.requests.filter((r) => r.url.endsWith("/SelectCourse")).length;
  replenish.deliver({
    type: "iframe-skip",
    inspected: true,
    run: oldTask[0].slice("hz-helper:".length),
    job: oldCourse.job,
    id: oldCourse.course.id,
  });
  previousChild.closed = true;
  await replenish.tick();
  assert.ok(
    replenish.requests.filter((r) => r.url.endsWith("/SelectCourse")).length > priorPages,
    "skipping iframe searches more pages to refill target",
  );
  assert.notEqual(replenish.child, previousChild);
  assert.equal(replenish.savedRecords()[oldCourse.course.id].kind, "auto-excluded");
});
