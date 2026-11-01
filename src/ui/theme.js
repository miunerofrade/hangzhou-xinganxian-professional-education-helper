import { customPalette, normalizeSeed, DEFAULT_SEED } from "./custom-palette.js";
import { appearancePalettes } from "./palettes.js";
export { appearancePalettes } from "./palettes.js";
const KEY = "hz-helper-neumorphism-v1";
const PALETTE_KEY = "hz-helper-material-palette-v1";
const PURE_KEY = "hz-helper-pure-neumorphism-v1";
const SEED_KEY = "hz-helper-material-seed-v1";
const views = new Set();
const validChoice = (value) => value === "custom" || Object.hasOwn(appearancePalettes, value);
let stopListening = null;
function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Keep in-page controls usable. */
  }
}
function notify(state) {
  for (const apply of views) apply(state);
}
export function bindAppearance({ host, $, lifecycle }) {
  const toggle = $("#neumorphism"),
    picker = $("#appearance-palette"),
    pureToggle = $("#pure-neumorphism");
  for (const [value, palette] of Object.entries(appearancePalettes)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = palette.label;
    picker.append(option);
  }
  const customOption = document.createElement("option");
  customOption.value = "custom";
  customOption.textContent = "自定义";
  picker.append(customOption);
  const colorInput = $("#appearance-seed-color"),
    hexInput = $("#appearance-seed-hex");
  let enabled = false,
    pure = false,
    selected = "lavender",
    seed = DEFAULT_SEED,
    appliedPalette = null;
  const update = (element, property, value) => {
    if (element[property] !== value) element[property] = value;
  };
  const flag = (name, value) => {
    if (value) {
      if (host.getAttribute(name) !== "true") host.setAttribute(name, "true");
    } else if (host.hasAttribute ? host.hasAttribute(name) : host.getAttribute(name) !== null) {
      host.removeAttribute(name);
    }
  };
  const apply = (state) => {
    enabled = state.enabled ?? enabled;
    pure = state.pure ?? pure;
    selected = validChoice(state.palette) ? state.palette : selected;
    seed = normalizeSeed(state.seed) || seed;
    const palette = selected === "custom" ? customPalette(seed) : appearancePalettes[selected];
    update(toggle, "checked", enabled);
    update(pureToggle, "checked", pure);
    update($("#pure-neumorphism-row"), "hidden", !enabled);
    flag("data-pure-neumorphic", enabled && pure);
    update(picker, "value", selected);
    update($("#appearance-palette-row"), "hidden", !enabled);
    update($("#appearance-custom-row"), "hidden", !enabled || selected !== "custom");
    update(colorInput, "value", seed);
    if (hexInput.value.toLowerCase() !== seed) hexInput.value = seed;
    hexInput.removeAttribute("aria-invalid");
    $("#appearance-seed-error").textContent = "";
    flag("data-neumorphic", enabled);
    if (palette !== appliedPalette) {
      host.style.setProperty("--theme-surface", palette.surface);
      host.style.setProperty("--theme-card", palette.card);
      host.style.setProperty("--theme-shadow", palette.shadow);
      for (const [role, color] of Object.entries(palette.roles)) {
        host.style.setProperty(`--theme-${role}`, color);
      }
      appliedPalette = palette;
    }
  };
  views.add(apply);
  apply({
    enabled: read(KEY) === "1",
    pure: read(PURE_KEY) === "1",
    palette: read(PALETTE_KEY),
    seed: read(SEED_KEY),
  });
  toggle.onchange = () => {
    notify({ enabled: toggle.checked });
    save(KEY, toggle.checked ? "1" : "0");
  };
  pureToggle.onchange = () => {
    notify({ pure: pureToggle.checked });
    save(PURE_KEY, pureToggle.checked ? "1" : "0");
  };
  picker.onchange = () => {
    if (!validChoice(picker.value)) return;
    notify({ palette: picker.value });
    save(PALETTE_KEY, picker.value);
  };
  const updateSeed = (value, showError = false) => {
    const next = normalizeSeed(value);
    if (!next) {
      if (showError) {
        hexInput.setAttribute("aria-invalid", "true");
        $("#appearance-seed-error").textContent = "请输入六位色值，例如 #6750A4";
      }
      return;
    }
    notify({ seed: next });
    save(SEED_KEY, next);
  };
  colorInput.oninput = () => updateSeed(colorInput.value);
  hexInput.oninput = () => updateSeed(hexInput.value);
  hexInput.onchange = () => updateSeed(hexInput.value, true);
  if (!stopListening) {
    const changed = (event) => {
      if (event.key === KEY || event.key === null) notify({ enabled: read(KEY) === "1" });
      if (event.key === PURE_KEY || event.key === null) notify({ pure: read(PURE_KEY) === "1" });
      if (event.key === SEED_KEY || event.key === null)
        notify({ seed: read(SEED_KEY) || DEFAULT_SEED });
      if (event.key === PALETTE_KEY || event.key === null)
        notify({ palette: read(PALETTE_KEY) || "lavender" });
    };
    window.addEventListener("storage", changed);
    stopListening = () => window.removeEventListener("storage", changed);
  }
  lifecycle.defer(() => {
    views.delete(apply);
    if (!views.size) {
      stopListening?.();
      stopListening = null;
    }
  });
}
