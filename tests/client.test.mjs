/**
 * Client-half hermetic tests for lib/client.js.
 *
 * lib/client.js is a browser bundle: it calls window.__ModuleLoader__.load at
 * top level and uses `document` only for the CSS-injection guard. This test
 * installs the minimal browser globals, imports the file once, then drives the
 * captured factory with a fake `require("react")` and a fake plugin ctx.
 *
 * Zero dependencies: `node --test tests/*.test.mjs`.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = join(HERE, "..", "lib", "client.js");
const PLUGIN_ID = "dsh-plugin-opencode-usage";
const STATS_URL = "/plugins/opencode-usage/stats";
const REAL_FETCH = globalThis.fetch;

/** Let the fetch effect's promise chain settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Just enough DOM for the stylesheet guard in lib/client.js. */
function createDocumentStub() {
  const state = { queried: [], created: [], appended: [] };
  const styleTag = { dataset: {}, textContent: "" };
  const document = {
    querySelector(selector) {
      state.queried.push(selector);
      return null;
    },
    createElement(tagName) {
      state.created.push(tagName);
      return styleTag;
    },
    head: {
      appendChild(node) {
        state.appended.push(node);
        return node;
      },
    },
  };
  return { document, state, styleTag };
}

/**
 * Minimal React surface used by lib/client.js: element factory plus the hooks
 * it calls. Hooks are plain functions (no dispatcher), so a function component
 * can be invoked directly; `stateOverrides` lets a test seed useState results
 * in call order. Effects are recorded (never auto-run) so a test can drive the
 * stats effect itself, and every useState setter records its calls.
 */
function createReactStub({ stateOverrides = [] } = {}) {
  let useStateIndex = 0;
  const effects = [];
  const stateSetters = [];
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
    useId() {
      return "dsh-test-panel-id";
    },
    useRef(initial = null) {
      return { current: initial };
    },
    useState(initial) {
      const index = useStateIndex;
      useStateIndex += 1;
      const value =
        index < stateOverrides.length
          ? stateOverrides[index]
          : typeof initial === "function"
            ? initial()
            : initial;
      const setter = (...args) => {
        stateSetters.push({ index, args });
      };
      return [value, setter];
    },
    useEffect(fn, deps) {
      effects.push({ kind: "effect", fn, deps });
    },
    useLayoutEffect(fn, deps) {
      effects.push({ kind: "layout", fn, deps });
    },
    effects,
    stateSetters,
  };
}

/** The stats-fetch useEffect is the only one with [open, request] deps. */
function findFetchEffect(reactStub) {
  const candidates = reactStub.effects.filter(
    (effect) => effect.kind === "effect" && Array.isArray(effect.deps) && effect.deps.length === 2,
  );
  assert.equal(candidates.length, 1, "expected exactly one useEffect keyed on [open, request]");
  return candidates[0];
}

/** Recursively expand function components so a render proves the whole idle tree works. */
function renderTree(node, depth = 0) {
  if (depth > 65) throw new Error("render tree recursion exceeded");
  if (Array.isArray(node)) return node.map((child) => renderTree(child, depth + 1));
  if (node === null || typeof node !== "object") return node;
  if (typeof node.type === "function") {
    return renderTree(node.type({ ...node.props, children: node.children }), depth + 1);
  }
  return {
    ...node,
    children: (node.children ?? []).map((child) => renderTree(child, depth + 1)),
  };
}

/** Minimal translation helper: t(key) -> key, t(key, params) -> readable string. */
function makeT() {
  return (key, params) => {
    if (params === undefined) return key;
    const pairs = Object.entries(params)
      .map(([name, value]) => `${name}=${String(value)}`)
      .join(";");
    return `${key}(${pairs})`;
  };
}

const documentStub = createDocumentStub();
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      capturedDefinition = definition;
    },
  },
};
globalThis.document = documentStub.document;

let capturedDefinition = null;
await import(pathToFileURL(CLIENT_PATH).href);

if (capturedDefinition === null) {
  throw new Error("lib/client.js did not call window.__ModuleLoader__.load");
}

