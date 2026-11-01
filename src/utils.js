import { PREFIX } from "./constants.js";
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const log = (message, detail) =>
  console.info(PREFIX, new Date().toLocaleTimeString(), message, detail ?? "");
export const visible = (el) =>
  !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
export const text = (el) => (el?.textContent || "").replace(/\s+/g, "").trim();
export const number = (value) =>
  value !== null && value !== "" && value !== undefined && Number.isFinite(Number(value))
    ? Number(value)
    : NaN;
export const round = (n) => Number(n.toFixed(3));
