/**
 * Give every CLI test its own home.
 *
 * `runCommand` reads `~/.config/ukb/config.json` through the `io.env` it is
 * given, and the helpers here pass only the variables a case cares about. With
 * no `HOME` in that env the config resolves against the real home, so a
 * developer whose `config.json` points at a shared board (`"server": …`) makes
 * every local-only verb fail before the test starts. The store and credentials
 * files have the same problem.
 *
 * A throwaway home per worker keeps the suite independent of the machine it
 * runs on. Tests that need a specific home still pass their own.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";

const home = mkdtempSync(join(tmpdir(), "ukb-cli-home-"));
const keys = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME"] as const;
const saved = new Map<string, string | undefined>();

beforeAll(() => {
  for (const key of keys) saved.set(key, process.env[key]);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.XDG_CONFIG_HOME;
  // A transport in the environment would outrank the home we just isolated.
  delete process.env.UKB_SERVER;
  delete process.env.UKB_TOKEN;
});

afterAll(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});