/** Invoke the captured factory with a fresh React stub and a strict require(). */
function loadClientExports(reactStub = createReactStub()) {
  const factory = capturedDefinition.factory;
  assert.equal(typeof factory, "function", "window.__ModuleLoader__.load({factory}) must be a function");
  const required = [];
  const exportsObject = factory((request) => {
    required.push(request);
    if (request === "react") return reactStub.react ?? reactStub;
    throw new Error(`unexpected require(${JSON.stringify(request)})`);
  });
  assert.deepEqual(required, ["react"]);
  return { exports: exportsObject, reactStub };
}

/** Fake plugin ctx exposing only the seams lib/client.js touches. */
function createClientCtx() {
  const state = {
    effects: [],
    localeRegistrations: [],
    slotInjections: [],
    slotRegistrations: [],
  };
  const ctx = {
    effect(fn, label) {
      state.effects.push(label);
      return fn();
    },
    locale: {
      register(namespace, dictionaries) {
        state.localeRegistrations.push({ namespace, dictionaries });
        return () => {};
      },
    },
    slots: {
      inject(slotName, register) {
        state.slotInjections.push(slotName);
        return register();
      },
      register(definition, component) {
        state.slotRegistrations.push({ definition, component });
        return () => {};
      },
    },
  };
  return { ctx, state };
}

after(() => {
  delete globalThis.window;
  delete globalThis.document;
});

// ---------------------------------------------------------------------------
// module registration
// ---------------------------------------------------------------------------

test("loads through window.__ModuleLoader__.load with the plugin id and a factory", () => {
  assert.equal(capturedDefinition.id, PLUGIN_ID);
  assert.equal(typeof capturedDefinition.factory, "function");
});

test("injects the stylesheet when no matching style tag exists", () => {
  // The CSS guard runs inside the factory, so drive it once and inspect the DOM stub.
  documentStub.state.queried.length = 0;
  documentStub.state.created.length = 0;
  documentStub.state.appended.length = 0;
  loadClientExports();

  assert.equal(documentStub.state.queried.length, 1);
  assert.equal(
    documentStub.state.queried[0],
    'style[data-plugin-css="dsh-plugin-opencode-usage/OpenCodeUsagePanel.css"]',
  );
  assert.deepEqual(documentStub.state.created, ["style"]);
  assert.equal(documentStub.state.appended.length, 1);
  assert.equal(documentStub.styleTag.dataset.plugin, PLUGIN_ID);
  assert.equal(
    documentStub.styleTag.dataset.pluginCss,
    `${PLUGIN_ID}/OpenCodeUsagePanel.css`,
  );
  assert.match(documentStub.styleTag.textContent, /\.ou_layer/);
  assert.match(documentStub.styleTag.textContent, /\.ou_panel/);
});

test("factory exports the documented inject/NS/apply surface", () => {
  const { exports } = loadClientExports();

  assert.deepEqual(exports.inject, ["slots", "locale"]);
  assert.equal(exports.NS, "opencodeUsage");
  assert.equal(typeof exports.apply, "function");
});

// ---------------------------------------------------------------------------
// apply()
// ---------------------------------------------------------------------------

test("apply() registers zh+en dictionaries through ctx.locale.register", () => {
  const { exports } = loadClientExports();
  const { ctx, state } = createClientCtx();

  exports.apply(ctx);

  assert.deepEqual(state.effects, ["opencode-usage: dictionaries"]);
  assert.equal(state.localeRegistrations.length, 1);
  const [{ namespace, dictionaries }] = state.localeRegistrations;
  assert.equal(namespace, "opencodeUsage");
  assert.deepEqual(Object.keys(dictionaries).sort(), ["en", "zh"]);
  for (const language of ["zh", "en"]) {
    const dictionary = dictionaries[language];
    assert.equal(typeof dictionary, "object");
    for (const key of ["trigger", "panelTitle", "loading", "error", "retry", "close", "credentialMissing"]) {
      assert.equal(typeof dictionary[key], "string", `${language}.${key} must be a string`);
      assert.ok(dictionary[key].length > 0, `${language}.${key} must not be empty`);
    }
  }
  // Both dictionaries must cover the same keys or one locale will render raw keys.
  assert.deepEqual(Object.keys(dictionaries.zh).sort(), Object.keys(dictionaries.en).sort());
});

