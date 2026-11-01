import { CorePalette, argbFromHex, hexFromArgb } from "@material/material-color-utilities";
export const DEFAULT_SEED = "#6750a4";
export function normalizeSeed(value) {
  const hex = String(value || "").trim();
  return /^#?[\da-f]{6}$/i.test(hex) ? `#${hex.replace(/^#/, "").toLowerCase()}` : null;
}
let cachedSeed = null,
  cachedPalette = null;
// Same Google HCT tones as the built-in presets, generated locally from one seed.
export function customPalette(value) {
  const seed = normalizeSeed(value);
  if (!seed) return null;
  if (seed === cachedSeed) return cachedPalette;
  const p = CorePalette.of(argbFromHex(seed));
  const color = (palette, tone) => hexFromArgb(palette.tone(tone));
  const palette = {
    label: "自定义",
    surface: color(p.n2, 94),
    card: color(p.n2, 98),
    shadow: color(p.n2, 82),
    roles: {
      primary: color(p.a1, 40),
      "primary-hover": color(p.a1, 30),
      "on-primary": color(p.a1, 100),
      "secondary-container": color(p.a2, 90),
      "on-secondary-container": color(p.a2, 10),
      "on-surface": color(p.n1, 10),
      "on-surface-variant": color(p.n2, 30),
      outline: color(p.n2, 50),
      "primary-container": color(p.a1, 90),
      "on-primary-container": color(p.a1, 10),
    },
  };
  cachedSeed = seed;
  cachedPalette = palette;
  return palette;
}
