// Build-time-only hooks; this module is never included in the installable script.
export function installDebugHooks(env, readAPI) {
  env.testHooks = {};
  globalThis.__hzTest = { env, readAPI };
}
export function bindDebugHooks(env, hooks) {
  env.testHooks.controller = hooks;
}
