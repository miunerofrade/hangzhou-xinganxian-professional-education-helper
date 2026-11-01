import { number, round } from "./utils.js";
export const estimateStorageKey = (scope) => `hz-helper-annual-estimate-v1:${scope}`;
export function saveLearnedEstimate(scope, result) {
  const priorRaw = localStorage.getItem(estimateStorageKey(scope));
  const legacyKey = `hz-helper-legacy-estimate-v1:${scope}`;
  if (priorRaw && !localStorage.getItem(legacyKey)) {
    try {
      const prior = JSON.parse(priorRaw);
      if (number(prior.total) > 0 || (Array.isArray(prior.entries) && prior.entries.length))
        localStorage.setItem(legacyKey, priorRaw);
    } catch {}
  }
  const saved = {
    year: result.year,
    base: {
      total: result.total,
      professional: result.professional,
      industry: result.industry,
      general: result.general,
      public: round(result.industry + result.general),
    },
    source: "已学列表",
  };
  localStorage.setItem(estimateStorageKey(scope), JSON.stringify(saved));
  return saved;
}
