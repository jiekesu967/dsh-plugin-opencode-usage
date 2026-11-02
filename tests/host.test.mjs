/**
 * Host-half unit tests for lib/index.js (DSH 0.2.1-rc.5 hardened contract).
 *
 * Zero dependencies: `node --test tests/*.test.mjs`.
 * globalThis.fetch is stubbed per test and restored in afterEach; Date.now is
 * patched only where a test needs to move past the success cache window.
 */

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { apply, _internals } from "../lib/index.js";

const { ROUTE_PATH, collectUsage, fetchUsage, projectPeriod, resolveConfig, sendJson } = _internals;

const REAL_FETCH = globalThis.fetch;
const REAL_NOW = Date.now;
const DEFAULT_CONFIG = {
  apiBaseUrl: "https://opencode.ai/zen/go/v1",
  credentialRef: "OPENCODE_GO_API_KEY",
  cacheMs: 30_000,
};

/** Shipped-contract usage payload (README: percent + resetsAt only). */
const VALID_USAGE = {
  rolling: { status: "ok", percent: 30, resetsAt: "2026-11-02T05:00:00Z" },
  weekly: { status: "ok", percent: 19, resetsAt: "2026-11-08T00:00:00Z" },
  monthly: { status: "ok", percent: 9, resetsAt: "2026-12-01T00:00:00Z" },
};

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  Date.now = REAL_NOW;
});

/** Replace global fetch with a recorder; returns the call log. */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls);
  };
  return calls;
}

/** The tiny slice of a Response fetchUsage consumes. */
function response(body, status = 200) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

const validResponse = () => response({ usage: VALID_USAGE });

/** A promise plus its resolvers, for testing cache.pending dedupe. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/**
 * Fake cordis ctx exposing exactly the seams lib/index.js touches:
 * get("connection"), inject(deps, cb), credentials.resolve, logger.warn.
 * `immediate: false` defers the inject callback so a test can simulate the
 * webServer service arriving later.
 */
function makeCtx(options = {}) {
  // An own `credential` property wins even when it is `undefined`: tests use
  // undefined/null to model "the credentials seam has no value for this ref".
  const credential = Object.hasOwn(options, "credential") ? options.credential : { value: "test-key" };
  const connection = Object.hasOwn(options, "connection") ? options.connection : undefined;
  const immediate = options.immediate !== false;
  const state = {
    injectCalls: [],
    injectCallbacks: [],
    effects: [],
    effectResults: [],
    warnings: [],
    registrations: [],
    credentialCalls: [],
  };
  const server = Object.hasOwn(options, "webServer")
    ? options.webServer
    : {
        register(route) {
          state.registrations.push(route);
          return () => {};
        },
      };
  const webCtx = {
    webServer: server,
    effect(fn, label) {
      state.effects.push(label);
      const result = fn();
      state.effectResults.push(result);
      return result;
    },
  };
  const ctx = {
    get(name) {
      if (name === "connection") return connection;
      return undefined;
    },
    inject(deps, callback) {
      state.injectCalls.push(deps);
      if (immediate) callback(webCtx);
      else state.injectCallbacks.push(callback);
    },
    logger: {
      warn(message) {
        state.warnings.push(String(message));
      },
      info() {},
      error() {},
    },
    credentials: {
      async resolve(ref) {
        state.credentialCalls.push(ref);
        return credential;
      },
    },
  };
  state.provideService = (overrides = {}) => {
    const callback = state.injectCallbacks.shift();
    if (!callback) throw new Error("no deferred inject callback to invoke");
    callback({ ...webCtx, ...overrides });
  };
  state.handler = () => state.registrations.at(-1)?.handler;
  return { ctx, state, webCtx, server };
}

function makeRes() {
  return {
    statusCode: null,
    headers: null,
    body: "",
    ended: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body = "") {
      this.ended = true;
      this.body = typeof body === "string" ? body : "";
    },
  };
}

function makeReq(overrides = {}) {
  return {
    method: "GET",
    url: ROUTE_PATH,
    headers: {},
    ...overrides,
  };
}

async function callRoute(handler, req = makeReq()) {
  const res = makeRes();
  await handler(req, res);
  return res;
}

