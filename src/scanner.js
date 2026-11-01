import {
  usesAnnual,
  projectProgress,
  annualDeficits,
  parsePage,
  normalizeCourse,
} from "./planner.js";
import { number, sleep, log } from "./utils.js";
export function createScanner({
  repository,
  readAPI,
  status,
  getBase,
  getPending,
  rebuild,
  render,
}) {
  const { state: store, identity, blocked, save } = repository;
  const annualProgress = () => ({
    total: getBase().total,
    professional: getBase().professional,
    public: getBase().public,
  });
  function neededCategory(s) {
    if (s.category !== "auto") return s.category;
    if (!usesAnnual(s) || !getBase()) return "all";
    const projected = projectProgress(
      annualProgress(),
      s.targetMode === "absolute" ? getPending() : [],
    );
    const deficits = annualDeficits(s, projected),
      categories = [];
    if (s.targetMode === "absolute" && deficits.professional <= 0 && deficits.public <= 0)
      return "all";
    if (deficits.professional > 0) categories.push("专业课程");
    if (deficits.public > 0) categories.push("行业公需");
    if (deficits.public > 0 || (s.targetMode !== "absolute" && deficits.generalExtra > 0))
      categories.push("一般公需");
    if (!categories.length) return "all";
    const last = categories.indexOf(store.cache?.lastFilter),
      scans = store.cache?.categoryScans || {};
    for (let i = 1; i <= categories.length; i++) {
      const name = categories[(last + i) % categories.length],
        scan = scans[name];
      if (!scan?.exhausted || scan.staged?.length) return name;
    }
    return categories[0];
  }
  function scanFor(s, initialize = false) {
    const category = neededCategory(s);
    if (category === "all") return { category, scan: store.cache };
    const existing = store.cache.categoryScans?.[category];
    if (existing) return { category, scan: existing };
    const scan = {
      nextPage: 1,
      exhausted: false,
      seen: [],
      signatures: [],
      staged: [],
      stagedPages: [],
      lastPages: [],
    };
    if (initialize) {
      store.cache.categoryScans ||= {};
      store.cache.categoryScans[category] = scan;
    }
    return { category, scan };
  }
  const hasMore = (s) => {
    if (!store.cache) return true;
    const { scan } = scanFor(s);
    return !scan.exhausted || scan.staged.length > 0;
  };
  async function readBatch(s, maxRequests = 5, mineContext = null) {
    if ((await identity()) !== store.scope) throw new Error("登录凭据已变化，请刷新主面板重新规划");
    // 学习中心只查一页；完整历史由用户手动触发同步。
    const mineData =
      mineContext?.data || (await readAPI("/api/index/Course/index", { page: 1, limit: 100 }));
    if (mineContext) mineContext.data = mineData;
    const minePage = parsePage(mineData, "data", 1);
    const mine = new Map(minePage.rows.map((row) => [String(row.courseid), row]));
    for (const row of minePage.rows) {
      if (number(row.coursetimes) > 0 && number(row.validstudytime) >= number(row.coursetimes)) {
        const id = String(row.courseid);
        if (!store.records[id])
          store.records[id] = {
            id,
            name: row.coursename,
            kind: "platform",
            at: Date.now(),
          };
      }
    }
    store.cache.coverage = `${minePage.rows.length}/${minePage.total}`;
    let { category, scan } = scanFor(s, true),
      budget = Math.max(0, maxRequests - scan.stagedPages.length);
    if (category !== "all" && !store.cache.typeMap) {
      status("读取平台课程类别…");
      const metadata = await readAPI("/api/index/index/SelectCourse", {
        page: 1,
        limit: 1,
      });
      budget--;
      if (!Array.isArray(metadata.type)) throw new Error("平台没有返回课程类别，无法按类别筛选");
      const map = {};
      for (const name of ["专业课程", "行业公需", "一般公需"]) {
        const matches = metadata.type.filter(
          (x) =>
            String(x.coursetype || "").trim() === name &&
            x.typeid !== null &&
            x.typeid !== undefined,
        );
        if (matches.length !== 1 || !String(matches[0].typeid).trim())
          throw new Error(`无法确定平台课程类别：${name}`);
        map[name] = matches[0].typeid;
      }
      if (new Set(Object.values(map).map(String)).size !== 3)
        throw new Error("平台返回的课程类别 ID 重复");
      store.cache.typeMap = map;
      save();
      if (budget <= 0) return false;
    }
    const seen = new Set(scan.seen),
      signatures = new Set(scan.signatures);
    let used = 0;
    for (let count = 0; count < budget && !scan.exhausted; count++) {
      used++;
      const page = scan.nextPage;
      status(`正在读取${category === "all" ? "" : category}第 ${page} 页；正在查找`);
      const body = {
        page,
        limit: 30,
        ...(category === "all" ? {} : { type: store.cache.typeMap[category] }),
      };
      const result = parsePage(
        await readAPI("/api/index/index/SelectCourse", body),
        "course",
        page,
      );
      if (
        category !== "all" &&
        result.rows.some((row) => String(row.coursetype || "").trim() !== category)
      )
        throw new Error(`平台返回了其他课程类别，暂停${category}筛选`);
      if (result.rows.length && signatures.has(result.signature))
        throw new Error("接口重复返回相同课程页，已停止读取");
      if (result.rows.length) {
        signatures.add(result.signature);
        scan.signatures.push(result.signature);
      }
      for (const row of result.rows) {
        const id = String(row.courseid);
        if (!seen.has(id)) {
          scan.staged.push(row);
          seen.add(id);
          scan.seen.push(id);
        }
      }
      scan.stagedPages.push(page);
      scan.nextPage = page + 1;
      scan.exhausted = result.exhausted;
      save(["cache"]);
      if (count < budget - 1 && !scan.exhausted) await sleep(1500);
    }
    const candidates = [];
    for (const row of scan.staged) {
      const id = String(row.courseid),
        studied = mine.get(id);
      if (blocked(id)) continue;
      const merged = {
        ...row,
        ...studied,
        coursetype: row.coursetype || studied?.coursetype,
      };
      const course = normalizeCourse(merged, studied || null);
      if (course && !course.excludedExam) candidates.push(course);
    }
    const pool = new Map(store.cache.pending.map((course) => [course.id, course]));
    for (const course of candidates) pool.set(course.id, course);
    store.cache.pending = [...pool.values()];
    scan.lastPages = [...scan.stagedPages];
    scan.staged = [];
    scan.stagedPages = [];
    store.cache.lastFilter = category;
    store.cache.lastFilteredPages = [...scan.lastPages];
    save();
    rebuild(s);
    render();
    log("批次读取完成", {
      category,
      pages: scan.lastPages,
      candidates: getPending().length,
      nextPage: scan.nextPage,
      historyCoverage: store.cache.coverage,
    });
    const remaining = budget - used;
    if (!getPending().length && remaining > 0 && hasMore(s) && neededCategory(s) !== category) {
      await readBatch(s, remaining, mineContext);
    }
    return used > 0;
  }
  return { scanFor, hasMore, readBatch };
}