test("apply() registers the shell.overlay slot with id opencode-usage", () => {
  const { exports } = loadClientExports();
  const { ctx, state } = createClientCtx();

  exports.apply(ctx);

  assert.deepEqual(state.slotInjections, ["shell.overlay"]);
  assert.equal(state.slotRegistrations.length, 1);
  const [{ definition, component }] = state.slotRegistrations;
  assert.deepEqual(definition, {
    name: "shell.overlay",
    id: "opencode-usage",
    order: 100,
    locale: "opencodeUsage",
  });
  assert.equal(typeof component, "function");
});

test("the registered component renders the idle state without throwing", () => {
  const { exports } = loadClientExports();
  const { ctx, state } = createClientCtx();
  exports.apply(ctx);
  const component = state.slotRegistrations[0].component;
  const t = makeT();

  const tree = component({ t });

  assert.equal(tree.type, "div");
  assert.equal(tree.props.className, "ou_layer");
  assert.equal(tree.children[0], null, "the panel must be closed in the idle state");

  const footer = tree.children.find(
    (child) => child && child.type === "div" && child.props.className === "ou_footerButtons",
  );
  assert.ok(footer, "the overlay must always render its footer trigger container");
  const button = footer.children[0];
  assert.equal(button.type, "button");
  assert.equal(button.props.className, "ou_badge");
  assert.equal(button.props["aria-expanded"], false);
  assert.equal(button.props["aria-label"], "trigger");

  // Expanding nested function components (icons) must also be throw-free.
  const rendered = renderTree(tree);
  const serialized = JSON.stringify(rendered);
  assert.match(serialized, /ou_badgeLabel/);
  assert.match(serialized, /"svg"/);
});

test("the registered component renders a ready snapshot without throwing", () => {
  const snapshot = {
    ok: true,
    provider: "opencode-go",
    generatedAt: Date.UTC(2026, 10, 2, 5, 0, 0),
    periods: {
      rolling: { key: "rolling", status: "ok", percent: 30, remainingPercent: 70, resetsAt: "2026-11-02T05:00:00Z" },
      weekly: { key: "weekly", status: "ok", percent: 82, remainingPercent: 18, resetsAt: "2026-11-08T00:00:00Z" },
      monthly: { key: "monthly", status: "ok", percent: 100, remainingPercent: 0, resetsAt: null },
    },
  };
  // useState call order in the panel: open, request, state, placement.
  const { exports } = loadClientExports(
    createReactStub({ stateOverrides: [true, 0, { status: "ready", snapshot }, null] }),
  );
  const { ctx, state } = createClientCtx();
  exports.apply(ctx);
  const component = state.slotRegistrations[0].component;
  const t = makeT();

  const tree = component({ t });
  const rendered = renderTree(tree);
  const serialized = JSON.stringify(rendered);

  assert.match(serialized, /ou_panel/);
  assert.match(serialized, /ou_cards/);
  assert.match(serialized, /ou_progressFill/);
  assert.match(serialized, /"data-level":"warn"/);
  assert.match(serialized, /"data-level":"danger"/);
  assert.match(serialized, /limitReached/);
});

// ---------------------------------------------------------------------------
// stats fetch effect (STATS_URL, same-origin credentials, coded errors)
// ---------------------------------------------------------------------------

/** Render the panel open, then drive its stats-fetch effect with a stub response. */
async function runStatsEffect(response) {
  const reactStub = createReactStub({
    stateOverrides: [true, 0, { status: "idle" }, null],
  });
  const { exports } = loadClientExports(reactStub);
  const { ctx, state } = createClientCtx();
  exports.apply(ctx);
  const component = state.slotRegistrations[0].component;
  component({ t: makeT() });

  const fetchCalls = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init });
    return response;
  };

  const effect = findFetchEffect(reactStub);
  const cleanup = effect.fn();
  await flush();
  return { reactStub, fetchCalls, cleanup };
}

