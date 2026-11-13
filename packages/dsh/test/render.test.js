import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "client.js"), "utf8");

/** One card as `ukb board --json --brief` emits it. */
function card(id, title, project, extra = {}) {
  return {
    id,
    title,
    state: "todo",
    project,
    subproject: null,
    assignee: null,
    reviewer: null,
    priority: "normal",
    blockedBy: [],
    parent: null,
    children: [],
    notes: [],
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

/** A ready board over the five state lists. */
function boardOf({ todo = [], doing = [], review = [], done = [], someday = [] }) {
  return {
    todo,
    doing,
    review,
    done,
    someday,
    identity: { owner: "jyxc", agent: "dsh" },
    generatedAt: new Date().toISOString(),
  };
}

/** A ready board with one card in each of two projects. */
function board() {
  return boardOf({ todo: [card(1, "Ukanban card", "using-kanban"), card(2, "Iceberg card", "iceberg")] });
}

/**
 * Render the panel body once against a ready board.
 *
 * Registering the module is not enough: a component that references an
 * undefined value throws on its first render, and the host blanks the slot
 * instead of showing the error. This executes the component body so that class
 * of bug fails here.
 *
 * `hooks` preloads the `useState` slots in call order: the board state, its
 * refresh nonce, the query, the project choice, the scope, density, the expanded
 * card id, the card details and the collapsed sections.
 */
function renderPanel({ state = board(), props = {}, query = "", projectChoice = undefined, scope = "all" } = {}) {
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

  const hookValues = [
    { status: "ready", board: state, identity: state.identity, error: null, at: Date.now() },
    0,
    query,
    projectChoice,
    scope,
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
    fetch: async () => ({ ok: true, text: async () => JSON.stringify(state) }),
    setInterval: () => 0,
    clearInterval: () => {},
    location: { origin: "http://example", href: "http://example/" },
    localStorage: { getItem: () => null, setItem: () => {} },
    URL,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "client.js" });

  const panel = registered.get("sidebar.right.pane.tab:@wayblink/using-kanban-dsh/board");
  assert.equal(typeof panel, "function", "panel body must be registered");
  return panel(props);
}

/** Slot props as the real tab hands them over: one session rooted at `cwd`. */
function workspaceProps(cwd) {
  const sessions = { byId: { "session-1": { cwd } } };
  return { sessionId: "session-1", useSessions: (selector) => selector(sessions) };
}

test("the board panel renders a ready board", () => {
  const tree = renderPanel();
  assert.ok(tree && typeof tree === "object", "panel must return an element tree");
  assert.equal(tree.type, "div");
  const text = JSON.stringify(tree);
  for (const expected of ["Kanban", "Refresh", "Filter cards", "Todo", "Doing", "Review", "Done", "Someday", "using-kanban", "iceberg"]) {
    assert.ok(text.includes(expected), `missing ${expected}`);
  }
});

test("the panel opens on the Session workspace's project", () => {
  const text = JSON.stringify(renderPanel({ props: workspaceProps("/Users/x/yard/using-kanban") }));
  assert.ok(text.includes("Ukanban card"), "the workspace project's card is shown");
  assert.ok(!text.includes("Iceberg card"), "another project's card is filtered out by default");
  assert.ok(text.includes("1 of 2"), "the header keeps the whole-board count alongside the filtered one");
});

test("a subdirectory of the project's repository counts as the project", () => {
  const text = JSON.stringify(renderPanel({ props: workspaceProps("/Users/x/yard/using-kanban/packages/dsh") }));
  assert.ok(text.includes("Ukanban card"));
  assert.ok(!text.includes("Iceberg card"));
});

test("choosing All projects overrides the workspace default", () => {
  const text = JSON.stringify(
    renderPanel({ props: workspaceProps("/Users/x/yard/using-kanban"), projectChoice: null }),
  );
  assert.ok(text.includes("Ukanban card"));
  assert.ok(text.includes("Iceberg card"));
  assert.ok(text.includes("2 cards"), "an explicit All projects choice reads as the whole board");
});

test("a workspace outside every project keeps the whole board", () => {
  const text = JSON.stringify(renderPanel({ props: workspaceProps("/Users/x/yard/scratch") }));
  assert.ok(text.includes("Ukanban card"));
  assert.ok(text.includes("Iceberg card"));
  assert.ok(text.includes("2 cards"));
});

test("a host without the session hook still renders", () => {
  const text = JSON.stringify(renderPanel({ props: {} }));
  assert.ok(text.includes("Ukanban card"));
  assert.ok(text.includes("Iceberg card"));
});

test("cards render as one row each, not as a two-column grid", () => {
  const text = JSON.stringify(renderPanel());
  assert.ok(!text.includes("auto-fill"), "the card grid is gone");
  assert.ok(text.includes('"data-depth":0'), "a card is a row that knows its depth");
});

test("a card's children nest under it, one row each", () => {
  const state = boardOf({
    todo: [
      card(10, "Umbrella card", "using-kanban", { children: [11, 12] }),
      card(11, "First part", "using-kanban", { parent: 10 }),
      card(12, "Second part", "using-kanban", { parent: 10 }),
    ],
  });
  const text = JSON.stringify(renderPanel({ state, props: workspaceProps("/Users/x/yard/using-kanban") }));
  for (const id of [10, 11, 12]) {
    assert.equal(text.split(`"data-card":${id}`).length - 1, 1, `#${id} is drawn once`);
  }
  assert.ok(text.indexOf('"data-card":10') < text.indexOf('"data-card":11'));
  assert.ok(text.indexOf('"data-card":11') < text.indexOf('"data-card":12'));
  assert.ok(text.includes('"data-depth":1'), "parts are indented");
});

test("an umbrella row carries its children's progress", () => {
  const state = boardOf({
    todo: [
      card(40, "Progress umbrella", "using-kanban", { children: [41, 42] }),
      card(41, "A part", "using-kanban", { parent: 40 }),
    ],
    done: [card(42, "B part", "using-kanban", { state: "done", parent: 40 })],
  });
  const text = JSON.stringify(renderPanel({ state, props: workspaceProps("/Users/x/yard/using-kanban") }));
  assert.ok(text.includes("▸1/2"), "done/total comes from the whole board");
});

test("a part in another state stays under its umbrella and is drawn once", () => {
  const state = boardOf({
    todo: [card(20, "Cross umbrella", "using-kanban", { children: [21] })],
    done: [card(21, "Done part", "using-kanban", { state: "done", parent: 20 })],
  });
  const text = JSON.stringify(renderPanel({ state, props: workspaceProps("/Users/x/yard/using-kanban") }));
  assert.equal(text.split('"data-card":21').length - 1, 1, "one card, one row");
  assert.ok(text.indexOf('"data-card":21') > text.indexOf('"data-card":20'));
  assert.ok(text.indexOf('"data-card":21') < text.indexOf("Doing"), "it sits under the umbrella, not in its own section");
});

test("a card whose umbrella is filtered out keeps the parent marker", () => {
  const state = boardOf({ todo: [card(30, "Orphan part", "using-kanban", { parent: 99 })] });
  const text = JSON.stringify(renderPanel({ state, props: workspaceProps("/Users/x/yard/using-kanban") }));
  assert.ok(text.includes("⤷#99"));
});
