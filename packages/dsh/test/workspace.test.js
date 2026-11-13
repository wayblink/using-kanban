import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "client.js"), "utf8");

/**
 * Execute the browser module against the smallest loader stub and hand back
 * what its factory returned. The factory body needs no document, fetch or
 * timers to exist — those are reached through component functions only.
 */
function loadClientModule() {
  let module = null;
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
          module = factory((name) => {
            if (name === "react") return React;
            throw new Error(`unexpected require ${name}`);
          });
        },
      },
    },
    document: { baseURI: "http://example/" },
    setInterval: () => 0,
    clearInterval: () => {},
    URL,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "client.js" });
  assert.ok(module !== null, "the module loader was handed a factory");
  return module;
}

const { projectFromWorkspace } = loadClientModule().internals;
const PROJECTS = ["iceberg", "using-kanban", "using-memory"];

test("the workspace directory itself names its project", () => {
  assert.equal(
    projectFromWorkspace("/Users/x/yard/using-kanban", PROJECTS),
    "using-kanban",
  );
});

test("a session opened in a subdirectory still finds the project", () => {
  assert.equal(
    projectFromWorkspace("/Users/x/yard/using-kanban/packages/dsh", PROJECTS),
    "using-kanban",
  );
});

test("the deepest matching segment wins over an outer one", () => {
  assert.equal(
    projectFromWorkspace("/work/iceberg/using-kanban", PROJECTS),
    "using-kanban",
  );
  assert.equal(
    projectFromWorkspace("/work/using-kanban/iceberg", PROJECTS),
    "iceberg",
  );
});

test("a partial segment is not a project", () => {
  assert.equal(
    projectFromWorkspace("/work/using-kanban-tools", PROJECTS),
    null,
  );
  assert.equal(projectFromWorkspace("/work/preusing-kanban", PROJECTS), null);
});

test("a folder that names no project stays unscoped", () => {
  assert.equal(projectFromWorkspace("/Users/x/yard/scratch", PROJECTS), null);
  assert.equal(projectFromWorkspace("/Users/x", PROJECTS), null);
});

test("a trailing slash and Windows separators still match", () => {
  assert.equal(
    projectFromWorkspace("/work/using-kanban/", PROJECTS),
    "using-kanban",
  );
  assert.equal(
    projectFromWorkspace("C:\\work\\using-kanban\\packages", PROJECTS),
    "using-kanban",
  );
});

test("matching ignores case; the board's spelling is returned", () => {
  assert.equal(
    projectFromWorkspace("/Work/Using-Kanban/packages", PROJECTS),
    "using-kanban",
  );
});

test("missing input forces the unscoped view instead of throwing", () => {
  assert.equal(projectFromWorkspace(undefined, PROJECTS), null);
  assert.equal(projectFromWorkspace("", PROJECTS), null);
  assert.equal(projectFromWorkspace(null, PROJECTS), null);
  assert.equal(projectFromWorkspace("/work/using-kanban", []), null);
  assert.equal(projectFromWorkspace("/work/using-kanban", undefined), null);
  assert.equal(projectFromWorkspace("/work/using-kanban", ["", null]), null);
});
