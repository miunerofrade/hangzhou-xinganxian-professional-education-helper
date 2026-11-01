import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../fixture.mjs";
import { catalogResponse } from "./catalogs.mjs";

await test("default icon-only control/player pages, non-disruptive card toggle, Escape focus return, info disclosure dismissal, text contrast >= 4.5:1.", async () => {
  let f = fixture();

  // The floating card starts closed on both the control and player pages.
  for (const controller of [false, true]) {
    f = fixture(null, { controller, response: catalogResponse });
    assert.match(f.ui.innerHTML, /<section[^>]*id="panel"[^>]*hidden/);
    const before = f.sent.length;
    f.nodes.get("#launcher").onclick();
    assert.equal(f.nodes.get("#panel").hidden, false);
    assert.equal(f.nodes.get("#launcher").attributes["aria-expanded"], "true");
    f.nodes.get("#close-panel").onclick();
    assert.equal(f.nodes.get("#panel").hidden, true);
    assert.equal(f.nodes.get("#launcher").attributes["aria-expanded"], "false");
    assert.equal(
      f.sent.length,
      before,
      "opening and closing the menu do not pause or resume playback",
    );
    f.nodes.get("#launcher").onclick();
    f.emitUI("keydown", { key: "Escape", preventDefault() {} });
    assert.equal(f.nodes.get("#panel").hidden, true);
    assert.equal(f.nodes.get("#launcher").focused, true);
  }
  // Info controls are keyboard-dismissable and expose expanded state.
  f.nodes.get("#launcher").onclick();
  const infoButton = {
    dataset: { info: "target-info" },
    setAttribute(k, v) {
      this[k] = v;
    },
    focus() {
      this.focused = true;
    },
  };
  f.ui.querySelector("#target-info").hidden = true;
  f.emitUI("click", { target: { closest: () => infoButton } });
  assert.equal(f.nodes.get("#target-info").hidden, false);
  assert.equal(infoButton["aria-expanded"], "true");
  f.emitUI("keydown", { key: "Escape", preventDefault() {} });
  assert.equal(f.nodes.get("#target-info").hidden, true);
  assert.equal(infoButton.focused, true);
  assert.equal(f.nodes.get("#panel").hidden, false, "Escape closes info before the whole card");

  function luminance(hex) {
    const rgb = hex
      .match(/[0-9a-f]{2}/gi)
      .map((x) => parseInt(x, 16) / 255)
      .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  }
  function contrast(a, b) {
    const l = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (l[0] + 0.05) / (l[1] + 0.05);
  }
  for (const [fg, bg] of [
    ["171717", "ffffff"],
    ["595959", "ffffff"],
    ["595959", "f6f6f6"],
    ["353535", "ffffff"],
    ["ffffff", "171717"],
    ["666666", "eeeeee"],
  ])
    assert.ok(contrast(fg, bg) >= 4.5, `${fg}/${bg} contrast`);
});

await test("card enter/exit motion, delayed hide, rapid reopen, independent playback state, status animation, reduced motion, fixed hours unit and inset arrow.", async () => {
  let f;

  // Card entry/exit animations preserve accessibility and never change the learning state.
  f = fixture(null, { controller: true, response: catalogResponse, animationEnabled: true });
  const sentBeforeAnimation = f.sent.length;
  f.nodes.get("#launcher").onclick();
  let panelAnimations = f.animations.filter((a) => a.selector === "#panel");
  assert.equal(panelAnimations.length, 1);
  assert.equal(panelAnimations[0].options.duration, 380);
  assert.equal(f.nodes.get("#panel").hidden, false);
  panelAnimations[0].finish();
  await Promise.resolve();

  const afterStop = f.sent.length;
  f.nodes.get("#close-panel").onclick();
  panelAnimations = f.animations.filter((a) => a.selector === "#panel");
  assert.equal(panelAnimations.at(-1).options.duration, 300);
  assert.equal(f.nodes.get("#panel").hidden, false, "visible until exit animation completes");
  assert.equal(f.nodes.get("#panel").inert, true);
  assert.equal(f.nodes.get("#panel").attributes["aria-hidden"], "true");
  assert.equal(f.nodes.get("#launcher").focused, true);
  panelAnimations.at(-1).finish();
  await Promise.resolve();
  assert.equal(f.nodes.get("#panel").hidden, true);
  assert.equal(f.sent.length, afterStop, "closing menu does not alter playback");

  // Reopening during an exit animation must not be hidden by its stale completion.
  f.nodes.get("#launcher").onclick();
  let opening = f.animations.filter((a) => a.selector === "#panel").at(-1);
  opening.finish();
  await Promise.resolve();
  f.nodes.get("#close-panel").onclick();
  const stale = f.animations.filter((a) => a.selector === "#panel").at(-1);
  f.nodes.get("#launcher").onclick();
  const reopened = f.animations.filter((a) => a.selector === "#panel").at(-1);
  stale.finish();
  await Promise.resolve();
  assert.equal(f.nodes.get("#panel").hidden, false);
  assert.equal(f.nodes.get("#panel").inert, false);
  reopened.finish();
  await Promise.resolve();
  assert.equal(f.nodes.get("#panel").hidden, false);

  // System reduced-motion preference disables animation and closes immediately.
  f = fixture(null, {
    controller: true,
    response: catalogResponse,
    animationEnabled: true,
    reduceMotion: true,
  });
  f.nodes.get("#launcher").onclick();
  f.nodes.get("#close-panel").onclick();
  assert.equal(f.animations.length, 0);
  assert.equal(f.nodes.get("#panel").hidden, true);

  // The target uses hours without a unit selector.
  assert.doesNotMatch(f.nodes.get("#controls").innerHTML, /<select id="unit"/);
  assert.match(f.nodes.get("#controls").innerHTML, /id="target-unit">学时/);
  assert.match(
    f.ui.innerHTML,
    /\.select-wrap\s*>\s*svg\s*\{[^}]*right:\s*10px;[^}]*pointer-events:\s*none/,
  );
  assert.match(f.ui.innerHTML, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
});

