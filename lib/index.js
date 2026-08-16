/**
 * dsh-plugin-opencode-usage:OpenCode Go 用量悬浮面板(Host 半)。
 *
 * 查询 OpenCode Zen Go 订阅用量接口:
 *
 *   GET https://opencode.ai/zen/go/v1/usage
 *   Authorization: Bearer <OPENCODE_GO_API_KEY>
 *
 * 官方接口按 rolling / weekly / monthly 返回已用百分比与重置时间。官方
 * 套餐文档给出了对应美元额度上限(5 小时 $12、每周 $30、每月 $60),本插件
 * 据此把百分比换算为:
 *
 *   used      = limit * percent / 100
 *   remaining = limit - used
 *
 * 总额度可用插件 config 覆盖(套餐策略调整时无需改代码)。API key 通过
 * Harness credentials seam 解析 `credentialRef`(默认 OPENCODE_GO_API_KEY),
 * 不经过浏览器。结果经 GET /plugins/opencode-usage/stats 返回,成功结果
 * 缓存 30s,失败不缓存。
 *
 * @module dsh-plugin-opencode-usage
 */

export const name = "opencode-usage";
export const inject = ["credentials"];

/** 与 team-studio 一致的 Web 服务懒发现键。 */
const WEB_SERVER_KEYS = ["webServer", "httpServer"];

const DEFAULT_API_BASE_URL = "https://opencode.ai/zen/go/v1";
const DEFAULT_CREDENTIAL_REF = "OPENCODE_GO_API_KEY";
const DEFAULT_CURRENCY = "$";
/** OpenCode Go 官方套餐额度:https://opencode.ai/docs/go/#usage-limits */
const DEFAULT_LIMITS = Object.freeze({
  rolling: 12,
  weekly: 30,
  monthly: 60,
});
const DEFAULT_CACHE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 12_000;

let usageCache = { at: 0, value: null };

function resolveConfig(raw) {
  const config = raw && typeof raw === "object" ? raw : {};
  const rawLimits = config.limits && typeof config.limits === "object" ? config.limits : {};
  const limits = {};
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    const value = rawLimits[key] ?? DEFAULT_LIMITS[key];
    limits[key] = Number.isFinite(value) && value > 0 ? value : DEFAULT_LIMITS[key];
  }
  return {
    apiBaseUrl:
      typeof config.apiBaseUrl === "string" && config.apiBaseUrl.trim()
        ? config.apiBaseUrl.replace(/\/+$/, "")
        : DEFAULT_API_BASE_URL,
    credentialRef:
      typeof config.credentialRef === "string" && config.credentialRef.trim()
        ? config.credentialRef.trim()
        : DEFAULT_CREDENTIAL_REF,
    currency:
      typeof config.currency === "string" && config.currency.length <= 4
        ? config.currency
        : DEFAULT_CURRENCY,
    limits,
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

function toMoney(value) {
  return Math.max(0, value);
}

function projectPeriod(key, raw, limit, currency) {
  const entry = raw && typeof raw === "object" ? raw : {};
  const percent =
    typeof entry.percent === "number" && Number.isFinite(entry.percent)
      ? Math.min(100, Math.max(0, entry.percent))
      : null;
  if (percent === null) {
    throw new Error(`opencode-usage: usage.${key}.percent is missing or invalid`);
  }
  const used = toMoney((limit * percent) / 100);
  const remaining = toMoney(limit - used);
  return {
    key,
    status: typeof entry.status === "string" ? entry.status : "unknown",
    percent,
    remainingPercent: Math.max(0, Math.min(100, 100 - percent)),
    limit,
    used,
    remaining,
    currency,
    resetsAt: typeof entry.resetsAt === "string" ? entry.resetsAt : null,
  };
}

async function collectUsage(ctx, config) {
  const apiKey = await resolveApiKey(ctx, config.credentialRef);
  const usage = await fetchUsage(config.apiBaseUrl, apiKey);
  const periods = {};
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    periods[key] = projectPeriod(key, usage[key], config.limits[key], config.currency);
  }
  return {
    ok: true,
    provider: "opencode-go",
    generatedAt: Date.now(),
    currency: config.currency,
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
