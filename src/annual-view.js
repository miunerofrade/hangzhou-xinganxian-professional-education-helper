import { number, round } from "./utils.js";
import { settingDefault } from "./settings-schema.js";
export function createAnnualView($) {
  function updateEstimatedPanel(saved) {
    const base = saved?.base;
    for (const [id, key] of [
      ["total", "total"],
      ["professional", "professional"],
      ["public", "public"],
    ]) {
      const value = number(base?.[key]);
      $("#estimate-" + id).textContent = Number.isFinite(value) ? String(round(value)) : "—";
    }
  }
  function showAnnualGoals(goals = {}) {
    for (const [id, key, fallback] of [
      ["total", "goal-total", settingDefault("goal-total")],
      ["professional", "goal-professional", settingDefault("goal-professional")],
      ["public", "goal-public", settingDefault("goal-public")],
    ]) {
      const targetAsTotal =
        id === "total" &&
        goals.targetMode === "absolute" &&
        (!goals.category || goals.category === "auto");
      const value = number(targetAsTotal ? goals.target : goals[key]);
      $("#goal-display-" + id).textContent =
        Number.isFinite(value) && value >= 0 ? String(round(value)) : String(fallback);
    }
  }
  function showConfirmedHours({ total, snapshot }) {
    $("#annual-total").textContent = String(total);
    $("#annual-breakdown").textContent = snapshot
      ? `专业 ${round(snapshot.professional)}；行业公需 ${round(snapshot.industry)}；一般公需 ${round(snapshot.general)} 学时`
      : "分类学时暂未完整返回";
  }
  return { updateEstimatedPanel, showAnnualGoals, showConfirmedHours };
}
