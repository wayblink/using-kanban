/**
 * The executable boundary for a refused configuration.
 *
 * The refusal itself is unit-tested in options.test.ts; what matters here is
 * that `ukb-server` reports it as EX_CONFIG (78) instead of "the process
 * crashed" (1), so a supervisor can act on it.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const dirs: string[] = [];
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("the ukb-server executable", () => {
  it("exits 78 and names the board directory when a bind needs an account", () => {
    const dir = mkdtempSync(join(tmpdir(), "ukb-server-bin-test-"));
    dirs.push(dir);

    const result = spawnSync(
      process.execPath,
      [bin, "--dir", dir, "--host", "0.0.0.0", "--port", "0"],
      { encoding: "utf8" },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(78);
    expect(result.stderr).toContain(
      "refusing to bind 0.0.0.0 without accounts",
    );
    expect(result.stderr).toContain(join(dir, ".ukb"));
  });
});
