import { createIconButton } from "./icon-button.js";
import { decorateSurfaceCard } from "./surface-card.js";
import { round } from "../utils.js";
import { minutesPerUnit } from "../planner.js";
const setText = (element, value) => {
  const text = String(value);
  if (element.textContent !== text) element.textContent = text;
};
// The row owns its DOM; the plan owns course data and business commands.
export function createCourseRow(courseAction) {
  const element = document.createElement("li");
  const ordinal = document.createElement("span");
  ordinal.className = "ordinal";
  const content = document.createElement("div");
  content.className = "course-content";
  const badge = document.createElement("span");
  badge.className = "course-current-badge";
  badge.hidden = true;
  const title = document.createElement("div");
  title.className = "course-title";
  const meta = document.createElement("div");
  meta.className = "course-meta";
  const facts = document.createElement("span");
  facts.className = "course-facts";
  const factNodes = Array.from({ length: 3 }, () => document.createElement("span"));
  facts.append(...factNodes);
  const score = document.createElement("span");
  score.className = "score";
  const actions = document.createElement("div");
  let selectedCourse = null;
  const buttons = [
    ["已学", "manual", "check"],
    ["移除", "excluded", "trash"],
  ].map(([caption, kind, name]) => {
    const button = createIconButton({
      name,
      size: 20,
      wrapped: true,
      className: "quiet-action",
      label: caption,
      title: kind === "manual" ? "已学，跳过此课" : "移除此课",
    });
    button.onclick = () => courseAction(selectedCourse.id, kind);
    actions.append(button);
    return { button, caption };
  });
  meta.append(facts, score);
  content.append(badge, title, meta);
  element.append(ordinal, content, actions);
  function update({ course, index, current, paused, unit }) {
    selectedCourse = course;
    const rowClass = current ? (paused ? "course current paused" : "course current") : "course";
    if (element.dataset.rowState !== rowClass) {
      element.className = rowClass;
      element.dataset.rowState = rowClass;
      if (current && !paused) decorateSurfaceCard(element, { tone: "accent", compact: true });
      else {
        delete element.dataset.cardTone;
        delete element.dataset.cardSize;
      }
      actions.className = current ? "row-actions pill-actions" : "row-actions icon-actions";
    }
    setText(ordinal, String(index + 1).padStart(2, "0"));
    badge.hidden = !current;
    setText(badge, paused ? "已暂停" : "正在学习");
    setText(title, course.name);
    const values = [
      course.category || "",
      `${round(course.hours)} 学时`,
      `${course.learned > 0 ? "剩余" : "时长"} ${round(course.remaining / 60)} 分钟`,
    ];
    values.forEach((value, i) => {
      setText(factNodes[i], value);
      factNodes[i].hidden = !value;
    });
    setText(score, `${round(minutesPerUnit(course, unit))} 分/学时`);
    for (const { button, caption } of buttons) {
      const label = `${caption}：${course.name}`;
      if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
      button.dataset.courseId = course.id;
    }
  }
  return { element, update };
}
