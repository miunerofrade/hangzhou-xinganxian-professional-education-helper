// Independent operation flags remain separate from user playback intent.
// 暂停意图与各项异步操作的并发状态分别维护。
export const createControllerState = () => ({
  pending: [],
  active: false,
  paused: true,
  busy: false,
  starting: false,
  historyBusy: false,
  catalogBusy: false,
  completing: false,
  acquired: false,
  release: null,
  current: null,
  child: null,
  total: 0,
  roundStart: null,
  lastHeartbeat: 0,
  missingSince: 0,
  planSettings: null,
  roundDone: false,
  annualBase: null,
  searching: false,
  cancelSearch: false,
  heartbeatPaused: false,
  manualPaused: false,
  recovering: false,
  probe: "",
});
export function pausePlan(state, dueToHeartbeat = false) {
  if (state.searching) state.cancelSearch = true;
  state.paused = true;
  state.heartbeatPaused = dueToHeartbeat;
  state.manualPaused = !dueToHeartbeat;
}
export function pauseFromWorker(state, manual) {
  state.manualPaused = state.manualPaused || manual;
  state.paused = true;
  state.heartbeatPaused = !state.manualPaused;
}
export function resumeFromWorker(state) {
  state.paused = false;
  state.heartbeatPaused = false;
  state.manualPaused = false;
}
export function finishRound(state) {
  state.active = false;
  state.paused = true;
  state.roundDone = true;
}
export const canSchedule = (state) =>
  state.active &&
  ![state.paused, state.busy, state.catalogBusy, state.completing, state.recovering].some(Boolean);
