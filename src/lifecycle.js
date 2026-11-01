// One explicit owner for listeners, timers and service teardown.
export function createLifecycle() {
  const cleanups = new Set();
  let disposed = false;
  function defer(cleanup) {
    if (disposed) {
      cleanup();
      return () => {};
    }
    cleanups.add(cleanup);
    return () => cleanups.delete(cleanup);
  }
  function on(target, type, handler, options) {
    if (disposed || !target?.addEventListener) return () => {};
    target.addEventListener(type, handler, options);
    const remove = () => target.removeEventListener?.(type, handler, options);
    const forget = defer(remove);
    return () => {
      forget();
      remove();
    };
  }
  function interval(handler, ms) {
    if (disposed) return null;
    const id = setInterval(handler, ms);
    defer(() => clearInterval(id));
    return id;
  }
  function timeout(handler, ms) {
    if (disposed) return null;
    let forget = () => {};
    const id = setTimeout(() => {
      forget();
      if (!disposed) handler();
    }, ms);
    forget = defer(() => clearTimeout(id));
    return id;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const cleanup of [...cleanups].reverse()) {
      try {
        cleanup();
      } catch {
        /* One cleanup must not strand the others. */
      }
    }
    cleanups.clear();
  }
  return {
    on,
    interval,
    timeout,
    defer,
    dispose,
    get disposed() {
      return disposed;
    },
  };
}
