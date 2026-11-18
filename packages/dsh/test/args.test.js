import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIONS,
  buildArgs,
  cardIds,
  splitTokens,
  summarizeCall,
} from "../src/args.js";

test("the action set matches the CLI verbs the tool exposes", () => {
  assert.ok(ACTIONS.includes("mine"));
  assert.ok(ACTIONS.includes("claim"));
  assert.ok(ACTIONS.includes("note-remove"));
  assert.equal(new Set(ACTIONS).size, ACTIONS.length);
});

test("claim carries the id positionally and every given id", () => {
  assert.deepEqual(buildArgs({ action: "claim", id: 3 }), ["claim", "3"]);
  assert.deepEqual(buildArgs({ action: "claim", ids: [3, 4] }), [
    "claim",
    "3",
    "4",
  ]);
});

test("batch verbs take ids positionally, id alone still works", () => {
  assert.deepEqual(buildArgs({ action: "done", ids: [1, 2] }), [
    "done",
    "1",
    "2",
  ]);
  assert.deepEqual(buildArgs({ action: "done", id: 1 }), ["done", "1"]);
  assert.deepEqual(cardIds({ action: "done" }), []);
});

test("add maps fields to flags and keeps the title positional", () => {
  const argv = buildArgs({
    action: "add",
    title: "Wire retry",
    project: "infra",
    priority: "high",
    blockedBy: 7,
  });
  assert.deepEqual(argv, [
    "add",
    "Wire retry",
    "--project",
    "infra",
    "--priority",
    "high",
    "--blocked-by",
    "7",
  ]);
});

test("move keeps <id> <column> positional", () => {
  assert.deepEqual(buildArgs({ action: "move", id: 4, column: "doing" }), [
    "move",
    "4",
    "doing",
  ]);
});

test("relations and umbrellas use their own flags", () => {
  assert.deepEqual(
    buildArgs({ action: "relate", id: 1, other: 2, direction: "upstream" }),
    ["relate", "1", "--with", "2", "--as", "upstream"],
  );
  assert.deepEqual(buildArgs({ action: "parent", id: 5, parent: 2 }), [
    "parent",
    "5",
    "--of",
    "2",
  ]);
  assert.deepEqual(buildArgs({ action: "unparent", id: 5 }), ["unparent", "5"]);
});

test("notes: the remark is positional and the link is a flag", () => {
  assert.deepEqual(
    buildArgs({ action: "note", id: 2, text: "design doc", url: "docs/d.md" }),
    ["note", "2", "design doc", "--url", "docs/d.md"],
  );
  assert.deepEqual(
    buildArgs({ action: "note-edit", id: 2, noteId: 9, text: "x" }),
    ["note-edit", "2", "9", "x"],
  );
  assert.deepEqual(buildArgs({ action: "note-remove", id: 2, noteId: 9 }), [
    "note-remove",
    "2",
    "9",
  ]);
});

test("board and list pass the machine-readable flags", () => {
  assert.deepEqual(
    buildArgs({ action: "board", json: true, brief: true, project: "infra" }),
    ["board", "--project", "infra", "--json", "--brief"],
  );
  assert.deepEqual(buildArgs({ action: "list", json: true }), [
    "list",
    "--json",
  ]);
});

test("summarizeCall reads like the command line", () => {
  assert.equal(summarizeCall({ action: "claim", id: 3 }), "claim #3");
  assert.equal(summarizeCall({ action: "done", ids: [1, 2] }), "done #1 #2");
  assert.equal(
    summarizeCall({ action: "add", title: "two words" }),
    'add "two words"',
  );
  assert.equal(
    summarizeCall({ action: "move", id: 4, column: "doing" }),
    "move #4 doing",
  );
});

test("splitTokens honours quotes", () => {
  assert.deepEqual(splitTokens('add "two words" --project x'), [
    "add",
    "two words",
    "--project",
    "x",
  ]);
});
