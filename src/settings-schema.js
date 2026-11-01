// Single source for storage types, template defaults and scheduling impact.
const fields = [
  ["target", "10"],
  ["targetMode", "absolute"],
  ["maxMinutes", "75"],
  ["maxRatio", "45"],
  ["window", ""],
  ["annual-limit", true],
  ["goal-total", "90"],
  ["goal-professional", "60"],
  ["goal-public", "18"],
  ["auto", true, false],
  ["category", "auto"],
  ["auto-refresh", true, false],
  ["refresh-minutes", "15", false],
];
export const SETTINGS = Object.freeze(
  Object.fromEntries(
    fields.map(([id, defaultValue, affectsPlan = true]) => [
      id,
      Object.freeze({
        defaultValue,
        affectsPlan,
        checkbox: typeof defaultValue === "boolean",
      }),
    ]),
  ),
);
export const PERSISTED_SETTING_IDS = Object.freeze(Object.keys(SETTINGS));
export const PLAN_SETTING_IDS = Object.freeze(
  PERSISTED_SETTING_IDS.filter((id) => SETTINGS[id].affectsPlan),
);
export const isCheckboxSetting = (id) => SETTINGS[id]?.checkbox === true;
export const settingDefault = (id) => SETTINGS[id].defaultValue;
export const REFRESH_MINUTES = Object.freeze({ min: 5, max: 240 });
export const validRefreshMinutes = (value) =>
  Number.isFinite(value) && value >= REFRESH_MINUTES.min && value <= REFRESH_MINUTES.max;
