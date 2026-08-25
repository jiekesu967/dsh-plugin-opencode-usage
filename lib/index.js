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
 * @module dsh-plugin-opencode-usage
 */

export const name = "opencode-usage";
export const inject = ["credentials"];

/** 与 team-studio 一致的 Web 服务懒发现键。 */
const WEB_SERVER_KEYS = ["webServer", "httpServer"];

const DEFAULT_API_BASE_URL = "https://opencode.ai/zen/go/v1";
const DEFAULT_CREDENTIAL_REF = "OPENCODE_GO_API_KEY";
const DEFAULT_CACHE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 12_000;

let usageCache = { at: 0, value: null };

function resolveConfig(raw) {
  const config = raw && typeof raw === "object" ? raw : {};
  return {
    apiBaseUrl:
      typeof config.apiBaseUrl === "string" && config.apiBaseUrl.trim()
        ? config.apiBaseUrl.replace(/\/+$/, "")
        : DEFAULT_API_BASE_URL,
    credentialRef:
      typeof config.credentialRef === "string" && config.credentialRef.trim()
        ? config.credentialRef.trim()
        : DEFAULT_CREDENTIAL_REF,
    cacheMs:
      Number.isFinite(config.cacheMs) && config.cacheMs >= 1000
        ? config.cacheMs
        : DEFAULT_CACHE_MS,
  };
}

async function resolveApiKey(ctx, ref) {
  const resolved = await ctx.credentials.resolve(ref);
  if (!resolved || typeof resolved.value !== "string" || resolved.value.length === 0) {
    throw new Error(`opencode-usage: credential "${ref}" is not configured`);
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
      throw new Error(
        `opencode-usage: usage API returned HTTP ${response.status}: ${truncateErrorBody(body)}`,
      );
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error("opencode-usage: usage API returned invalid JSON");
    }
    const usage = payload?.usage;
    if (!usage || typeof usage !== "object") {
      throw new Error('opencode-usage: usage API response is missing "usage"');
    }
    return usage;
  } finally {
    clearTimeout(timer);
  }
}

function projectPeriod(key, raw) {
  const entry = raw && typeof raw === "object" ? raw : {};
  const percent =
    typeof entry.percent === "number" && Number.isFinite(entry.percent)
      ? Math.min(100, Math.max(0, entry.percent))
      : null;
  if (percent === null) {
    throw new Error(`opencode-usage: usage.${key}.percent is missing or invalid`);
  }
  return {
    key,
    status: typeof entry.status === "string" ? entry.status : "unknown",
    percent,
    remainingPercent: Math.max(0, Math.min(100, 100 - percent)),
    resetsAt: typeof entry.resetsAt === "string" ? entry.resetsAt : null,
  };
}

const USAGE_PERIOD_KEYS = ["rolling", "weekly", "monthly"];

async function collectUsage(ctx, config) {
  const apiKey = await resolveApiKey(ctx, config.credentialRef);
  const usage = await fetchUsage(config.apiBaseUrl, apiKey);
  const periods = {};
  for (const key of USAGE_PERIOD_KEYS) {
    periods[key] = projectPeriod(key, usage[key]);
  }
  return {
    ok: true,
    provider: "opencode-go",
    generatedAt: Date.now(),
    periods,
  };
}

async function collectCached(ctx, config) {
  const hit = usageCache.value;
  if (hit && Date.now() - usageCache.at < config.cacheMs) return hit;
  const value = await collectUsage(ctx, config);
  usageCache = { at: Date.now(), value };
  return value;
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  let webRegistered = false;

  const registerWebSurface = () => {
    if (webRegistered) return;
    const webServer = ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1]);
    if (webServer === void 0) return;
    webRegistered = true;

    ctx.effect(
      () =>
        webServer.register({
          kind: "exact",
          path: "/plugins/opencode-usage/stats",
          handler: async (req, res) => {
            try {
              const snapshot = await collectCached(ctx, config);
              const body = JSON.stringify(snapshot);
              res.writeHead(200, {
                "content-type": "application/json; charset=utf-8",
                "cache-control": "no-store",
              });
              res.end(body);
            } catch (error) {
              const body = JSON.stringify({
                ok: false,
                provider: "opencode-go",
                generatedAt: Date.now(),
                error: String(error?.message ?? error),
              });
              res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
              res.end(body);
            }
          },
        }),
      "opencode-usage: usage route",
    );
  };

  registerWebSurface();
  ctx.on("internal/service", (serviceName) => {
    if (WEB_SERVER_KEYS.includes(serviceName)) registerWebSurface();
  });
}

/** 测试钩子:单测直接驱动换算逻辑。 */
export const _internals = {
  collectUsage,
  fetchUsage,
  projectPeriod,
  resolveConfig,
};
