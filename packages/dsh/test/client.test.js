import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Execute the browser module against a stub context: the factory must produce
 * `{ inject, apply }`, and apply must register the board panel, the composer
 * chip and the tool view. This is the contract the Client loader relies on; a
 * typo in a slot name fails here instead of blanking the slot in the page.
 */
test("the client module registers the panel, the chip and the tool view", () => {
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
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load({ factory }) {
          const module = factory((name) => {
            if (name === "react") return React;
            throw new Error(`unexpected require ${name}`);
          });
          assert.ok(Array.isArray(module.inject));
          module.apply(context);
        },
      },
    },
    document: { baseURI: "http://example/" },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
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
