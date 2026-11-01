import { number, round, sleep } from "./utils.js";
// Strict learned-list aggregation. No DOM, storage or local estimate mutations.
export async function readLearnedHours({ readAPI, accountScope, scope, year, requestRetries }) {
  const quiet = () => {};
  const seen = new Map();
  let expectedTotal = null,
    perPage = null,
    page = 1;
  while (true) {
    const result = await readAPI(
      "/api/index/Study.StudyHour/myStudyList",
      { page, limit: 100, schoolyearid: year.schoolyearid },
      quiet,
      requestRetries,
    );
    const p = result.data,
      count = number(p?.total),
      size = number(p?.per_page),
      current = number(p?.current_page);
    if (
      !Array.isArray(p?.data) ||
      !Number.isInteger(count) ||
      count < 0 ||
      !Number.isInteger(size) ||
      size < 1 ||
      current !== page
    )
      throw new Error("已学列表分页数据不完整");
    if (p.data.length !== Math.min(size, Math.max(0, count - (page - 1) * size)))
      throw new Error("已学列表分页缺少数据");
    if (expectedTotal === null) {
      expectedTotal = count;
      perPage = size;
    } else if (count !== expectedTotal || size !== perPage)
      throw new Error("统计时列表发生变化，请重新统计");
    for (const row of p.data) {
      const id = row.courseid == null ? "" : String(row.courseid).trim();
      const hours = number(row.period),
        category = String(row.coursetype_text || "").trim();
      if (!id || !Number.isFinite(hours) || hours < 0)
        throw new Error("已学列表缺少课程 ID 或学时");
      const old = seen.get(id);
      if (old && (old.hours !== hours || old.category !== category))
        throw new Error("同一课程在列表中的学时或类别不一致");
      seen.set(id, { hours, category });
    }
    if (page * size >= count) break;
    if (!p.data.length || page >= 200) throw new Error("已学列表分页未正常结束");
    page++;
    await sleep(1500);
  }
  if ((await accountScope()) !== scope) throw new Error("平台账户已变化，请重新统计");
  const result = {
    scope,
    year: year.yeartitle.trim(),
    total: 0,
    professional: 0,
    industry: 0,
    general: 0,
    other: 0,
    unknownCount: 0,
    count: seen.size,
    ids: [...seen.keys()],
  };
  for (const { hours, category } of seen.values()) {
    result.total += hours;
    if (category === "专业课程") result.professional += hours;
    else if (category === "行业公需") result.industry += hours;
    else if (category === "一般公需") result.general += hours;
    else {
      result.other += hours;
      result.unknownCount++;
    }
  }
  for (const key of ["total", "professional", "industry", "general", "other"])
    result[key] = round(result[key]);
  if (result.unknownCount) throw new Error("列表含未识别类别，无法合并分类学时");
  return result;
}

// Official confirmed totals are intentionally independent of the learned list.
export function readConfirmedHours(data) {
  const study = Array.isArray(data?.data?.study) ? data.data.study : [];
  const totals = study.filter((item) => String(item.typeid) === "0");
  const total = totals.length === 1 ? number(totals[0].s) : NaN;
  if (!Number.isFinite(total) || total < 0)
    throw new Error("暂时无法读取年度学时，可点击刷新或到学时管理系统查看");
  const categories = study.filter((item) => String(item.typeid) !== "0");
  const byName = (name) => categories.filter((item) => String(item.coursetype).trim() === name);
  const professional = byName("专业课程"),
    industry = byName("行业公需"),
    general = byName("一般公需");
  const valid = (row) =>
    row.length === 1 && Number.isFinite(number(row[0].s)) && number(row[0].s) >= 0;

  const snapshot =
    valid(professional) && valid(industry) && valid(general)
      ? {
          total,
          professional: number(professional[0].s),
          industry: number(industry[0].s),
          general: number(general[0].s),
          public: number(industry[0].s) + number(general[0].s),
        }
      : null;
  return { total, snapshot };
}