test("the stats effect fetches STATS_URL with same-origin credentials", async () => {
  try {
    const snapshot = {
      ok: true,
      provider: "opencode-go",
      generatedAt: Date.UTC(2026, 10, 2, 5, 0, 0),
      periods: {
        rolling: { key: "rolling", status: "ok", percent: 30, remainingPercent: 70, resetsAt: null },
        weekly: { key: "weekly", status: "ok", percent: 19, remainingPercent: 81, resetsAt: null },
        monthly: { key: "monthly", status: "ok", percent: 9, remainingPercent: 91, resetsAt: null },
      },
    };
    const { reactStub, fetchCalls, cleanup } = await runStatsEffect({
      ok: true,
      status: 200,
      json: async () => snapshot,
    });

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, STATS_URL);
    assert.deepEqual(fetchCalls[0].init, { cache: "no-store", credentials: "same-origin" });
    assert.equal(typeof cleanup, "function");

    const stateCalls = reactStub.stateSetters
      .map((call) => call.args[0])
      .filter((value) => value && typeof value === "object" && typeof value.status === "string");
    assert.deepEqual(stateCalls[0], { status: "loading" });
    assert.deepEqual(stateCalls.at(-1), { status: "ready", snapshot });
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
});

test("a non-OK JSON body produces a coded error state (code copied from the body)", async () => {
  try {
    const { reactStub, fetchCalls } = await runStatsEffect({
      ok: false,
      status: 424,
      json: async () => ({
        ok: false,
        code: "credential_not_configured",
        error: "credential not configured",
      }),
    });

    assert.equal(fetchCalls.length, 1);
    const errorStates = reactStub.stateSetters
      .map((call) => call.args[0])
      .filter((value) => value && value.status === "error");
    assert.equal(errorStates.length, 1, "the failed fetch must end in one error state");
    assert.deepEqual(errorStates[0], {
      status: "error",
      message: "credential not configured",
      code: "credential_not_configured",
    });
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
});

test("a non-JSON failure body reports the HTTP status instead of throwing the parse error", async () => {
  try {
    const { reactStub } = await runStatsEffect({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    });

    const errorStates = reactStub.stateSetters
      .map((call) => call.args[0])
      .filter((value) => value && value.status === "error");
    assert.equal(errorStates.length, 1);
    assert.match(errorStates[0].message, /non-JSON response \(HTTP 502\)/);
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
});

// ---------------------------------------------------------------------------
// error-state rendering
// ---------------------------------------------------------------------------

/** Render the panel open with a seeded error state; returns the serialized tree. */
function renderErrorState(errorState) {
  const reactStub = createReactStub({ stateOverrides: [true, 0, errorState, null] });
  const { exports } = loadClientExports(reactStub);
  const { ctx, state } = createClientCtx();
  exports.apply(ctx);
  const component = state.slotRegistrations[0].component;
  const tree = component({ t: makeT() });
  return { reactStub, serialized: JSON.stringify(renderTree(tree)) };
}

test("an error render uses credentialMissing when code is credential_not_configured", () => {
  const errorState = {
    status: "error",
    message: "credential not configured",
    code: "credential_not_configured",
  };
  const { reactStub, serialized } = renderErrorState(errorState);

  assert.match(serialized, /ou_failure/);
  assert.match(serialized, /credentialMissing/);
  assert.doesNotMatch(serialized, /error: credential not configured/);

  // The hardened hook sequence gained a useEffect keyed on [state].
  assert.ok(
    reactStub.effects.some(
      (effect) =>
        effect.kind === "effect" &&
        Array.isArray(effect.deps) &&
        effect.deps.length === 1 &&
        effect.deps[0] === errorState,
    ),
    "expected a useEffect re-measuring placement on [state]",
  );
});

test("an error render falls back to 'error: message' for other codes", () => {
  const { serialized } = renderErrorState({
    status: "error",
    message: "usage query failed",
    code: "usage_query_failed",
  });

  assert.match(serialized, /error: usage query failed/);
  assert.doesNotMatch(serialized, /credentialMissing/);
});
