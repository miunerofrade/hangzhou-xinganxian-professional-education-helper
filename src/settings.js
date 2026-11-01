import { number } from "./utils.js";
import { usesAnnual, inWindow } from "./planner.js";

export const readPlanSettings = ($) => ({
  target: number($("#target").value),
  targetMode: $("#targetMode").value || "increment",
  unit: "hours",
  maxMinutes: number($("#maxMinutes").value),
  maxRatio: number($("#maxRatio").value),
  window: $("#window").value.trim(),
  autoContinue: $("#auto").checked,
  mode: $("#annual-limit").checked ? "annual" : "round",
  annualTotal: number($("#goal-total").value),
  professional: number($("#goal-professional").value),
  public: number($("#goal-public").value),
  category: $("#category").value || "auto",
});
export const samePlanSettings = (s, current) =>
  current &&
  [
    "target",
    "targetMode",
    "unit",
    "maxMinutes",
    "maxRatio",
    "window",
    "mode",
    "annualTotal",
    "professional",
    "public",
    "category",
  ].every((key) => Object.is(s[key], current[key]));

export function validatePlanSettings(s, annual) {
  if (s.mode === "annual" || usesAnnual(s)) {
    if ((!annual.annualSnapshot && !annual.learnedSnapshot) || !annual.annualYear)
      throw new Error("请先刷新平台学时，确认分类和平台默认学年已读取");
    if (
      ![s.annualTotal, s.professional, s.public].every(
        (v) => Number.isFinite(v) && v >= 0 && v <= 10000,
      )
    )
      throw new Error("年度目标须在 0–10000 学时之间");
  }
  if (!["absolute", "increment"].includes(s.targetMode)) throw new Error("目标方式无效");
  if (!["auto", "专业课程", "行业公需", "一般公需"].includes(s.category))
    throw new Error("课程类别无效");
  if (!(s.target > 0 && s.target <= 10000)) throw new Error("学习目标需大于 0 且不超过 10000");
  if (!(s.maxMinutes > 0 && s.maxMinutes <= 600)) throw new Error("单课上限需在 1–600 分钟之间");
  if (!(s.maxRatio > 0 && s.maxRatio <= 600)) throw new Error("每学时上限需在 1–600 分钟之间");
  inWindow(s.window);
}
