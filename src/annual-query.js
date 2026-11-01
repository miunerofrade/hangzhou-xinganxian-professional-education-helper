// The context belongs to one refreshAll call. Rejections are not reused.
export function createAnnualQueries({ readAPI, accountScope }) {
  async function requestMetadata(scope, retries) {
    const data = await readAPI(
      "/api/index/Study.StudyHour/myStudyList",
      { page: 1, limit: 1 },
      () => {},
      retries,
    );
    if ((await accountScope()) !== scope) throw new Error("平台账户已变化，请刷新页面");
    return data;
  }
  function readMetadata(scope, retries = 3, context = null) {
    if (!context) return requestMetadata(scope, retries);
    if (context.scope === scope && context.promise) return context.promise;
    const promise = requestMetadata(scope, retries);
    context.scope = scope;
    context.promise = promise;
    promise.catch(() => {
      if (context.promise === promise) context.promise = null;
    });
    return promise;
  }
  return { readMetadata };
}
