import { PERSISTED_SETTING_IDS, isCheckboxSetting } from "./settings-schema.js";
import { writeJSON, migrateCourse } from "./storage.js";
import { estimateStorageKey } from "./annual.js";
export function createRepository({ panel, accountScope, accountDigest }) {
  const { $ } = panel;
  const state = {
    cache: null,
    scope: "",
    records: Object.create(null),
    history: [],
    historyYears: [],
    historyIds: new Set(),
    historySynced: false,
  };
  const store = state;
  const CACHE_KEY = "hz-helper-batches-v2";
  const blankCache = (identity) => ({
    version: 2,
    scope: identity,
    nextPage: 1,
    exhausted: false,
    seen: [],
    completed: [],
    pending: [],
    staged: [],
    stagedPages: [],
    signatures: [],
    lastPages: [],
    coverage: "",
  });
  const durableKey = () => `hz-helper-batches-v3:${store.scope}`;
  const recordsKey = () => `hz-helper-records-v1:${store.scope}`;
  const historyKey = () => `hz-helper-history-v1:${store.scope}`;
  const estimateKey = () => estimateStorageKey(store.scope);
  const settingsKey = () => `hz-helper-settings-v1:${store.scope}`;

  const saveSettings = () => {
    if (store.scope)
      writeJSON(
        settingsKey(),
        Object.fromEntries(
          PERSISTED_SETTING_IDS.map((id) => [
            id,
            isCheckboxSetting(id) ? $("#" + id).checked : $("#" + id).value,
          ]),
        ),
      );
  };

  const blocked = (id) =>
    !!store.records[id] ||
    store.historyIds.has(String(id)) ||
    !!store.cache?.completed.includes(id);
  const save = (parts = ["cache", "records"]) => {
    if (!store.cache || !store.scope) return;
    if (parts.includes("cache")) writeJSON(durableKey(), store.cache);
    if (parts.includes("records")) writeJSON(recordsKey(), store.records);
    if (parts.includes("history"))
      writeJSON(historyKey(), {
        years: store.historyYears,
        items: store.history,
        synced: store.historySynced,
      });
  };
  const digest = accountDigest;
  const identity = accountScope;
  async function ensureCache() {
    const value = await identity();
    if (store.scope && store.scope !== value)
      throw new Error("平台账户已变化，请关闭课页并刷新面板");
    if (store.cache) return;
    store.scope = value;
    try {
      const storedSettings = JSON.parse(localStorage.getItem(settingsKey()) || "null");
      if (storedSettings && typeof storedSettings === "object")
        for (const id of PERSISTED_SETTING_IDS) {
          const v = storedSettings[id];
          if (isCheckboxSetting(id) && typeof v === "boolean") $("#" + id).checked = v;
          else if (typeof v === "string") $("#" + id).value = v;
        }
    } catch {}
    try {
      const storedRecords = JSON.parse(localStorage.getItem(recordsKey()) || "{}");
      store.records = Object.assign(
        Object.create(null),
        storedRecords && typeof storedRecords === "object" && !Array.isArray(storedRecords)
          ? storedRecords
          : {},
      );
    } catch {
      store.records = Object.create(null);
    }
    try {
      const savedHistory = JSON.parse(localStorage.getItem(historyKey()) || "null");
      if (Array.isArray(savedHistory?.years) && Array.isArray(savedHistory?.items)) {
        store.historyYears = savedHistory.years;
        store.history = savedHistory.items;
        store.historyIds = new Set(store.history.map((item) => String(item.id)));
        store.historySynced = savedHistory.synced === true;
      }
    } catch {
      store.historyYears = [];
      store.history = [];
      store.historyIds = new Set();
      store.historySynced = false;
    }
    try {
      let saved = JSON.parse(localStorage.getItem(durableKey()) || "null");
      if (!saved) {
        const legacy = JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null");
        const tokenScope = await digest(localStorage.getItem("front_token"));
        if (legacy?.scope === tokenScope || legacy?.scope === store.scope)
          saved = { ...legacy, scope: store.scope };
      }
      store.cache =
        saved?.version === 2 && saved.scope === store.scope ? saved : blankCache(store.scope);
      if (
        !Number.isSafeInteger(store.cache.nextPage) ||
        store.cache.nextPage < 1 ||
        !["seen", "completed", "pending", "staged", "stagedPages", "signatures", "lastPages"].every(
          (key) => Array.isArray(store.cache[key]),
        )
      )
        throw new Error("cache");
    } catch {
      store.cache = blankCache(store.scope);
    }
    if (!store.cache.yearAwareHistory) {
      // 旧平台导入没有学年，过去可能已从候选池剔除；重新开放扫描，不删除用户手动记录。
      if (Object.values(store.records).some((r) => r.kind === "platform")) {
        store.cache.nextPage = 1;
        store.cache.exhausted = false;
        store.cache.seen = [];
        store.cache.signatures = [];
        store.cache.staged = [];
        store.cache.stagedPages = [];
        store.cache.lastPages = [];
        store.cache.pending = store.cache.pending.map((c) => ({
          ...c,
          learned: 0,
          remaining: c.duration,
        }));
      }
      store.cache.yearAwareHistory = true;
    }
    for (const id of store.cache.completed)
      if (!store.records[id])
        store.records[id] = { id, name: id, kind: "complete", at: Date.now() };
    if (store.cache.frameAdapterVersion !== 2) {
      for (const [id, record] of Object.entries(store.records)) {
        if (record.kind !== "auto-excluded" || record.reason !== "iframe 课件") continue;
        delete store.records[id];
        if (
          record.course &&
          !store.historyIds.has(String(id)) &&
          !store.cache.completed.includes(id) &&
          !store.cache.pending.some((course) => course.id === id)
        )
          store.cache.pending.push(record.course);
      }
      store.cache.frameAdapterVersion = 2;
    }
    store.cache.pending = store.cache.pending.map(migrateCourse).filter((c) => !blocked(c.id));
    save(["cache", "records", "history"]);
  }

  return {
    state,
    CACHE_KEY,
    blankCache,
    estimateKey,
    saveSettings,
    blocked,
    save,
    identity,
    ensureCache,
  };
}
