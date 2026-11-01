import { recordEvent } from "./event-log.js";
import { ORIGIN } from "./constants.js";
import { sleep, log } from "./utils.js";
export function createPlatform() {
  const callbacks = {
    onNetworkRetry: (message) => log(message),
    observeAuthResponse: () => {},
  };
  // 只有这五个已在当前公开前端核实的查询接口允许由助手主动请求。
  // 不拦截、不重放、不改写平台的 startPlay/updateStudy/confirmPlay/finishStudy 请求。
  const READ_APIS = new Set([
    "/api/index/Course/index",
    "/api/index/index/SelectCourse",
    "/api/index/index/getCourseInfo",
    "/api/index/Study.StudyHour/myStudyList",
    "/api/index/Study.UserIndex/index",
  ]);
  async function readAPI(path, body, notifyRetry = callbacks.onNetworkRetry, retries = 3) {
    if (!READ_APIS.has(path)) throw new Error("禁止调用未列入查询白名单的接口");
    const token = localStorage.getItem("front_token");
    if (!token) throw new Error("请先在平台登录，再重新预览");
    const delays = [5000, 10000, 20000].slice(0, retries);
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (localStorage.getItem("front_token") !== token)
        throw new Error("登录凭据已变化，停止重试，请刷新重新预览");
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 45000);
      let retryAfter = 0;
      const startedAt = Date.now();
      let http = 0;
      let platform = null;
      try {
        const response = await fetch(ORIGIN + path, {
          method: "POST",
          credentials: "same-origin",
          redirect: "error",
          signal: abort.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        });
        http = response.status;
        if (!response.ok) {
          const error = new Error(`查询失败 HTTP ${response.status}`);
          error.retryable = [408, 429].includes(response.status) || response.status >= 500;
          const hint = response.headers?.get("Retry-After");
          if (hint)
            retryAfter = Math.min(
              60000,
              Math.max(0, Number(hint) * 1000 || Date.parse(hint) - Date.now() || 0),
            );
          throw error;
        }
        const data = await response.json();
        platform = Number.isFinite(Number(data?.status)) ? Number(data.status) : null;
        callbacks.observeAuthResponse(path, response.status, data?.status, "助手查询");
        if (platform !== 200) {
          const reason =
            platform === -1 || platform === 401
              ? "登录已过期或身份验证未通过，请回平台检查"
              : "平台未接受本次查询";
          throw new Error(`${reason}（HTTP ${http}；平台状态 ${platform ?? "缺失"}）`);
        }
        recordEvent(
          "query",
          "查询完成",
          `${path.split("/").at(-1)}；HTTP ${http}；平台状态 ${platform}；${Date.now() - startedAt} ms`,
          {
            path,
            http,
            platform,
            elapsedMs: Date.now() - startedAt,
          },
        );
        return data;
      } catch (error) {
        recordEvent(
          "error",
          "查询失败",
          `${path.split("/").at(-1)}；HTTP ${http}；平台状态 ${platform ?? "未返回"}；${String(error.name || "Error")}；第 ${attempt + 1} 次`,
          { path, http, platform, elapsedMs: Date.now() - startedAt },
        );
        const retryable =
          error.retryable === true ||
          ["TypeError", "AbortError", "SyntaxError"].includes(error.name);
        if (!retryable) throw error;
        if (attempt === delays.length)
          throw new Error(`查询已尝试${attempt + 1}次仍失败，进度已保留；网络恢复后重试`);
        const delay = Math.max(delays[attempt], retryAfter);
        notifyRetry(
          `网络较慢，${Math.ceil(delay / 1000)}秒后重试（${attempt + 1}/3），已读页码保留`,
        );
        recordEvent(
          "query",
          "查询重试",
          `${path.split("/").at(-1)}；${delay / 1000} 秒后重试；第 ${attempt + 1} 次`,
        );
        log("查询重试", {
          path,
          attempt: attempt + 1,
          waitSeconds: delay / 1000,
        });
        // finally 先于下一次请求清理超时；等待期间不再保留旧请求计时器。
        clearTimeout(timeout);
        await sleep(delay);
      } finally {
        clearTimeout(timeout);
      }
    }
  }
  async function accountDigest(value) {
    const result = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  async function accountScope() {
    const token = localStorage.getItem("front_token");
    if (!token) throw new Error("请先在平台登录");
    let user;
    try {
      user = JSON.parse(localStorage.getItem("use_info") || "null");
    } catch {
      /* fallback */
    }
    const key = ["studentid", "userid", "user_id", "id", "studentname"].find(
      (k) => user?.[k] !== undefined && user[k] !== null && String(user[k]).trim(),
    );
    return accountDigest(key ? `${key}:${String(user[key])}` : `session:${token}`);
  }

  return { readAPI, accountScope, accountDigest, callbacks };
}
