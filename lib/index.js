/**
 * dsh-plugin-opencode-usage:OpenCode Go 用量悬浮面板(Host 半)。
 *
 * 查询 OpenCode Zen Go 订阅用量接口:
 *
 *   GET https://opencode.ai/zen/go/v1/usage
 *   Authorization: Bearer <OPENCODE_GO_API_KEY>
 *
 * 官方接口按 rolling / weekly / monthly 返回已用百分比与重置时间。由于
 * OpenCode Go 不同模型有不同额度金额,插件只展示百分比,不展示具体美元
 * 金额,避免因模型差异造成误导。
 *
 * API key 通过 Harness credentials seam 解析 `credentialRef`(默认
 * OPENCODE_GO_API_KEY),不经过浏览器。结果经 GET
 * /plugins/opencode-usage/stats 返回,成功结果缓存 30s,失败不缓存。
 *
 * 路由注册跟随 `webServer` 服务实例:服务重新提供(profile patch 重载、HMR)
 * 时自动重新注册,服务撤走时自动注销。
 *
 * 安全:该路由不在 Harness 的 `/api` 前缀下,因此不会被 Host/Origin 栅栏与
 * 浏览器 cookie 鉴权覆盖。0.2.1 及以后提供 `ctx.connection.requestRejection`,
 * 插件用它补上同样的 Host/Origin + 登录校验(DNS rebinding 防护);更早的
 * Harness 没有该 seam,退回仅继承 webserver 绑定地址的原行为。
 *
 * @module dsh-plugin-opencode-usage
 */

export const name = "opencode-usage";
export const inject = ["credentials"];

const DEFAULT_API_BASE_URL = "https://opencode.ai/zen/go/v1";
const DEFAULT_CREDENTIAL_REF = "OPENCODE_GO_API_KEY";
const DEFAULT_CACHE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 12_000;
const ROUTE_PATH = "/plugins/opencode-usage/stats";
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const USAGE_PERIOD_KEYS = ["rolling", "weekly", "monthly"];

function resolveConfig(raw, warn) {
  const config = raw && typeof raw === "object" ? raw : {};
  const report = typeof warn === "function" ? warn : () => {};
  let credentialRef = DEFAULT_CREDENTIAL_REF;
  if (typeof config.credentialRef === "string" && config.credentialRef.trim()) {
    const candidate = config.credentialRef.trim();
    // credentials seam 的引用名是 POSIX shell 标识符;不合法的名字永远解析不到,
    // 在这里退回默认值并留一条 host 日志,比运行时静默 500 更好排查。
    if (CREDENTIAL_REF_PATTERN.test(candidate)) {
      credentialRef = candidate;
    } else {
      report(
        `ignoring invalid credentialRef ${JSON.stringify(candidate)} (expected a POSIX shell identifier); using ${DEFAULT_CREDENTIAL_REF}`,
      );
    }
  }
  return {
    apiBaseUrl:
      typeof config.apiBaseUrl === "string" && config.apiBaseUrl.trim()
        ? config.apiBaseUrl.replace(/\/+$/, "")
        : DEFAULT_API_BASE_URL,
    credentialRef,
    cacheMs:
      Number.isFinite(config.cacheMs) && config.cacheMs >= 1000
        ? config.cacheMs
        : DEFAULT_CACHE_MS,
  };
}

/** 带机器可读 code 的错误:handler 靠它区分「没配 key」和「上游失败」。 */
function usageError(message, code, status) {
  const error = new Error(message);
  if (code !== void 0) error.code = code;
  if (status !== void 0) error.status = status;
  return error;
}

async function resolveApiKey(ctx, ref) {
  const resolved = await ctx.credentials.resolve(ref);
  if (!resolved || typeof resolved.value !== "string" || resolved.value.length === 0) {
    throw usageError(
      `credential "${ref}" is not configured`,
      "credential_not_configured",
    );
  }
  return resolved.value;
}

