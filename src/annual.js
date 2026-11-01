import { createAnnualView } from "./annual-view.js";
import { readLearnedHours, readConfirmedHours } from "./annual-data.js";
import { estimateStorageKey, saveLearnedEstimate } from "./annual-storage.js";
import { createAnnualQueries } from "./annual-query.js";
import { recordEvent } from "./event-log.js";
import { sleep, log } from "./utils.js";
export { estimateStorageKey } from "./annual-storage.js";
export function createAnnualService({ $, status, readAPI, accountScope, channel, panel }) {
  const { readMetadata } = createAnnualQueries({ readAPI, accountScope });
  let annualBusy = false,
    annualLoaded = false,
    annualSnapshot = null,
    annualYear = "",
    learnedSnapshot = null,
    learnedBusy = false,
    onEstimateUpdated = async () => {},
    learnedTask = null;
  const { updateEstimatedPanel, showAnnualGoals, showConfirmedHours } = createAnnualView($);
  function loadAnnualGoals(scope) {
    try {
      showAnnualGoals(JSON.parse(localStorage.getItem(`hz-helper-settings-v1:${scope}`) || "{}"));
    } catch {
      showAnnualGoals();
    }
  }
  async function refreshAnnual(refreshContext = null) {
    if (annualBusy) return;
    annualBusy = true;
    annualSnapshot = null;
    annualYear = "";
    $("#annual-breakdown").textContent = "";
    $("#annual-total").textContent = "—";
    $("#annual-year").textContent = "正在读取平台学年…";
    try {
      const scope = await accountScope();
      loadAnnualGoals(scope);
      const quietRetry = () => {};
      const managementRequest = readAPI("/api/index/Study.UserIndex/index", {}, quietRetry)
        .then(async (data) => {
          if ((await accountScope()) !== scope) throw new Error("平台账户已变化，请刷新页面");
          const confirmed = readConfirmedHours(data);
          annualSnapshot = confirmed.snapshot;
          showConfirmedHours(confirmed);
        })
        .catch((error) => {
          status(error.message);
        });
      const yearRequest = readMetadata(scope, 3, refreshContext)
        .then(async (data) => {
          if ((await accountScope()) !== scope) throw new Error("平台账户已变化，请刷新页面");
          const first = Array.isArray(data?.year) ? data.year[0] : null;
          const title =
            typeof first?.yeartitle === "string" && first.yeartitle.trim()
              ? first.yeartitle.trim()
              : "";
          annualYear = title;
          $("#annual-year").textContent = title
            ? `平台默认学年：${title}`
            : "平台默认学年：未能读取";
        })
        .catch(() => {
          $("#annual-year").textContent = "平台默认学年：未能读取";
        });
      await Promise.allSettled([managementRequest, yearRequest]);
      let saved = null;
      try {
        saved = JSON.parse(localStorage.getItem(estimateStorageKey(scope)) || "null");
      } catch {}
      if (saved?.year === annualYear && saved.source === "已学列表") updateEstimatedPanel(saved);
      else updateEstimatedPanel(null);
      annualLoaded = true;
    } catch (error) {
      $("#annual-year").textContent = "平台默认学年：未能读取";
      status(error.message);
    } finally {
      annualBusy = false;
    }
  }
  function calculateLearned(fresh = false, requestRetries = 3, refreshContext = null) {
    if (learnedTask)
      return fresh ? learnedTask.then(() => calculateLearned(false, requestRetries)) : learnedTask;
    learnedTask = calculateLearnedNow(requestRetries, refreshContext).finally(() => {
      learnedTask = null;
    });
    return learnedTask;
  }
  async function calculateLearnedNow(requestRetries = 3, refreshContext = null) {
    learnedBusy = true;
    $("#learned-summary").textContent = "";
    try {
      const scope = await accountScope();
      loadAnnualGoals(scope);
      const initial = await readMetadata(scope, requestRetries, refreshContext);
      const year = Array.isArray(initial.year) ? initial.year[0] : null;
      if (
        year?.schoolyearid === null ||
        year?.schoolyearid === undefined ||
        typeof year.yeartitle !== "string" ||
        !year.yeartitle.trim()
      )
        throw new Error("平台未返回默认学年");
      const result = await readLearnedHours({ readAPI, accountScope, scope, year, requestRetries });
      if (annualYear && annualYear !== result.year)
        throw new Error("平台默认学年已变，请刷新后重试");
      annualYear = result.year;
      $("#annual-year").textContent = `平台默认学年：${result.year}`;
      const saved = saveLearnedEstimate(scope, result);
      learnedSnapshot = result;
      updateEstimatedPanel(saved);
      await onEstimateUpdated(scope, saved);
      channel.postMessage({
        type: "estimate-updated",
        scope,
        year: result.year,
      });
      $("#learned-summary").textContent = "";
      log("已学列表合计", {
        year: result.year,
        count: result.count,
        total: result.total,
      });
      return result;
    } catch (error) {
      $("#learned-summary").textContent = `已学列表统计失败：${error.message}`;
      recordEvent("error", "已学列表统计失败", String(error.message || "未知错误"));
      log("已学列表统计失败", error.message);
      return null;
    } finally {
      learnedBusy = false;
    }
  }
  async function refreshLearnedInBackground() {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) {
        recordEvent("warning", "已学列表查询重试", `第 ${attempt}/3 次重试`);
        await sleep([5000, 10000, 20000][attempt - 1]);
      }
      const result = await calculateLearned(true, 0);
      if (result) return result;
    }
    $("#learned-summary").textContent = "已学列表查询失败，重试 3 次后仍未成功；可点击刷新";
    log("后台查询已学列表失败，已重试 3 次");
    return null;
  }
  let refreshTask = null;
  function refreshAll() {
    if (refreshTask) return refreshTask;
    recordEvent("refresh", "刷新学时", "同步平台确认值与默认学年已学列表");
    $("#refresh-annual").disabled = true;
    refreshTask = (async () => {
      const refreshContext = {};
      await refreshAnnual(refreshContext);
      return await calculateLearned(true, 3, refreshContext);
    })().finally(() => {
      refreshTask = null;
      $("#refresh-annual").disabled = false;
    });
    return refreshTask;
  }
  $("#refresh-annual").onclick = refreshAll;
  panel.onPanelOpened = () => {
    if (!annualLoaded || !learnedSnapshot) void refreshAll();
  };

  return {
    refreshAnnual,
    calculateLearned,
    refreshLearnedInBackground,
    showAnnualGoals,
    get annualBusy() {
      return annualBusy;
    },
    set annualBusy(value) {
      annualBusy = value;
    },
    get annualLoaded() {
      return annualLoaded;
    },
    set annualLoaded(value) {
      annualLoaded = value;
    },
    get annualSnapshot() {
      return annualSnapshot;
    },
    set annualSnapshot(value) {
      annualSnapshot = value;
    },
    get annualYear() {
      return annualYear;
    },
    set annualYear(value) {
      annualYear = value;
    },
    get learnedSnapshot() {
      return learnedSnapshot;
    },
    set learnedSnapshot(value) {
      learnedSnapshot = value;
    },
    get learnedBusy() {
      return learnedBusy;
    },
    set learnedBusy(value) {
      learnedBusy = value;
    },
    get refreshTask() {
      return refreshTask;
    },
    set refreshTask(value) {
      refreshTask = value;
    },
    get onEstimateUpdated() {
      return onEstimateUpdated;
    },
    set onEstimateUpdated(value) {
      onEstimateUpdated = value;
    },
  };
}
