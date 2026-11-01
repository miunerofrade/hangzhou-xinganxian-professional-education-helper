import { number } from "./utils.js";
import { recordEvent } from "./event-log.js";
export function createHistorySync({
  state,
  repository,
  readAPI,
  panel,
  rebuild,
  settings,
  render,
}) {
  const { state: store, ensureCache, save, blocked } = repository;
  const { $, status } = panel;
  const progress = (message) => {
    $("#history-progress").textContent = message;
  };
  return async () => {
    if (state.historyBusy) return;
    // History is a read task, independent of playback and the scheduler lock.
    state.historyBusy = true;
    $("#sync-history").disabled = true;
    $("#sync-history").textContent = "正在同步平台已学…";
    let read = 0,
      added = 0;
    try {
      await ensureCache();
      progress("正在读取平台学年列表…");
      const initial = await readAPI(
        "/api/index/Study.StudyHour/myStudyList",
        { page: 1, limit: 1 },
        progress,
      );
      const years = (Array.isArray(initial.year) ? initial.year : [])
        .filter((y) => y.schoolyearid !== undefined && y.schoolyearid !== null)
        .map((y) => ({
          id: String(y.schoolyearid),
          title: String(y.yeartitle || y.schoolyearid),
        }));
      if (!years.length) throw new Error("平台未返回学年列表，无法为记录确定学年");
      await ensureCache();
      store.historyYears = years;
      store.historySynced = false;
      save(["history"]);
      for (const [index, year] of years.entries()) {
        const prefix = `同步 ${year.title}（${index + 1}/${years.length} 学年）`;
        for (let page = 1; page <= 200; page++) {
          progress(`${prefix}；正在读取第 ${page} 页；已读取 ${read} 条，新增 ${added} 条`);
          const data = await readAPI(
            "/api/index/Study.StudyHour/myStudyList",
            { page, limit: 100, schoolyearid: year.id },
            (message) => progress(`${prefix}；第 ${page} 页；${message}`),
          );
          const pager = data.data,
            rows = pager?.data,
            total = number(pager?.total),
            size = number(pager?.per_page ?? data.per_page),
            current = number(pager?.current_page ?? data.current_page);
          if (
            !Array.isArray(rows) ||
            !Number.isInteger(total) ||
            total < 0 ||
            !Number.isInteger(size) ||
            size < 1 ||
            current !== page
          )
            throw new Error("学习记录分页结构未匹配，已保存成功读取的记录");
          if (rows.length !== Math.min(size, Math.max(0, total - (page - 1) * size)))
            throw new Error("学习记录分页缺少数据，已保存成功读取的记录");
          // Check identity again before committing a response received in the background.
          await ensureCache();
          const map = new Map(store.history.map((item) => [`${item.yearId}\0${item.id}`, item]));
          let pageAdded = 0;
          for (const row of rows) {
            if (row.courseid === undefined || row.courseid === null || !String(row.courseid).trim())
              throw new Error("学习记录缺少课程ID，已停止读取");
            const id = String(row.courseid),
              key = `${year.id}\0${id}`;
            if (!map.has(key)) pageAdded++;
            map.set(key, {
              id,
              name: String(row.coursename || id),
              yearId: year.id,
              yearTitle: year.title,
              examtype: row.examtype == null ? null : String(row.examtype),
            });
          }
          store.history = [...map.values()];
          store.historyIds = new Set(store.history.map((item) => String(item.id)));
          store.cache.pending = store.cache.pending.filter((c) => !blocked(c.id));
          save(["cache", "history"]);
          read += rows.length;
          added += pageAdded;
          progress(
            `${prefix}；已读取第 ${page}/${Math.max(1, Math.ceil(total / size))} 页；已读取 ${read} 条，新增 ${added} 条`,
          );
          recordEvent(
            "history",
            "已学同步进度",
            `${year.title}；第 ${page} 页；本页 ${rows.length} 条；累计 ${read} 条，新增 ${added} 条`,
          );
          if (page * size >= total) break;
          if (!rows.length || page === 200)
            throw new Error("学习记录分页未正常结束，已保存已读取记录");
          // Sequential network requests provide pacing; no timer between empty years.
        }
      }
      store.historySynced = true;
      save(["history"]);
      const message = `已读取 ${read} 条学习记录；新增 ${added} 条；本地共 ${store.history.length} 条，已学课程已过滤`;
      progress(message);
      recordEvent("history", "已学同步完成", message);
    } catch (error) {
      const message = `已学同步未完成：${error.message}；已读取 ${read} 条，新增 ${added} 条`;
      progress(message);
      recordEvent("error", "已学同步失败", message);
      // A failed history read must not pause a playing course or its controller.
      if (!state.active) status(message);
    } finally {
      rebuild(state.planSettings || settings());
      render();
      $("#start").disabled = !state.active && !state.pending.length && !state.current;
      state.historyBusy = false;
      $("#sync-history").disabled = false;
      $("#sync-history").textContent = "同步平台已学";
    }
  };
}
