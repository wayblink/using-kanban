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
  it("drains more than 64 KiB of piped stdout before exiting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ukb-bin-test-"));
    tempDirs.push(dir);
    const kanban = openKanban({ dir, storage: "jsonl" });
    for (let index = 0; index < 40; index += 1) {
      await kanban.add(
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

  it("exits 78 with the board path when a bind needs an account", () => {
    const dir = mkdtempSync(join(tmpdir(), "ukb-bin-config-"));
    tempDirs.push(dir);

    const result = spawnSync(
      process.execPath,
      [
        bin,
        "web",
        "--dir",
        dir,
        "--host",
        "0.0.0.0",
        "--port",
        "0",
        "--no-open",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, UKB_DIR: dir },
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(78);
    expect(result.stderr).toContain(
      "refusing to bind 0.0.0.0 without accounts",
    );
    expect(result.stderr).toContain(join(dir, ".ukb"));
  });
});
