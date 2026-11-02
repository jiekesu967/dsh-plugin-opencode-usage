#!/usr/bin/env node
/**
 * dsh-plugin-opencode-usage — end-to-end verifier against a real dsh Web boot.
 *
 * What it does:
 *   1. creates a throwaway $DSH_HOME under the OS temp dir and a profile whose
 *      `dsh.profile.bundles` lists dsh-base, dsh-web-app and this plugin, with
 *      the repository checkout symlinked into the profile's node_modules;
 *   2. boots `dsh --profile <name> --port 0 --no-open` and reads the printed
 *      "dsh web: http://127.0.0.1:PORT/?token=..." line;
 *   3. exchanges the token for the auth cookie manually (303 + set-cookie),
 *      then checks:
 *        (a) GET / -> 200 HTML, plugin id present in the __DSH_BOOT__ graph and
 *            in a plugins/?? combined script URL;
 *        (b) that combined client bundle is served and contains
 *            "window.__ModuleLoader__.load" and the plugin id;
 *        (c) GET /plugins/opencode-usage/stats (with the browser cookie) -> JSON
 *            with provider "opencode-go": 424 + ok:false/code
 *            "credential_not_configured" without an API key, or 200 + ok:true
 *            with three periods when one is configured;
 *        (d) the same route without the cookie is rejected with 401 (the 0.2.1
 *            connection trust fence).
 *
 * `--mock` adds an isolated end-to-end success path: a local HTTP upstream plus
 * a `--patch` overlay pointing apiBaseUrl at it, with OPENCODE_GO_API_KEY set
 * for the child, asserting 200 + three periods. The default run stays
 * credential-free and fast.
 *
 * Always kills the dsh child (SIGTERM, then SIGKILL) and removes the temp home,
 * even on failure. Exit code 1 when any check fails. `--verbose` adds request
 * and process diagnostics. No dependencies; intended to finish in <120s.
 */

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

const PLUGIN_ID = "dsh-plugin-opencode-usage";
const PROFILE_NAME = "verify";
const STATS_PATH = "/plugins/opencode-usage/stats";
const URL_LINE = /dsh web: (https?:\/\/[^\s]+)/u;

const STARTED_AT = Date.now();
const TOTAL_BUDGET_MS = 110_000;
const BOOT_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const TERM_GRACE_MS = 5_000;
const KILL_GRACE_MS = 3_000;

const VERBOSE = process.argv.includes("--verbose");
const MOCK = process.argv.includes("--mock");

const sandbox = {
  home: null,
  profileDir: null,
  child: null,
  logs: { stdout: "", stderr: "" },
  origin: null,
  tokenUrl: null,
  cookie: null,
  html: null,
  boot: null,
  comboUrl: null,
  statsBody: null,
  mockUpstream: null,
};

let failures = 0;

// ---------------------------------------------------------------------------
// output helpers
// ---------------------------------------------------------------------------

function log(...args) {
  if (VERBOSE) console.log("[verify]", ...args);
}

function tail(text, max = 1_200) {
  const value = String(text ?? "").trim();
  return value.length <= max ? value : `…${value.slice(-max)}`;
}

