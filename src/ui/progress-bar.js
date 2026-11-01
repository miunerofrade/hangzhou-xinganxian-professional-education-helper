// Shared markup and value handling. Callers own the meaning of each percentage.
export function progressBar({ trackId, fillId, label }) {
  return `<div id="${trackId}" class="progress-track" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100"><div id="${fillId}" class="progress-fill"></div></div>`;
}
export function renderProgressBar(track, fill, percent, emptyText = "尚未取得进度") {
  const value = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
  fill.style.width = `${value ?? 0}%`;
  if (value === null) {
    track.removeAttribute("aria-valuenow");
    track.setAttribute("aria-valuetext", emptyText);
  } else {
    track.setAttribute("aria-valuenow", String(value));
    track.removeAttribute("aria-valuetext");
  }
  return value;
}
