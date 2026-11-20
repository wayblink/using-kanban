import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Execute the browser module against a stub context and return what it built.
 * The factory must produce `{ inject, apply }`; the tests reach the pure
 * helpers through `internals`, because a browser bundle cannot import its
 * Node-testable siblings.
 */
function loadClient({
  fetch = async () => ({ ok: true, text: async () => "{}" }),
} = {}) {
  const calls = { tabs: [], slots: [], openTab: [] };
  const context = {
    effect(fn) {
      const disposer = fn();
      return typeof disposer === "function" ? disposer : () => {};
    },
    slots: {
      inject(_owner, fn) {
        return fn();
      },
      register(options, component) {
        assert.equal(
          typeof component,
          "function",
          "slot component must be a function",
        );
        calls.slots.push(`${options.name}:${options.key ?? options.id}`);
        return () => {};
      },
    },
    sidebarRightTabs: {
      register(definition) {
        calls.tabs.push(definition);
        return () => {};
      },
    },
    sidebarRight: {
      openTab(kind) {
        calls.openTab.push(kind);
      },
    },
  };
  const React = {
    createElement: (...args) => args,
    useState: (value) => [
      typeof value === "function" ? value() : value,
      () => {},
    ],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  };
  /** @type {{ inject: string[], apply: Function, internals?: object } | null} */
  let module = null;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load({ factory }) {
          module = factory((name) => {
            if (name === "react") return React;
            throw new Error(`unexpected require ${name}`);
          });
          assert.ok(Array.isArray(module.inject));
          module.apply(context);
        },
      },
    },
    document: { baseURI: "http://example/" },
    fetch,
    setInterval: () => 0,
    clearInterval: () => {},
    URL,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    readFileSync(join(here, "..", "client.js"), "utf8"),
    sandbox,
    { filename: "client.js" },
  );
  return { module, calls };
}

/**
 * This is the contract the Client loader relies on; a typo in a slot name fails
 * here instead of blanking the slot in the page.
 */
test("the client module registers the panel, the chip and the tool view", () => {
  const { calls } = loadClient();

  const [definition] = calls.tabs;
  assert.equal(definition.kind, "ukb-board");
  assert.equal(typeof definition.title, "function");
  assert.equal(definition.title(""), "Kanban");
  assert.ok(Array.isArray(definition.guide) && definition.guide.length === 1);

  const keys = calls.slots.join(",");
  assert.ok(keys.includes(`sidebar.right.pane.tab:${definition.id}`));
  assert.ok(keys.includes("conversation.composer.dock"));
  assert.ok(keys.includes("tool.call.toolview:ukb"));
});

/**
 * The Full board button only has one contract with the Host: ask
 * `GET api/ukb/web`, prefer the first JSON answer, and return the URL it
 * carries. The panel opens the tab; the Host owns the process.
 */
test("startFullBoard returns the URL the Host answered with", async () => {
  const asked = [];
  const { module } = loadClient({
    fetch: async (url) => {
      asked.push(String(url));
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            url: "http://127.0.0.1:7321/?token=abc",
            mode: "local",
            reused: false,
          }),
      };
    },
  });

  const result = await module.internals.startFullBoard();
  assert.equal(result.ok, true);
  assert.equal(result.url, "http://127.0.0.1:7321/?token=abc");
  assert.equal(result.mode, "local");
  assert.ok(asked.some((url) => url.endsWith("/api/ukb/web")));
});

test("startFullBoard reports a Host failure instead of a blank tab", async () => {
  const { module } = loadClient({
    fetch: async () => ({
      ok: false,
      status: 502,
      text: async () => JSON.stringify({ error: "ukb CLI not found" }),
    }),
  });

  const result = await module.internals.startFullBoard();
  assert.equal(result.ok, false);
  assert.match(result.error, /ukb CLI not found/);
});
