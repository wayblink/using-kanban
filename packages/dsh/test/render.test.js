import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Render the panel once with a ready board.
 *
 * Registering the module is not enough: a component that references an
 * undefined value throws on its first render, and the host blanks the slot
 * instead of showing the error. This executes the component body so that class
 * of bug fails here.
 */
test("the board panel renders a ready board", () => {
  const registered = new Map();
  const context = {
    effect: (fn) => {
      const disposer = fn();
      return typeof disposer === "function" ? disposer : () => {};
    },
    slots: {
      inject: (_owner, fn) => fn(),
      register: (options, component) => {
        registered.set(`${options.name}:${options.key ?? options.id}`, component);
        return () => {};
      },
    },
    sidebarRightTabs: { register: () => () => {} },
    sidebarRight: { openTab: () => {} },
  };

  const board = {
    todo: [{ id: 199, title: "C2 RAG KnowledgeIndex", state: "todo", project: "civil-core", assignee: null, reviewer: null, priority: "high", blockedBy: [], notes: [] }],
    doing: [],
    review: [{ id: 244, title: "C4 civil run CLI", state: "review", project: "civil-core", assignee: "dsh", reviewer: "jyxc", priority: "normal", blockedBy: [198], notes: [{}] }],
    done: [],
    someday: [],
    identity: { owner: "jyxc", agent: "dsh" },
    generatedAt: new Date().toISOString(),
  };

  const hookValues = [
    { status: "ready", board, identity: board.identity, error: null, at: Date.now() },
    0,
    "",
    null,
    "all",
    false,
    null,
    {},
    new Set(),
  ];
  let hookIndex = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: () => {
      const value = hookValues[hookIndex];
      hookIndex += 1;
      return [value, () => {}];
    },
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
          module.apply(context);
        },
      },
    },
    document: { baseURI: "http://example/" },
    fetch: async () => ({ ok: true, text: async () => JSON.stringify(board) }),
    setInterval: () => 0,
    clearInterval: () => {},
    location: { origin: "http://example", href: "http://example/" },
    localStorage: { getItem: () => null, setItem: () => {} },
    URL,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(here, "..", "client.js"), "utf8"), sandbox, { filename: "client.js" });

  const panel = registered.get("sidebar.right.pane.tab:@wayblink/using-kanban-dsh/board");
  assert.equal(typeof panel, "function", "panel body must be registered");

  const tree = panel({});
  assert.ok(tree && typeof tree === "object", "panel must return an element tree");
  assert.equal(tree.type, "div");
  const text = JSON.stringify(tree);
  for (const expected of ["Kanban", "Refresh", "Filter cards", "Todo", "Doing", "Review", "Done", "Someday", "civil-core"]) {
    assert.ok(text.includes(expected), `missing ${expected}`);
  }
});
