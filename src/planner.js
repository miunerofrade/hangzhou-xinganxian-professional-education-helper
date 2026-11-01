import { number } from "./utils.js";
export function classify(message) {
  const t = String(message).replace(/\s+/g, "");
  const match = t.match(/^您的学习时间已达到要求，获得学分:([0-9]+(?:\.[0-9]+)?),是否继续学习\?$/);
  if (match && Number(match[1]) > 0) return { type: "complete", credits: Number(match[1]) };
  if (
    /(?:同时|同一时间)(?:只能|只允许|仅能|仅允许)?(?:播放|学习)一(?:个|门)(?:视频|课程)|只能(?:同时)?(?:播放|学习)一(?:个|门)(?:视频|课程)/.test(
      t,
    )
  )
    return { type: "conflict" };
  if (
    /^(?:您(?:的)?|该课程)?(?:学时(?:已)?达标|(?:学习时间|学时)已达到要求|已完成(?:本|该)课程学习|(?:本|该)课程已完成)(?:[，,。]?是否继续学习[?？])?[！!。]?$/.test(
      t,
    )
  )
    return { type: "quota" };
  if (t === "是否继续学习？") return { type: "resume" };
  if (t === "您是否要继续学习?请在2分钟之内点击确定") return { type: "presence" };
  return { type: "unknown" };
}
export function rank(courses) {
  return [...courses].sort(
    (a, b) =>
      b.hours / b.remaining - a.hours / a.remaining ||
      a.remaining - b.remaining ||
      a.id.localeCompare(b.id),
  );
}
export function inWindow(value, now = new Date()) {
  if (!value.trim()) return true;
  const m = value.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (!m || +m[1] > 23 || +m[3] > 23 || +m[2] > 59 || +m[4] > 59)
    throw new Error("时间段请填写 HH:MM-HH:MM，例如 19:00-23:00");
  const start = +m[1] * 60 + +m[2],
    end = +m[3] * 60 + +m[4],
    minute = now.getHours() * 60 + now.getMinutes();
  return (
    start === end ||
    (start < end ? minute >= start && minute < end : minute >= start || minute < end)
  );
}

export function normalizeCourse(row, studied = null) {
  const id = row.courseid === undefined || row.courseid === null ? "" : String(row.courseid);
  const duration = number(row.coursetimes);
  const learned = studied ? number(studied.validstudytime) : number(row.validstudytime ?? 0);
  if (!id || !row.coursename || !(duration > 0) || !(learned >= 0) || learned >= duration)
    return null;
  return {
    id,
    name: String(row.coursename),
    duration,
    learned,
    remaining: duration - learned,
    hours: number(row.period),
    category: String(row.coursetype || "").trim(),
    examChecked: row.examtype_text === "无",
    excludedExam: !!row.examtype_text && row.examtype_text !== "无",
  };
}
export function eligible(course, settings) {
  const value = course.hours;
  return (
    !course.excludedExam &&
    value > 0 &&
    course.duration <= settings.maxMinutes * 60 &&
    course.remaining > 0 &&
    minutesPerUnit(course) < (settings.maxRatio ?? 45)
  );
}
export function minutesPerUnit(course) {
  return course.remaining / 60 / course.hours;
}
export function chooseForGoal(courses, target, earned = 0) {
  const chosen = [];
  let sum = earned;
  for (const course of courses) {
    if (sum >= target) break;
    chosen.push(course);
    sum += course.hours;
  }
  return chosen;
}
export function categoryGroup(name) {
  if (name === "专业课程") return "professional";
  if (name === "行业公需" || name === "一般公需") return "public";
  return null;
}
export function annualDeficits(goals, progress) {
  const professional = Math.max(0, goals.professional - progress.professional);
  const publicHours = Math.max(0, goals.public - progress.public);
  // Existing hours and the two minimum deficits already contribute to the annual total.
  const generalExtra = Math.max(0, goals.annualTotal - progress.total - professional - publicHours);
  return { professional, public: publicHours, generalExtra };
}
export function annualChoose(courses, goals, progress, earned) {
  const value = { ...progress },
    chosen = [],
    pool = [...courses];
  let roundEarned = earned;
  while (pool.length && !goalReached(goals, roundEarned, value, true)) {
    const deficits = annualDeficits(goals, value);
    const professional = pool.filter((c) => categoryGroup(c.category) === "professional");
    const publicCourses = pool.filter((c) => categoryGroup(c.category) === "public");
    const generalCourses = pool.filter((c) => c.category === "一般公需");
    let available = [];
    if (deficits.professional > 0 && professional.length) available = professional;
    else if (deficits.public > 0 && publicCourses.length) available = publicCourses;
    else if (goals.targetMode === "absolute" && !deficits.professional && !deficits.public)
      available = pool;
    else if (goals.targetMode !== "absolute" && deficits.generalExtra > 0 && generalCourses.length)
      available = generalCourses;
    if (!available.length) break;
    const course = available[0],
      group = categoryGroup(course.category);
    chosen.push(course);
    pool.splice(pool.indexOf(course), 1);
    roundEarned += course.hours;
    value.total += course.hours;
    if (group) value[group] += course.hours;
  }
  return chosen;
}
export function parsePage(data, key, page) {
  const p = data[key];
  if (
    !p ||
    !Array.isArray(p.data) ||
    number(p.current_page) !== page ||
    !(number(p.per_page) > 0) ||
    !(number(p.total) >= 0)
  )
    throw new Error("课程分页结构变化或返回页码错误，已停止读取");
  if (p.data.some((row) => row.courseid === undefined || row.courseid === null || !row.coursename))
    throw new Error("课程 ID / 名称缺失，已停止读取");
  const exhausted = page * number(p.per_page) >= number(p.total);
  if (!p.data.length && !exhausted) throw new Error("分页提前返回空数据，未将其认定为末页");
  return {
    rows: p.data,
    exhausted,
    total: number(p.total),
    signature: p.data
      .map((row) => String(row.courseid))
      .sort()
      .join("|"),
  };
}

export const usesAnnual = (s) =>
  s.category === "auto" && (s.mode === "annual" || s.targetMode === "absolute");
export function goalReached(s, amount, progress, annual = usesAnnual(s)) {
  if (s.targetMode === "absolute" && annual)
    return (
      !!progress &&
      amount >= s.target &&
      progress.professional >= s.professional &&
      progress.public >= s.public
    );
  return (
    amount >= s.target ||
    (annual &&
      progress &&
      progress.total >= s.annualTotal &&
      progress.professional >= s.professional &&
      progress.public >= s.public)
  );
}
export function projectProgress(base, courses) {
  if (!base) return null;
  const progress = { ...base };
  for (const course of courses) {
    progress.total += course.hours;
    const group = categoryGroup(course.category);
    if (group) progress[group] += course.hours;
  }
  return progress;
}