await test("video mute preference, pointer dragging, edge docking and click suppression.", async () => {
  // Mute preference affects accessible video and is retained; pointer dragging docks and preserves position.
  const muteTest = fixture(null, { direct: true });
  await muteTest.tick();
  muteTest.nodes.get("#mute-video").checked = true;
  muteTest.nodes.get("#mute-video").onchange();
  assert.equal(muteTest.video.muted, true);
  assert.equal(muteTest.storage.get("hz-helper-mute-video-v1"), "1");
  muteTest.nodes.get("#mute-video").checked = false;
  muteTest.nodes.get("#mute-video").onchange();
  assert.equal(muteTest.video.muted, undefined);
  const dragTest = fixture(null, { controller: true });
  dragTest.host.getBoundingClientRect = () => ({ left: 932, top: 732 });
  const ball = dragTest.nodes.get("#launcher");
  ball.onpointerdown({ button: 0, pointerId: 1, clientX: 950, clientY: 750 });
  ball.onpointermove({ pointerId: 1, clientX: 100, clientY: 250 });
  ball.onpointerup({ pointerId: 1, clientX: 100, clientY: 250 });
  assert.equal(dragTest.host.style.left, "12px");
  assert.equal(dragTest.nodes.get("#panel").style.left, "12px");
  assert.equal(JSON.parse(dragTest.storage.get("hz-helper-launcher-position-v1")).side, "left");
  ball.onclick();
  assert.equal(dragTest.nodes.get("#panel").hidden, true, "drag does not trigger a click");
});

await test("current course is highlighted once in the plan and pause updates its label.", async () => {
  const activeMarker = fixture(null, { controller: true, response: catalogResponse });
  activeMarker.nodes.get("#target").value = "1";
  await activeMarker.nodes.get("#plan").onclick();
  await activeMarker.nodes.get("#start").onclick();
  const collect = (n) => [n, ...(n?.children || []).flatMap(collect)];
  let markers = collect(activeMarker.nodes.get("#preview")).filter(
    (n) => n.className === "course-current-badge" && !n.hidden,
  );
  assert.equal(markers.length, 1);
  assert.equal(markers[0].textContent, "正在学习");
  assert.equal(activeMarker.nodes.get("#status-line").hidden, true);
  activeMarker.nodes.get("#start").onclick();
  markers = collect(activeMarker.nodes.get("#preview")).filter(
    (n) => n.className === "course-current-badge" && !n.hidden,
  );
  assert.equal(markers[0].textContent, "已暂停");
});

await test("unchanged list DOM and history persistence are reused.", async () => {
  // Statistics-only updates keep both lists alive; unchanged history is not rewritten on paging.
  const stableView = fixture(null, { controller: true, response: catalogResponse });
  stableView.nodes.get("#target").value = "1";
  await stableView.nodes.get("#plan").onclick();
  const planNode = stableView.nodes.get("#preview").children[0];
  const recordsNode = stableView.nodes.get("#records").children[0];
  await stableView.sumLearned();
  assert.equal(
    stableView.nodes.get("#preview").children[0],
    planNode,
    "unchanged plan keeps its DOM nodes",
  );
  assert.equal(
    stableView.nodes.get("#records").children[0],
    recordsNode,
    "unchanged exclusions keep their DOM nodes",
  );
  stableView.storageWrites.length = 0;
  await stableView.nodes.get("#read-next").onclick();
  assert.equal(
    stableView.storageWrites.some((key) => key.startsWith("hz-helper-history-v1:")),
    false,
    "paging never rewrites unchanged history",
  );
});