function pass(label, detail = "") {
  console.log(`PASS ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(label, detail = "") {
  failures += 1;
  console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
}

async function check(label, fn) {
  try {
    const detail = await fn();
    pass(label, detail);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderrTail = sandbox.logs.stderr.trim();
    fail(label, stderrTail && !message.includes(stderrTail) ? `${message}\n  dsh stderr: ${tail(stderrTail, 800)}` : message);
    if (VERBOSE && error instanceof Error && error.stack) console.error(error.stack);
    return false;
  }
}

function assertCheck(condition, message) {
  if (!condition) throw new Error(message);
}

function requestTimeoutMs() {
  return Math.min(REQUEST_TIMEOUT_MS, Math.max(500, STARTED_AT + TOTAL_BUDGET_MS - Date.now()));
}

// ---------------------------------------------------------------------------
// temp $DSH_HOME + profile
// ---------------------------------------------------------------------------

function createSandbox() {
  const home = mkdtempSync(join(tmpdir(), "dsh-opencode-usage-verify-"));
  const profileDir = join(home, "profiles", PROFILE_NAME);
  const modulesDir = join(profileDir, "node_modules");
  mkdirSync(modulesDir, { recursive: true });

  const manifest = {
    name: `dsh-profile-${PROFILE_NAME}`,
    private: true,
    dependencies: {},
    dsh: {
      profile: {
        bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", PLUGIN_ID],
      },
    },
  };
  writeFileSync(join(profileDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(profileDir, "cordis.patch.yml"), "[]\n");

  const linkPath = join(modulesDir, PLUGIN_ID);
  symlinkSync(REPO_ROOT, linkPath, process.platform === "win32" ? "junction" : "dir");

  sandbox.home = home;
  sandbox.profileDir = profileDir;
  log(`temp DSH_HOME: ${home}`);
  log(`profile: ${profileDir}`);
  log(`plugin symlink: ${linkPath} -> ${REPO_ROOT}`);
  return { home, profileDir, linkPath };
}

// ---------------------------------------------------------------------------
// dsh binary resolution
// ---------------------------------------------------------------------------

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveDshBinary() {
  const override = process.env.DSH_BIN;
  if (override !== undefined && override.trim() !== "") {
    assertCheck(isExecutable(override), `DSH_BIN is set but not executable: ${override}`);
    return override;
  }

  const exts = process.platform === "win32" ? ["", ".cmd", ".exe"] : [""];
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter((entry) => entry !== "");
  for (const directory of pathEntries) {
    for (const ext of exts) {
      const candidate = join(directory, `dsh${ext}`);
      if (isExecutable(candidate)) return candidate;
    }
  }

  // Known global install locations; PATH is authoritative first.
  for (const fallback of [
    "/usr/local/bin/dsh",
    "/opt/homebrew/bin/dsh",
    "/usr/bin/dsh",
  ]) {
    if (isExecutable(fallback)) return fallback;
  }

  throw new Error("could not find the dsh CLI on PATH; install it globally or set DSH_BIN");
}

// ---------------------------------------------------------------------------
// optional mock upstream (--mock)
// ---------------------------------------------------------------------------

/** Local stand-in for https://opencode.ai/zen/go/v1 that records requests. */
async function startMockUpstream() {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization ?? null,
    });
    if (
      req.method === "GET" &&
      req.url === "/usage" &&
      req.headers.authorization === "Bearer mock-key"
    ) {
      const body = JSON.stringify({
        usage: {
          rolling: { status: "ok", percent: 30, resetsAt: "2026-11-02T05:00:00Z" },
          weekly: { status: "ok", percent: 60, resetsAt: "2026-11-08T00:00:00Z" },
          monthly: { status: "ok", percent: 90, resetsAt: "2026-12-01T00:00:00Z" },
        },
      });
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    const body = JSON.stringify({ error: "unauthorized" });
    res.writeHead(401, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  });

  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : null;
  assertCheck(typeof port === "number", "mock upstream did not bind a TCP port");
  log(`mock upstream listening on http://127.0.0.1:${port}`);
  return {
    requests,
    port,
    close: () =>
      new Promise((resolvePromise) => {
        server.close(() => resolvePromise());
      }),
  };
}

/** `--patch` overlay overriding the plugin config to point at the mock upstream. */
function writeMockOverlay(port) {
  const overlayPath = join(sandbox.home, "mock-upstream.patch.yml");
  writeFileSync(
    overlayPath,
    ["- id: opencode-usage", "  config:", `    apiBaseUrl: http://127.0.0.1:${port}`, ""].join("\n"),
  );
  log(`mock overlay: ${overlayPath}`);
  return overlayPath;
}

// ---------------------------------------------------------------------------
// child process lifecycle
// ---------------------------------------------------------------------------

function spawnDsh(binary, options = {}) {
  const env = {
    ...process.env,
    DSH_HOME: sandbox.home,
    DSH_TELEMETRY_DISABLED: "1",
    NO_COLOR: "1",
    ...(options.env ?? {}),
  };
  // The default run must be credential-free and deterministic: an ambient key
  // in the caller's shell would otherwise hit the real upstream.
  if (!Object.hasOwn(options.env ?? {}, "OPENCODE_GO_API_KEY")) {
    delete env.OPENCODE_GO_API_KEY;
  }

  const child = spawn(
    binary,
    ["--profile", PROFILE_NAME, ...(options.args ?? []), "--port", "0", "--no-open"],
    {
      cwd: sandbox.home,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    sandbox.logs.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    sandbox.logs.stderr += chunk;
  });
  return child;
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolvePromise(false);
    }, timeoutMs);
    timer.unref?.();
    function onExit() {
      clearTimeout(timer);
      resolvePromise(true);
    }
    child.once("exit", onExit);
  });
}

