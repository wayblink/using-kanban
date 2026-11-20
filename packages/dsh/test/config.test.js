import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readUkbConfig, ukbConfigPath } from "../src/config.js";

/**
 * The bundle reads the same `config.json` as the CLI, MCP server and Web UI.
 * A missing or broken file must degrade to defaults: the panel still renders,
 * and the CLI is the one that reports the broken config.
 */
test("the CLI config is read where the CLI reads it, and never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "ukb-dsh-config-"));
  try {
    assert.deepEqual(readUkbConfig({ XDG_CONFIG_HOME: dir }), {});
    assert.equal(
      ukbConfigPath({ XDG_CONFIG_HOME: dir }),
      join(dir, "ukb", "config.json"),
    );

    mkdirSync(join(dir, "ukb"), { recursive: true });
    writeFileSync(
      join(dir, "ukb", "config.json"),
      JSON.stringify({ owner: "me", server: "https://kb.example.com" }),
    );
    assert.equal(readUkbConfig({ XDG_CONFIG_HOME: dir }).owner, "me");

    writeFileSync(join(dir, "ukb", "config.json"), "{ not json");
    assert.deepEqual(readUkbConfig({ XDG_CONFIG_HOME: dir }), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
