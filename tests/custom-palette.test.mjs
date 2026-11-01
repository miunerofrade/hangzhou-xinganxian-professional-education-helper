import { appearancePalettes } from "../src/ui/palettes.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
// The upstream package ships an extensionless Node ESM import; test the same
// browser-bundled generator used by the userscript instead of patching vendor code.
const result = await build({
  entryPoints: [new URL("../src/ui/custom-palette.js", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "esm",
});
const { customPalette, normalizeSeed } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`
);
import { fixture } from "./fixture.mjs";
const lum = (h) => {
  const a = h
    .slice(1)
    .match(/../g)
    .map((v) => parseInt(v, 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
};
const ratio = (a, b) => {
  const x = lum(a),
    y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
test("custom seed normalization rejects partial or invalid input and matches preset Google tones", () => {
  assert.equal(normalizeSeed("6750A4"), "#6750a4");
  assert.equal(normalizeSeed(" #006A60 "), "#006a60");
  for (const value of ["#abc", "#12345g", "", null, "rgb(0,0,0)"])
    assert.equal(customPalette(value), null);
  const palette = customPalette("#6750a4");
  assert.equal(palette.roles.primary, "#6750a4");
  assert.equal(palette.surface, "#f2ebf7");
  assert.equal(palette, customPalette("6750A4"));
});
test("generated seed extremes preserve text and selected-state contrast", () => {
  for (const seed of [
    "#000000",
    "#ffffff",
    "#ff0000",
    "#00ff00",
    "#0000ff",
    "#777777",
    "#ffff00",
    "#00ffff",
  ]) {
    const p = customPalette(seed);
    for (const [bg, fg] of [
      [p.roles.primary, p.roles["on-primary"]],
      [p.roles["primary-container"], p.roles["on-primary-container"]],
      [p.roles["secondary-container"], p.roles["on-secondary-container"]],
      [p.card, p.roles["on-surface"]],
    ])
      assert.ok(ratio(bg, fg) >= 4.5, seed);
    assert.ok(ratio(p.card, p.roles.primary) >= 3, seed);
  }
});
test("custom picker saves the seed, rejects invalid edits and restores the theme on reload", () => {
  const f = fixture(null, { controller: true });
  const get = (id) => f.nodes.get(id);
  get("#neumorphism").checked = true;
  get("#neumorphism").onchange();
  get("#appearance-palette").value = "custom";
  get("#appearance-palette").onchange();
  assert.equal(get("#appearance-custom-row").hidden, false);
  get("#appearance-seed-color").value = "#006a60";
  get("#appearance-seed-color").oninput();
  assert.equal(get("#appearance-seed-hex").value, "#006a60");
  assert.equal(f.storage.get("hz-helper-material-seed-v1"), "#006a60");
  get("#appearance-seed-hex").value = "#xx";
  get("#appearance-seed-hex").onchange();
  assert.equal(get("#appearance-seed-hex").getAttribute("aria-invalid"), "true");
  assert.equal(f.storage.get("hz-helper-material-seed-v1"), "#006a60");
  const reloaded = fixture(null, { controller: true, storage: [...f.storage] });
  assert.equal(reloaded.nodes.get("#appearance-palette").value, "custom");
  assert.equal(reloaded.nodes.get("#appearance-seed-color").value, "#006a60");
  reloaded.nodes.get("#neumorphism").checked = false;
  reloaded.nodes.get("#neumorphism").onchange();
  assert.equal(reloaded.nodes.get("#appearance-custom-row").hidden, true);
});

test("experimental same-color style is opt-in, persists and leaves the chosen palette intact", () => {
  const f = fixture(null, { controller: true });
  const toggle = f.nodes.get("#neumorphism"),
    pure = f.nodes.get("#pure-neumorphism");
  assert.equal(pure.checked, false);
  assert.equal(f.host.getAttribute("data-pure-neumorphic"), null);
  toggle.checked = true;
  toggle.onchange();
  pure.checked = true;
  pure.onchange();
  assert.equal(f.host.getAttribute("data-pure-neumorphic"), "true");
  assert.equal(f.storage.get("hz-helper-pure-neumorphism-v1"), "1");
  const picker = f.nodes.get("#appearance-palette");
  picker.value = "blue";
  picker.onchange();
  assert.equal(f.host.getAttribute("data-pure-neumorphic"), "true");
  assert.equal(f.storage.get("hz-helper-material-palette-v1"), "blue");
  toggle.checked = false;
  toggle.onchange();
  assert.equal(f.host.getAttribute("data-pure-neumorphic"), null);
  assert.equal(
    pure.checked,
    true,
    "remember the experimental preference without applying it to normal mode",
  );
  const loaded = fixture(null, { controller: true, storage: [...f.storage] });
  assert.equal(loaded.nodes.get("#pure-neumorphism").checked, true);
  assert.equal(loaded.nodes.get("#appearance-palette").value, "blue");
  assert.equal(loaded.host.getAttribute("data-pure-neumorphic"), null);
});

test("same-color control boundaries and emphasis retain contrast across presets and custom seeds", () => {
  const palettes = [
    ...Object.values(appearancePalettes),
    ...["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#777777", "#ffff00", "#00ffff"].map(
      customPalette,
    ),
  ];
  for (const p of palettes) {
    assert.ok(ratio(p.surface, p.roles.outline) >= 3, "control boundary");
    assert.ok(ratio(p.surface, p.roles["on-surface"]) >= 4.5, "body and focus");
    assert.ok(ratio(p.surface, p.roles.primary) >= 4.5, "primary label and checked mark");
  }
});

test("theme switches keep the existing palette styles and changed presets update them", () => {
  const f = fixture(null, { controller: true });
  let writes = 0;
  const set = f.host.style.setProperty;
  f.host.style.setProperty = function (...args) {
    writes++;
    return set.apply(this, args);
  };
  const toggle = f.nodes.get("#neumorphism");
  toggle.checked = true;
  toggle.onchange();
  const pure = f.nodes.get("#pure-neumorphism");
  pure.checked = true;
  pure.onchange();
  assert.equal(writes, 0, "changing material flags does not rewrite color roles");
  const picker = f.nodes.get("#appearance-palette");
  picker.value = "blue";
  picker.onchange();
  assert.ok(writes > 0);
  const count = writes;
  picker.onchange();
  assert.equal(writes, count, "same palette notifications do not rewrite colors");
  f.dispatchWindow("storage", { key: "hz-helper-material-palette-v1" });
  assert.equal(writes, count, "matching cross-tab storage update retains styles");
});