async function stopChild() {
  const child = sandbox.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  log("stopping dsh (SIGTERM)…");
  child.kill("SIGTERM");
  if (await waitForExit(child, TERM_GRACE_MS)) return;
  log("dsh did not exit in time (SIGKILL)…");
  child.kill("SIGKILL");
  await waitForExit(child, KILL_GRACE_MS);
}

let cleanupPromise = null;
function cleanup() {
  cleanupPromise ??= (async () => {
    await stopChild();
    if (sandbox.mockUpstream) {
      try {
        await sandbox.mockUpstream.close();
        log("closed mock upstream");
      } catch (error) {
        console.error(`WARN could not close the mock upstream: ${String(error)}`);
      }
    }
    if (sandbox.home) {
      try {
        rmSync(sandbox.home, { recursive: true, force: true });
        log(`removed temp DSH_HOME: ${sandbox.home}`);
      } catch (error) {
        console.error(`WARN could not remove temp DSH_HOME ${sandbox.home}: ${String(error)}`);
      }
    }
  })();
  return cleanupPromise;
}

process.once("SIGINT", () => {
  console.error("FAIL interrupted");
  void cleanup().finally(() => process.exit(130));
});

// ---------------------------------------------------------------------------
// boot readiness + HTTP helpers
// ---------------------------------------------------------------------------

