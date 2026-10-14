/**
 * The executable boundary, not `runCommand`.
 *
 * `process.stdout.write()` is asynchronous when stdout is a pipe. Calling
 * `process.exit()` immediately after it used to cut a large `board --json`
 * response at exactly 64 KiB on macOS — valid data in a terminal, malformed
 * JSON when the Pi extension captured it. Unit tests that invoke runCommand
 * directly cannot catch that lifecycle bug, so this test spawns the built bin.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { openKanban, type Actor } from "@wayblink/using-kanban-core";

const tempDirs: string[] = [];
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const actor: Actor = { type: "agent", name: "pi" };

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the ukb executable", () => {
  it("drains more than 64 KiB of piped stdout before exiting", () => {
    const dir = mkdtempSync(join(tmpdir(), "ukb-bin-test-"));
    tempDirs.push(dir);
    const kanban = openKanban({ dir, storage: "jsonl" });
    for (let index = 0; index < 40; index += 1) {
      kanban.add(
        {
          title: `large card ${index}`,
          body: `body-${index}-` + "x".repeat(2_500),
        },
        actor,
        "cli",
      );
    }

    const result = spawnSync(process.execPath, [bin, "board", "--json"], {
      encoding: "utf8",
      env: { ...process.env, UKB_DIR: dir, UKB_STORAGE: "jsonl" },
      maxBuffer: 2 * 1024 * 1024,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(Buffer.byteLength(result.stdout)).toBeGreaterThan(65_536);
    const parsed = JSON.parse(result.stdout) as { todo: unknown[] };
    expect(parsed.todo).toHaveLength(40);
  });
});