function truncateErrorBody(body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  if (!text) return "";
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

async function fetchUsage(apiBaseUrl, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${apiBaseUrl}/usage`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
      },
      signal: controller.signal,
      cache: "no-store",
    });
    const body = await response.text();
    if (!response.ok) {
      throw usageError(
        `usage API returned HTTP ${response.status}: ${truncateErrorBody(body)}`,
        "upstream_error",
        response.status,
      );
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw usageError("usage API returned invalid JSON", "upstream_error");
    }
    const usage = payload?.usage;
    if (!usage || typeof usage !== "object") {
      throw usageError('usage API response is missing "usage"', "upstream_error");
    }
    return usage;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 单个窗口的百分比投影。缺失或非法时返回 null 而不是抛错:上游偶尔只回
 * 部分窗口,整体 500 会让本来能显示的两个窗口一起消失。
 */
function projectPeriod(key, raw) {
  const entry = raw && typeof raw === "object" ? raw : null;
  const percent =
    entry && typeof entry.percent === "number" && Number.isFinite(entry.percent)
      ? Math.min(100, Math.max(0, entry.percent))
      : null;
  if (percent === null) return null;
  return {
    key,
    status: typeof entry.status === "string" ? entry.status : "unknown",
    percent,
    remainingPercent: Math.max(0, Math.min(100, 100 - percent)),
    resetsAt: typeof entry.resetsAt === "string" ? entry.resetsAt : null,
  };
}

async function collectUsage(ctx, config) {
  const apiKey = await resolveApiKey(ctx, config.credentialRef);
  const usage = await fetchUsage(config.apiBaseUrl, apiKey);
  const periods = {};
  for (const key of USAGE_PERIOD_KEYS) {
    const period = projectPeriod(key, usage[key]);
    if (period !== null) periods[key] = period;
  }
  if (Object.keys(periods).length === 0) {
    throw usageError("usage API returned no usable periods", "upstream_error");
  }
  return {
    ok: true,
    provider: "opencode-go",
    generatedAt: Date.now(),
    periods,
  };
}

async function collectCached(ctx, config, cache) {
  const hit = cache.value;
  if (hit && Date.now() - cache.at < config.cacheMs) return hit;
  // 并发面板/重试共用一次上游请求;只缓存成功结果,失败下次照常重试。
  if (cache.pending !== null) return cache.pending;
  const pending = collectUsage(ctx, config).then(
    (value) => {
      cache.at = Date.now();
      cache.value = value;
      return value;
    },
  ).finally(() => {
    cache.pending = null;
  });
  cache.pending = pending;
  return pending;
}

/** 路由未命中之前的 Host/Origin 与登录校验;老 Harness 没有该 seam 时跳过。 */
function requestRejected(ctx, req, res) {
  const connection = ctx.get("connection");
  if (!connection || typeof connection.requestRejection !== "function") return false;
  const rejection = connection.requestRejection(req);
  if (rejection === void 0) return false;
  res.writeHead(rejection);
  res.end();
  return true;
}

function sendJson(req, res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(req.method === "HEAD" ? void 0 : body);
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig, (message) => {
    ctx.logger?.warn?.(`opencode-usage: ${message}`);
  });
  // The cache belongs to this fiber, not the module. A module-level cache would
  // outlive reload/uninject — serving a snapshot fetched by the previous
  // generation, and letting two rows with different config share one entry.
  const cache = { at: 0, value: null, pending: null };

  const handler = async (req, res) => {
    if (requestRejected(ctx, req, res)) return;
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      res.end();
      return;
    }
    try {
      const snapshot = await collectCached(ctx, config, cache);
      sendJson(req, res, 200, snapshot);
    } catch (error) {
      // 上游响应体只留在 host 日志之外:这个路由返回给浏览器,不回显上游细节。
      const notConfigured = error?.code === "credential_not_configured";
      const status = notConfigured ? 424 : 500;
      const code = notConfigured ? "credential_not_configured" : "usage_query_failed";
      ctx.logger?.warn?.(
        notConfigured
          ? `opencode-usage: credential "${config.credentialRef}" is not configured`
          : `opencode-usage: usage query failed (HTTP ${error?.status ?? "n/a"})`,
      );
      sendJson(req, res, status, {
        ok: false,
        provider: "opencode-go",
        generatedAt: Date.now(),
        code,
        error: notConfigured ? "credential not configured" : "usage query failed",
      });
    }
  };

  // 绑定到 webServer 服务实例:profile patch 重载/HMR 换掉 webserver 时,
  // effect 随旧服务销毁、随新服务重新注册,不会留下失效的路由表项。
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(() => {
      try {
        return webCtx.webServer.register({ kind: "exact", path: ROUTE_PATH, handler });
      } catch (error) {
        ctx.logger?.warn?.(
          `opencode-usage: could not register the usage route (another instance may own it): ${String(error?.message ?? error)}`,
        );
        return () => {};
      }
    }, "opencode-usage: usage route");
  });
}

/** 测试钩子:单测直接驱动换算逻辑。 */
export const _internals = {
  ROUTE_PATH,
  collectUsage,
  fetchUsage,
  projectPeriod,
  resolveConfig,
  sendJson,
};