async function waitForBootUrl(timeoutMs) {
  const deadline = Math.min(Date.now() + timeoutMs, STARTED_AT + TOTAL_BUDGET_MS);
  let exited = null;
  const child = sandbox.child;

  const onExit = (code, signal) => {
    exited = { code, signal };
  };
  child.once("exit", onExit);
  try {
    while (Date.now() < deadline) {
      const match = sandbox.logs.stdout.match(URL_LINE);
      if (match) return match[1];
      if (exited) {
        throw new Error(
          `dsh exited before printing its URL (code=${exited.code}, signal=${exited.signal})`,
        );
      }
      await delay(100);
    }
  } finally {
    child.off("exit", onExit);
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for "dsh web: http..."\n  dsh stderr: ${tail(sandbox.logs.stderr, 800) || "(empty)"}`,
  );
}

/** Manual cookie jar: exchange the printed token URL for the auth cookie. */
async function mintAuthCookie(tokenUrl) {
  const response = await fetch(tokenUrl, {
    redirect: "manual",
    signal: AbortSignal.timeout(requestTimeoutMs()),
  });
  assertCheck(response.status === 303, `token exchange expected 303, got ${response.status}`);

  const setCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
  assertCheck(setCookies.length > 0, "303 response did not carry a set-cookie header");

  const cookie = setCookies[0].split(";")[0].trim();
  assertCheck(cookie.includes("="), `malformed auth cookie: ${JSON.stringify(cookie)}`);
  const location = response.headers.get("location") ?? "./";
  log(`auth cookie minted; redirect location: ${location}`);
  return { cookie, location };
}

function fetchWithCookie(url, cookie, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (cookie) headers.cookie = cookie;
  return fetch(url, {
    ...options,
    headers,
    redirect: options.redirect ?? "follow",
    signal: AbortSignal.timeout(requestTimeoutMs()),
  });
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/gu, "&")
    .replace(/&quot;/gu, '"')
    .replace(/&#0*39;|&#x0*27;/giu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">");
}

/** Parse the `globalThis["__DSH_BOOT__"] = {...}</script>` graph. */
function parseBootGraph(html) {
  const marker = /globalThis\["__DSH_BOOT__"\]\s*=\s*/u.exec(html);
  assertCheck(marker !== null, 'index HTML does not expose globalThis["__DSH_BOOT__"]');
  const start = marker.index + marker[0].length;
  const end = html.indexOf("</script>", start);
  assertCheck(end !== -1, "__DSH_BOOT__ assignment has no closing </script>");
  const raw = html.slice(start, end).trim();
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`could not parse __DSH_BOOT__ JSON: ${error.message}`);
  }
}

/** Find the combined plugins/?? script URL that carries this plugin. */
function findCombinedBundleUrl(html) {
  const urls = [...html.matchAll(/(?:src|href)="([^"]*)"/gu)].map((match) =>
    decodeHtmlEntities(match[1]),
  );
  return (
    urls.find(
      (url) => url.includes("plugins/??") && url.includes(`${PLUGIN_ID}/client.js`),
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  console.log(
    `dsh-plugin-opencode-usage e2e verifier — repo: ${REPO_ROOT}${VERBOSE ? " (verbose)" : ""}${MOCK ? " (mock upstream)" : ""}`,
  );

  try {
    const setupOk = await check("setup: temp DSH_HOME + profile + plugin symlink", async () => {
      const created = createSandbox();
      return `profile "${PROFILE_NAME}" at ${created.profileDir}`;
    });

    const binaryOk = await check("dsh binary", async () => {
      const binary = resolveDshBinary();
      const version = spawnSync(binary, ["--version"], {
        encoding: "utf8",
        timeout: Math.min(15_000, requestTimeoutMs()),
      });
      assertCheck(
        version.status === 0,
        `\`dsh --version\` failed (status=${version.status}): ${tail(version.stderr ?? "")}`,
      );
      const printed = (version.stdout ?? "").trim();
      log(`using ${binary} (${printed})`);
      return `${binary} (${printed})`;
    });

    const bootOk = await check("boot: dsh web ready", async () => {
      assertCheck(setupOk, "sandbox setup failed");
      assertCheck(binaryOk, "no usable dsh binary");
      const spawnOptions = {};
      if (MOCK) {
        sandbox.mockUpstream = await startMockUpstream();
        spawnOptions.args = ["--patch", writeMockOverlay(sandbox.mockUpstream.port)];
        spawnOptions.env = { OPENCODE_GO_API_KEY: "mock-key" };
      }
      sandbox.child = spawnDsh(resolveDshBinary(), spawnOptions);
      log(`spawned dsh pid ${sandbox.child.pid}`);
      const url = await waitForBootUrl(
        Math.min(BOOT_TIMEOUT_MS, Math.max(1_000, STARTED_AT + TOTAL_BUDGET_MS - Date.now())),
      );
      sandbox.tokenUrl = url;
      const parsed = new URL(url);
      sandbox.origin = parsed.origin;
      assertCheck(parsed.searchParams.get("token") !== null, "printed URL carries no token query");
      log(`ready at ${url}`);
      return `${sandbox.origin} (profile "${PROFILE_NAME}"${MOCK ? ", mock upstream" : ""})`;
    });

    const indexOk = await check(
      "a: index HTML 200 with plugin in __DSH_BOOT__ graph and plugins/?? bundle URL",
      async () => {
        assertCheck(bootOk, "dsh web did not become ready");
        const { cookie, location } = await mintAuthCookie(sandbox.tokenUrl);
        sandbox.cookie = cookie;

        const indexUrl = new URL(location, sandbox.tokenUrl).href;
        const response = await fetchWithCookie(indexUrl, cookie);
        assertCheck(response.status === 200, `GET ${indexUrl} expected 200, got ${response.status}`);

        const contentType = response.headers.get("content-type") ?? "";
        assertCheck(/text\/html/iu.test(contentType), `unexpected index content-type: ${contentType}`);

        const html = await response.text();
        sandbox.html = html;
        assertCheck(html.length > 1_000, `index HTML is suspiciously small (${html.length} bytes)`);

        const boot = parseBootGraph(html);
        sandbox.boot = boot;
        const entry = Array.isArray(boot.entries)
          ? boot.entries.find((candidate) => candidate?.id === PLUGIN_ID)
          : undefined;
        assertCheck(entry !== undefined, `__DSH_BOOT__ entries do not list ${PLUGIN_ID}`);
        log(`boot entry: ${JSON.stringify(entry)}`);

        const combined = findCombinedBundleUrl(html);
        assertCheck(combined !== null, `no plugins/?? script URL references ${PLUGIN_ID}`);
        sandbox.comboUrl = combined;
        log(`combined client URL: ${combined}`);

        return `200 HTML (${html.length} bytes); boot graph + combined script URL both reference ${PLUGIN_ID}`;
      },
    );

    const bundleOk = await check(
      "b: combined client bundle served with __ModuleLoader__ + plugin id",
      async () => {
        assertCheck(indexOk, "index check failed (no auth cookie or bundle URL)");
        const bundleUrl = new URL(sandbox.comboUrl, `${sandbox.origin}/`).href;
        const response = await fetchWithCookie(bundleUrl, sandbox.cookie);
        assertCheck(response.status === 200, `GET ${bundleUrl} expected 200, got ${response.status}`);

        const script = await response.text();
        assertCheck(
          script.includes("window.__ModuleLoader__.load"),
          "bundle does not contain window.__ModuleLoader__.load",
        );
        assertCheck(script.includes(PLUGIN_ID), `bundle does not contain ${PLUGIN_ID}`);
        log(`bundle: ${bundleUrl} (${script.length} bytes)`);
        return `200 JS (${script.length} bytes) contains window.__ModuleLoader__.load and ${PLUGIN_ID}`;
      },
    );

    const statsOk = await check(
      "c: /plugins/opencode-usage/stats JSON contract (provider opencode-go)",
      async () => {
        assertCheck(indexOk, "index check failed (no auth cookie)");
        const statsUrl = `${sandbox.origin}${STATS_PATH}`;
        const response = await fetchWithCookie(statsUrl, sandbox.cookie);
        const contentType = response.headers.get("content-type") ?? "";
        assertCheck(/application\/json/iu.test(contentType), `unexpected stats content-type: ${contentType}`);

        const text = await response.text();
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          throw new Error(`stats response is not JSON: ${tail(text, 240)}`);
        }
        sandbox.statsBody = body;
        log(`stats status=${response.status} body=${tail(text, 400)}`);

        assertCheck(body !== null && typeof body === "object", "stats JSON must be an object");
        assertCheck(
          body.provider === "opencode-go",
          `expected provider "opencode-go", got ${JSON.stringify(body.provider)}`,
        );
        assertCheck(typeof body.ok === "boolean", `expected boolean ok, got ${JSON.stringify(body.ok)}`);
        assertCheck(typeof body.generatedAt === "number", "expected numeric generatedAt");

        if (body.ok === true) {
          assertCheck(response.status === 200, `ok:true must be served with 200, got ${response.status}`);
          assertCheck(
            body.periods !== null && typeof body.periods === "object",
            "ok:true response must carry periods",
          );
          for (const key of ["rolling", "weekly", "monthly"]) {
            const period = body.periods[key];
            assertCheck(period !== null && typeof period === "object", `missing periods.${key}`);
            assertCheck(
              typeof period.percent === "number",
              `periods.${key}.percent must be numeric`,
            );
            assertCheck(
              typeof period.remainingPercent === "number",
              `periods.${key}.remainingPercent must be numeric`,
            );
          }
          if (MOCK) {
            // The --patch overlay must have pointed apiBaseUrl at the mock.
            assertCheck(
              body.periods.rolling.percent === 30 &&
                body.periods.weekly.percent === 60 &&
                body.periods.monthly.percent === 90,
              `mock values not reflected: ${JSON.stringify({
                rolling: body.periods.rolling.percent,
                weekly: body.periods.weekly.percent,
                monthly: body.periods.monthly.percent,
              })}`,
            );
          }
          return `provider opencode-go, ok:true, ${Object.keys(body.periods).length} periods`;
        }

        assertCheck(!MOCK, "mock mode must return ok:true, got the credential_not_configured branch");
        assertCheck(
          response.status === 424,
          `ok:false must be served with 424 (no credential), got ${response.status}`,
        );
        assertCheck(
          body.code === "credential_not_configured",
          `ok:false must carry code "credential_not_configured", got ${JSON.stringify(body.code)}`,
        );
        assertCheck(
          body.error === "credential not configured",
          `ok:false must carry the fixed error message, got ${JSON.stringify(body.error)}`,
        );
        assertCheck(
          !/Bearer|sk-/u.test(text),
          "stats error body leaks upstream credential detail",
        );
        return "provider opencode-go, 424 ok:false/credential_not_configured (no credential configured)";
      },
    );

    const fenceOk = await check(
      "d: /plugins/opencode-usage/stats without the auth cookie is 401",
      async () => {
        assertCheck(bootOk, "dsh web did not become ready");
        const response = await fetch(`${sandbox.origin}${STATS_PATH}`, {
          redirect: "manual",
          signal: AbortSignal.timeout(requestTimeoutMs()),
        });
        assertCheck(
          response.status === 401,
          `expected 401 without the browser cookie, got ${response.status}`,
        );
        log(`unauthenticated stats status=${response.status}`);
        return "401 before the handler (connection trust fence)";
      },
    );

    let mockOk = true;
    if (MOCK) {
      mockOk = await check("e: mock upstream saw one authenticated /usage request", async () => {
        assertCheck(statsOk, "stats check failed");
        const usageRequests = sandbox.mockUpstream.requests.filter(
          (request) => request.url === "/usage",
        );
        assertCheck(usageRequests.length >= 1, "mock upstream never received a /usage request");
        assertCheck(
          usageRequests.every((request) => request.authorization === "Bearer mock-key"),
          "mock upstream did not receive the configured Bearer key",
        );
        return `${usageRequests.length} authenticated /usage request(s)`;
      });
    }

    if (VERBOSE) {
      log(
        `check summary: setup=${setupOk} binary=${binaryOk} boot=${bootOk} index=${indexOk} bundle=${bundleOk} stats=${statsOk} fence=${fenceOk}${MOCK ? ` mock=${mockOk}` : ""}`,
      );
    }
  } finally {
    await cleanup();
  }

  console.log(
    failures === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures} check${failures === 1 ? "" : "s"} failed)`,
  );
  // Last-resort guarantee: never leave the dsh child behind on a thrown path.
  if (sandbox.child && sandbox.child.exitCode === null && sandbox.child.signalCode === null) {
    sandbox.child.kill("SIGKILL");
  }
  process.exitCode = failures === 0 ? 0 : 1;
  // Let stdio drain, then exit; undici keep-alive sockets must not hang the CLI.
  setTimeout(() => process.exit(process.exitCode ?? 0), 2_000).unref();
}

main().catch(async (error) => {
  console.error(`FAIL verifier crashed — ${error instanceof Error ? error.stack : String(error)}`);
  await cleanup();
  process.exitCode = 1;
});
