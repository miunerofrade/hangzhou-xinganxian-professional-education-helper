// Completion evidence is checked by callers; this is the shared bookkeeping step.
export function createCompletionHandler({ state, store, finished, save }) {
  function markComplete(task, source) {
    finished.add(task.course.id);
    if (!store.cache.completed.includes(task.course.id)) store.cache.completed.push(task.course.id);
    store.records[task.course.id] = {
      id: task.course.id,
      name: task.course.name,
      kind: "complete",
      ...(source ? { source } : {}),
      at: Date.now(),
      course: task.course,
    };
    task.complete = true;
    if (state.heartbeatPaused && !state.manualPaused) {
      state.paused = false;
      state.heartbeatPaused = false;
    }
    save();
  }
  return markComplete;
}
