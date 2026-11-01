// Compare against storage rather than an in-memory cache: another tab may have written it.
export function writeJSON(key, value, storage = localStorage) {
  const encoded = JSON.stringify(value);
  if (storage.getItem(key) === encoded) return false;
  storage.setItem(key, encoded);
  return true;
}
// Old releases persisted the same platform period as both credits and hours.
export function migrateCourse(course) {
  const { credits, ...rest } = course;
  return { ...rest, hours: Number(course.hours ?? credits) };
}
export function readLog(key) {
  try {
    const rows = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}
export function appendLog(key, row, limit = 30) {
  const rows = readLog(key);
  rows.push(row);
  writeJSON(key, rows.slice(-limit));
}