/** Let the event loop process already-queued microtasks/macrotasks. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------
// _internals contract
// ---------------------------------------------------------------------------

test("_internals exposes ROUTE_PATH, sendJson, and the existing hooks", () => {
  assert.equal(ROUTE_PATH, "/plugins/opencode-usage/stats");
  assert.equal(typeof sendJson, "function");
  for (const key of ["collectUsage", "fetchUsage", "projectPeriod", "resolveConfig"]) {
    assert.equal(typeof _internals[key], "function", `_internals.${key} must be a function`);
  }
});

// ---------------------------------------------------------------------------
// resolveConfig(raw, warn)
// ---------------------------------------------------------------------------

test("resolveConfig: defaults for missing / non-object input", () => {
  assert.deepEqual(resolveConfig(), DEFAULT_CONFIG);
  assert.deepEqual(resolveConfig(null), DEFAULT_CONFIG);
  assert.deepEqual(resolveConfig("not-a-config"), DEFAULT_CONFIG);
  assert.deepEqual(resolveConfig(42), DEFAULT_CONFIG);
  // No warn callback is required.
  assert.doesNotThrow(() => resolveConfig({ credentialRef: 42 }));
});

test("resolveConfig: overrides are normalized and invalid values fall back", () => {
  assert.deepEqual(
    resolveConfig({
      apiBaseUrl: "https://api.example.test/zen/v1///",
      credentialRef: "  MY_OPENCODE_KEY  ",
      cacheMs: 5_000,
    }),
    {
      apiBaseUrl: "https://api.example.test/zen/v1",
      credentialRef: "MY_OPENCODE_KEY",
      cacheMs: 5_000,
    },
  );

  // cacheMs below the 1s floor, non-finite, and non-string fields all fall back.
  assert.deepEqual(resolveConfig({ apiBaseUrl: "", credentialRef: "   ", cacheMs: 999 }), DEFAULT_CONFIG);
  assert.deepEqual(resolveConfig({ cacheMs: Number.NaN }), DEFAULT_CONFIG);
  assert.deepEqual(resolveConfig({ cacheMs: Infinity }), DEFAULT_CONFIG);
  assert.deepEqual(resolveConfig({ apiBaseUrl: 42, credentialRef: null }), DEFAULT_CONFIG);
});

test("resolveConfig: an invalid credentialRef falls back to the default and warns once", () => {
  for (const invalid of ["not a ref", "1LEADING_DIGIT", "has-dash", "a.b", "semi;colon", "λ"]) {
    const warnings = [];
    const config = resolveConfig({ credentialRef: invalid }, (message) => warnings.push(String(message)));
    assert.equal(config.credentialRef, "OPENCODE_GO_API_KEY", `${invalid} must fall back`);
    assert.equal(warnings.length, 1, `${invalid} must warn exactly once`);
    assert.match(warnings[0], /ignoring invalid credentialRef/);
    assert.match(warnings[0], /OPENCODE_GO_API_KEY/);
  }

  // A POSIX shell identifier is kept verbatim (trimmed).
  const warnings = [];
  assert.equal(
    resolveConfig({ credentialRef: "  _MY_KEY_2  " }, (message) => warnings.push(message)).credentialRef,
    "_MY_KEY_2",
  );
  assert.equal(warnings.length, 0);
});

test("resolveConfig: empty / non-string credentialRef falls back silently", () => {
  for (const value of ["", "   ", 42, null, undefined]) {
    const warnings = [];
    const config = resolveConfig({ credentialRef: value }, (message) => warnings.push(message));
    assert.equal(config.credentialRef, "OPENCODE_GO_API_KEY");
    assert.equal(warnings.length, 0, `credentialRef ${JSON.stringify(value)} must not warn`);
  }
});

// ---------------------------------------------------------------------------
// projectPeriod
// ---------------------------------------------------------------------------

test("projectPeriod: keeps status/resetsAt and computes remainingPercent", () => {
  assert.deepEqual(
    projectPeriod("rolling", {
      status: "ok",
      percent: 30,
      resetsAt: "2026-11-02T05:00:00Z",
    }),
    {
      key: "rolling",
      status: "ok",
      percent: 30,
      remainingPercent: 70,
      resetsAt: "2026-11-02T05:00:00Z",
    },
  );

  assert.deepEqual(projectPeriod("weekly", { percent: 19.5 }), {
    key: "weekly",
    status: "unknown",
    percent: 19.5,
    remainingPercent: 80.5,
    resetsAt: null,
  });
});

test("projectPeriod: clamps percent into 0..100", () => {
  assert.equal(projectPeriod("monthly", { percent: 150 }).percent, 100);
  assert.equal(projectPeriod("monthly", { percent: 150 }).remainingPercent, 0);
  assert.equal(projectPeriod("monthly", { percent: -3 }).percent, 0);
  assert.equal(projectPeriod("monthly", { percent: -3 }).remainingPercent, 100);
});

test("projectPeriod: returns null for a missing or invalid percent instead of throwing", () => {
  for (const entry of [
    undefined,
    null,
    {},
    { percent: "30" },
    { percent: Number.NaN },
    { percent: Infinity },
    { percent: -Infinity },
    { percent: null },
  ]) {
    assert.doesNotThrow(() => projectPeriod("rolling", entry));
    assert.equal(projectPeriod("rolling", entry), null, `entry ${JSON.stringify(entry)} must be null`);
  }
});

test("projectPeriod: resetsAt is null unless it is a string", () => {
  assert.equal(projectPeriod("rolling", { percent: 1, resetsAt: 12345 }).resetsAt, null);
  assert.equal(projectPeriod("rolling", { percent: 1, resetsAt: null }).resetsAt, null);
  assert.equal(projectPeriod("rolling", { percent: 1, resetsAt: "" }).resetsAt, "");
});

// ---------------------------------------------------------------------------
// fetchUsage
// ---------------------------------------------------------------------------

test("fetchUsage: 200 with valid JSON returns the usage object and sends the documented request", async () => {
  const calls = stubFetch(() => validResponse());

  const usage = await fetchUsage("https://api.example.test/v1", "key-123");

  assert.deepEqual(usage, VALID_USAGE);
  assert.equal(calls.length, 1);
  const [{ url, init }] = calls;
  assert.equal(url, "https://api.example.test/v1/usage");
  assert.equal(init.method, "GET");
  assert.equal(init.headers.authorization, "Bearer key-123");
  assert.equal(init.headers.accept, "application/json");
  assert.equal(init.cache, "no-store");
  assert.ok(init.signal instanceof AbortSignal, "must pass an AbortSignal for the request timeout");
});

test("fetchUsage: non-2xx carries upstream_error + status and truncates the body to 240 chars plus an ellipsis", async () => {
  const longBody = "E".repeat(300);
  stubFetch(() => response(longBody, 500));

  await assert.rejects(fetchUsage("https://api.example.test/v1", "key-123"), (error) => {
    const prefix = "usage API returned HTTP 500: ";
    assert.equal(error.message, `${prefix}${"E".repeat(240)}…`);
    assert.equal(error.code, "upstream_error");
    assert.equal(error.status, 500);
    return true;
  });
});

test("fetchUsage: short upstream error bodies are not truncated", async () => {
  stubFetch(() => response("upstream said no", 401));

  await assert.rejects(fetchUsage("https://api.example.test/v1", "key-123"), (error) => {
    assert.equal(error.message, "usage API returned HTTP 401: upstream said no");
    assert.equal(error.code, "upstream_error");
    assert.equal(error.status, 401);
    return true;
  });
});

test("fetchUsage: invalid JSON is reported with upstream_error and without the body", async () => {
  stubFetch(() => response("this is not json", 200));

  await assert.rejects(fetchUsage("https://api.example.test/v1", "key-123"), (error) => {
    assert.equal(error.message, "usage API returned invalid JSON");
    assert.equal(error.code, "upstream_error");
    assert.ok(!error.message.includes("this is not json"));
    return true;
  });
});

test('fetchUsage: response without "usage" is rejected with upstream_error', async () => {
  for (const payload of [{}, { usage: null }, { usage: "rolling" }, { data: {} }]) {
    stubFetch(() => response(payload, 200));
    await assert.rejects(fetchUsage("https://api.example.test/v1", "key-123"), (error) => {
      assert.equal(error.message, 'usage API response is missing "usage"');
      assert.equal(error.code, "upstream_error");
      return true;
    });
  }
});

test("fetchUsage: a network failure propagates as-is", async () => {
  stubFetch(() => {
    throw new Error("socket exploded");
  });

  await assert.rejects(fetchUsage("https://api.example.test/v1", "key-123"), /socket exploded/);
});

test("fetchUsage: aborts the upstream request when the timeout fires", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal = null;
  const calls = stubFetch(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        signal = init.signal;
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      }),
  );

  try {
    const pending = fetchUsage("https://api.example.test/v1", "key-123");
    // The request timeout is an internal constant (12s); tick well past it.
    t.mock.timers.tick(20_000);

    await assert.rejects(pending, (error) => {
      assert.ok(signal instanceof AbortSignal);
      assert.equal(signal.aborted, true);
      assert.ok(
        error?.name === "AbortError" || error?.name === "TimeoutError",
        `unexpected abort reason: ${error?.name}`,
      );
      return true;
    });
    assert.equal(calls.length, 1);
  } finally {
    t.mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------
// collectUsage
// ---------------------------------------------------------------------------

test("collectUsage: resolves the credential, fetches usage, and projects all three periods", async () => {
  const calls = stubFetch(() => validResponse());
  const { ctx, state } = makeCtx();

  const snapshot = await collectUsage(ctx, resolveConfig({}));

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.provider, "opencode-go");
  assert.equal(typeof snapshot.generatedAt, "number");
  assert.deepEqual(Object.keys(snapshot.periods).sort(), ["monthly", "rolling", "weekly"]);
  assert.equal(snapshot.periods.rolling.percent, 30);
  assert.equal(snapshot.periods.rolling.remainingPercent, 70);
  assert.equal(snapshot.periods.weekly.remainingPercent, 81);
  assert.equal(snapshot.periods.monthly.resetsAt, "2026-12-01T00:00:00Z");
  assert.deepEqual(state.credentialCalls, ["OPENCODE_GO_API_KEY"]);
  assert.equal(calls.length, 1);
});

test("collectUsage: honors a custom credentialRef", async () => {
  stubFetch(() => validResponse());
  const { ctx, state } = makeCtx({ credential: { value: "custom-key" } });

  await collectUsage(ctx, resolveConfig({ credentialRef: "OTHER_KEY" }));

  assert.deepEqual(state.credentialCalls, ["OTHER_KEY"]);
});

test("collectUsage: skips unusable periods and still returns the usable ones", async () => {
  stubFetch(() =>
    response({
      usage: {
        rolling: { status: "ok", percent: 30, resetsAt: "2026-11-02T05:00:00Z" },
        weekly: { status: "ok", percent: "not-a-number" },
        // monthly is absent
      },
    }),
  );
  const { ctx } = makeCtx();

  const snapshot = await collectUsage(ctx, resolveConfig({}));

  assert.equal(snapshot.ok, true);
  assert.deepEqual(Object.keys(snapshot.periods), ["rolling"]);
  assert.equal(snapshot.periods.rolling.percent, 30);
});

test("collectUsage: throws upstream_error when no period is usable", async () => {
  stubFetch(() => response({ usage: { rolling: {}, weekly: null, monthly: { percent: "x" } } }, 200));
  const { ctx } = makeCtx();

  await assert.rejects(collectUsage(ctx, resolveConfig({})), (error) => {
    assert.equal(error.code, "upstream_error");
    assert.match(error.message, /no usable periods/);
    return true;
  });
});

test("collectUsage: missing credential rejects with credential_not_configured and no upstream call", async () => {
  const calls = stubFetch(() => validResponse());
  const { ctx } = makeCtx({ credential: undefined });

  await assert.rejects(collectUsage(ctx, resolveConfig({})), (error) => {
    assert.equal(error.code, "credential_not_configured");
    assert.equal(error.message, 'credential "OPENCODE_GO_API_KEY" is not configured');
    return true;
  });
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// sendJson
// ---------------------------------------------------------------------------

test("sendJson: JSON body + byte-length content-length; HEAD keeps headers but no body", () => {
  const payload = { ok: true, provider: "opencode-go", value: "λ" };
  const expectedBody = JSON.stringify(payload);
  const expectedLength = Buffer.byteLength(expectedBody);

  const getRes = makeRes();
  sendJson(makeReq({ method: "GET" }), getRes, 200, payload);
  assert.equal(getRes.statusCode, 200);
  assert.match(getRes.headers["content-type"], /^application\/json/);
  assert.equal(getRes.headers["cache-control"], "no-store");
  assert.equal(getRes.headers["content-length"], expectedLength);
  assert.equal(getRes.body, expectedBody);
  assert.equal(getRes.ended, true);

  const headRes = makeRes();
  sendJson(makeReq({ method: "HEAD" }), headRes, 200, payload);
  assert.equal(headRes.statusCode, 200);
  assert.equal(headRes.headers["content-length"], expectedLength);
  assert.equal(headRes.body, "");
  assert.equal(headRes.ended, true);
});

// ---------------------------------------------------------------------------
// apply(): route registration via ctx.inject(["webServer"], ...)
// ---------------------------------------------------------------------------

test("apply(): injects webServer and registers the exact route in an effect", () => {
  stubFetch(() => validResponse());
  const { ctx, state } = makeCtx();

  apply(ctx, {});

  assert.deepEqual(state.injectCalls, [["webServer"]]);
  assert.deepEqual(state.effects, ["opencode-usage: usage route"]);
  assert.equal(state.registrations.length, 1);
  const [route] = state.registrations;
  assert.equal(route.kind, "exact");
  assert.equal(route.path, ROUTE_PATH);
  assert.equal(route.path, "/plugins/opencode-usage/stats");
  assert.equal(typeof route.handler, "function");
  assert.equal(typeof state.effectResults[0], "function", "the effect must return a disposer");
});

test("apply(): when webServer is not mounted yet, registration waits for the service", () => {
  stubFetch(() => validResponse());
  const { ctx, state } = makeCtx({ immediate: false });

  apply(ctx, {});

  assert.deepEqual(state.injectCalls, [["webServer"]]);
  assert.equal(state.registrations.length, 0, "no route before webServer exists");
  assert.equal(state.effects.length, 0);

  state.provideService();

  assert.deepEqual(state.effects, ["opencode-usage: usage route"]);
  assert.equal(state.registrations.length, 1);
  assert.equal(state.registrations[0].path, ROUTE_PATH);
});

test("apply(): a register() throw is caught, logged, and returns a no-op disposer", () => {
  stubFetch(() => validResponse());
  const server = {
    register() {
      throw new Error("duplicate (kind, path): /plugins/opencode-usage/stats");
    },
  };
  const { ctx, state } = makeCtx({ webServer: server });

  assert.doesNotThrow(() => apply(ctx, {}));
  assert.equal(state.registrations.length, 0);
  assert.deepEqual(state.effects, ["opencode-usage: usage route"]);
  assert.equal(typeof state.effectResults[0], "function", "the catch must return a disposer");
  assert.equal(state.warnings.length, 1);
  assert.match(state.warnings[0], /could not register the usage route/);
  assert.match(state.warnings[0], /duplicate/);
});

test("apply(): an invalid credentialRef warns host-side and the handler resolves the default key", async () => {
  stubFetch(() => validResponse());
  const { ctx, state } = makeCtx();

  apply(ctx, { credentialRef: "not a valid ref!" });

  assert.equal(state.warnings.length, 1);
  assert.match(state.warnings[0], /^opencode-usage: ignoring invalid credentialRef/);
  assert.match(state.warnings[0], /OPENCODE_GO_API_KEY/);

  const res = await callRoute(state.handler());
  assert.equal(res.statusCode, 200);
  assert.deepEqual(state.credentialCalls, ["OPENCODE_GO_API_KEY"]);
});

// ---------------------------------------------------------------------------
// apply(): route handler
// ---------------------------------------------------------------------------

test("apply(): the route handler writes 200 JSON on success", async () => {
  stubFetch(() => validResponse());
  const { ctx, state } = makeCtx();
  apply(ctx, {});

  const res = await callRoute(state.handler());

  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /^application\/json/);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers["content-length"], Buffer.byteLength(res.body));
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.provider, "opencode-go");
  assert.equal(typeof body.generatedAt, "number");
  assert.equal(body.periods.rolling.percent, 30);
  assert.equal(body.periods.weekly.percent, 19);
  assert.equal(body.periods.monthly.percent, 9);
});

test("apply(): an upstream failure answers 500 with usage_query_failed and leaks no upstream detail", async () => {
  const secret = "sk-upstream-SECRET-do-not-leak";
  stubFetch(() => response(`upstream rejected ${secret} (HTTP 500)`, 500));
  const { ctx, state } = makeCtx();
  apply(ctx, { cacheMs: 60_000 });

  const res = await callRoute(state.handler());

  assert.equal(res.statusCode, 500);
  assert.match(res.headers["content-type"], /^application\/json/);
  const body = JSON.parse(res.body);
  assert.deepEqual(Object.keys(body).sort(), ["code", "error", "generatedAt", "ok", "provider"]);
  assert.equal(body.ok, false);
  assert.equal(body.provider, "opencode-go");
  assert.equal(body.code, "usage_query_failed");
  assert.equal(body.error, "usage query failed");
  assert.equal(typeof body.generatedAt, "number");
  assert.ok(!res.body.includes(secret), "upstream body leaked into the response");
  assert.ok(!res.body.includes("HTTP 500"), "upstream status detail leaked into the response");

  // The host log keeps only the status, never the upstream body.
  assert.equal(state.warnings.length, 1);
  assert.match(state.warnings[0], /usage query failed \(HTTP 500\)/);
  assert.ok(!state.warnings[0].includes(secret), "upstream body leaked into the host log");
});

test("apply(): a missing credential answers 424 credential_not_configured with no upstream call", async () => {
  for (const credential of [undefined, null, {}, { value: "" }, { value: 42 }]) {
    const calls = stubFetch(() => validResponse());
    const { ctx, state } = makeCtx({ credential });
    apply(ctx, {});

    const res = await callRoute(state.handler());

    assert.equal(res.statusCode, 424);
    const body = JSON.parse(res.body);
    assert.deepEqual(Object.keys(body).sort(), ["code", "error", "generatedAt", "ok", "provider"]);
    assert.equal(body.ok, false);
    assert.equal(body.provider, "opencode-go");
    assert.equal(body.code, "credential_not_configured");
    assert.equal(body.error, "credential not configured");
    assert.equal(typeof body.generatedAt, "number");
    assert.ok(!res.body.includes("OPENCODE_GO_API_KEY"), "credential ref leaked into the response");
    assert.equal(calls.length, 0, "upstream must not be called without a credential");
    assert.match(state.warnings[0], /credential "OPENCODE_GO_API_KEY" is not configured/);
  }
});

test("apply(): non-GET/HEAD is rejected with 405 and Allow, without touching upstream", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
    const calls = stubFetch(() => validResponse());
    const { ctx, state } = makeCtx();
    apply(ctx, {});

    const res = await callRoute(state.handler(), makeReq({ method }));

    assert.equal(res.statusCode, 405, `${method} must be 405`);
    assert.equal(res.headers.allow, "GET, HEAD");
    assert.equal(res.ended, true);
    assert.equal(res.body, "");
    assert.equal(calls.length, 0);
  }
});

test("apply(): HEAD gets the success headers (content-length included) and an empty body", async () => {
  const calls = stubFetch(() => validResponse());
  const { ctx, state } = makeCtx();
  apply(ctx, {});

  const res = await callRoute(state.handler(), makeReq({ method: "HEAD" }));

  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /^application\/json/);
  assert.ok(Number(res.headers["content-length"]) > 0);
  assert.equal(res.body, "");
  assert.equal(res.ended, true);
  assert.equal(calls.length, 1);
});

test("apply(): HEAD on the error path keeps the headers and an empty body", async () => {
  stubFetch(() => response("upstream down", 503));
  const { ctx, state } = makeCtx({ credential: undefined });
  apply(ctx, {});

  const res = await callRoute(state.handler(), makeReq({ method: "HEAD" }));

  assert.equal(res.statusCode, 424);
  assert.ok(Number(res.headers["content-length"]) > 0);
  assert.equal(res.body, "");
});

test("apply(): the connection requestRejection fence short-circuits the request", async () => {
  const seen = [];
  const connection = {
    requestRejection(req) {
      seen.push(req);
      return 403;
    },
  };
  const calls = stubFetch(() => validResponse());
  const { ctx, state } = makeCtx({ connection });
  apply(ctx, {});

  const req = makeReq();
  const res = await callRoute(state.handler(), req);

  assert.equal(res.statusCode, 403);
  assert.equal(res.ended, true);
  assert.equal(res.body, "");
  assert.equal(calls.length, 0, "a rejected request must not query upstream");
  assert.equal(seen.length, 1);
  assert.equal(seen[0], req);

  // The fence runs before the method gate.
  const postRes = await callRoute(state.handler(), makeReq({ method: "POST" }));
  assert.equal(postRes.statusCode, 403);
  assert.equal(calls.length, 0);
});

test("apply(): the handler proceeds when requestRejection returns undefined or is absent", async () => {
  for (const connection of [{ requestRejection: () => undefined }, {}]) {
    const calls = stubFetch(() => validResponse());
    const { ctx, state } = makeCtx({ connection });
    apply(ctx, {});

    const res = await callRoute(state.handler());
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
  }
});

// ---------------------------------------------------------------------------
// apply(): cache + concurrency
// ---------------------------------------------------------------------------

test("apply(): successful snapshots are cached within cacheMs", async () => {
  const calls = stubFetch(() => validResponse());
  let clock = 1_700_000_000_000;
  Date.now = () => clock;

  const { ctx, state } = makeCtx();
  apply(ctx, { cacheMs: 1_000 });
  const handler = state.handler();

  const first = await callRoute(handler);
  assert.equal(first.statusCode, 200);
  assert.equal(calls.length, 1);

  clock += 999;
  const cached = await callRoute(handler);
  assert.equal(cached.statusCode, 200);
  assert.equal(calls.length, 1, "a hit inside cacheMs must not call upstream again");
  assert.equal(JSON.parse(cached.body).generatedAt, JSON.parse(first.body).generatedAt);

  clock += 2;
  const refreshed = await callRoute(handler);
  assert.equal(refreshed.statusCode, 200);
  assert.equal(calls.length, 2, "an expired entry must be refetched");
  assert.notEqual(JSON.parse(refreshed.body).generatedAt, JSON.parse(first.body).generatedAt);
});

test("apply(): failed snapshots are never cached", async () => {
  let next = () => response("upstream down", 503);
  const calls = stubFetch(() => next());
  const { ctx, state } = makeCtx();
  apply(ctx, { cacheMs: 60_000 });
  const handler = state.handler();

  const first = await callRoute(handler);
  const second = await callRoute(handler);

  assert.equal(first.statusCode, 500);
  assert.equal(second.statusCode, 500);
  assert.equal(JSON.parse(first.body).code, "usage_query_failed");
  assert.equal(calls.length, 2, "each failure must retry the upstream");

  next = () => validResponse();
  const third = await callRoute(handler);
  assert.equal(third.statusCode, 200);
  assert.equal(JSON.parse(third.body).ok, true);
});

test("apply(): overlapping handler calls share one in-flight upstream request", async () => {
  const gate = deferred();
  const calls = stubFetch(() => gate.promise);
  const { ctx, state } = makeCtx();
  apply(ctx, {});
  const handler = state.handler();

  const resA = makeRes();
  const resB = makeRes();
  const pendingA = handler(makeReq(), resA);
  const pendingB = handler(makeReq(), resB);
  await flush();

  assert.equal(calls.length, 1, "both callers must share one upstream request");

  gate.resolve(validResponse());
  await Promise.all([pendingA, pendingB]);

  assert.equal(resA.statusCode, 200);
  assert.equal(resB.statusCode, 200);
  assert.equal(JSON.parse(resA.body).provider, "opencode-go");
  assert.equal(JSON.parse(resB.body).provider, "opencode-go");
  assert.equal(calls.length, 1);
});

test("apply(): overlapping failures share one upstream request, then a later call retries", async () => {
  let next = () => validResponse();
  const calls = stubFetch(() => next());
  const { ctx, state } = makeCtx();
  apply(ctx, { cacheMs: 60_000 });
  const handler = state.handler();

  // Gate the first upstream call so both handlers overlap on the same pending.
  const gate = deferred();
  next = () => gate.promise;
  const resA = makeRes();
  const resB = makeRes();
  const pendingA = handler(makeReq(), resA);
  const pendingB = handler(makeReq(), resB);
  await flush();
  assert.equal(calls.length, 1, "overlapping failures must share one upstream request");

  gate.resolve(response("upstream down", 503));
  await Promise.all([pendingA, pendingB]);
  assert.equal(resA.statusCode, 500);
  assert.equal(resB.statusCode, 500);

  next = () => validResponse();
  const retry = await callRoute(handler);
  assert.equal(retry.statusCode, 200);
  assert.equal(calls.length, 2, "the failed attempt must not be cached");
});
