import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertBindPolicy,
  resolveServerOptions,
  ServerConfigError,
} from "../src/options.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ukb-options-test-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("the non-loopback bind policy", () => {
  it("stays out of the way on loopback", () => {
    const dir = tempDir();
    const options = resolveServerOptions({ dir, host: "127.0.0.1" });
    expect(() => assertBindPolicy(options, false)).not.toThrow();
  });

  it("lets a trusted network opt out explicitly", () => {
    const dir = tempDir();
    const options = resolveServerOptions({
      dir,
      host: "0.0.0.0",
      allowAnonymous: true,
    });
    expect(() => assertBindPolicy(options, false)).not.toThrow();
  });

  it("allows any host once an account exists", () => {
    const dir = tempDir();
    const options = resolveServerOptions({ dir, host: "0.0.0.0" });
    expect(() => assertBindPolicy(options, true)).not.toThrow();
  });

  it("reports the refusal as a setup step with the paths and commands", () => {
    const dir = tempDir();
    const options = resolveServerOptions({ dir, host: "0.0.0.0" });

    let thrown: unknown;
    try {
      assertBindPolicy(options, false);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ServerConfigError);
    const failure = thrown as ServerConfigError;
    expect(failure.message).toMatch(
      /^refusing to bind 0\.0\.0\.0 without accounts/,
    );
    expect(failure.message).toContain(dir);
    expect(failure.message).toContain(join(dir, ".ukb", "accounts.json"));
    expect(failure.message).toContain(`ukb user add <name> --dir ${dir}`);
    expect(failure.message).toContain("--allow-anonymous");
    expect(failure.exitCode).toBe(78);
  });
});

describe("auth switch", () => {
  it("maps auth off/on to allowAnonymous and openAccess", () => {
    const dir = tempDir();
    const off = resolveServerOptions({ dir, auth: false });
    expect(off.auth).toBe(false);
    expect(off.allowAnonymous).toBe(true);
    expect(off.openAccess).toBe(true);
    const on = resolveServerOptions({ dir, auth: true });
    expect(on.auth).toBe(true);
    expect(on.allowAnonymous).toBe(false);
    expect(on.openAccess).toBe(false);
    expect(resolveServerOptions({ dir }).auth).toBe(true);
  });

  it("lets a non-loopback bind start with auth off", () => {
    const dir = tempDir();
    const options = resolveServerOptions({
      dir,
      host: "0.0.0.0",
      auth: false,
    });
    expect(() => assertBindPolicy(options, false)).not.toThrow();
  });
});

describe("open access", () => {
  it("defaults to the creator/assignee guard and honors the flag", () => {
    const dir = tempDir();
    expect(resolveServerOptions({ dir }).openAccess).toBe(false);
    expect(resolveServerOptions({ dir, openAccess: true }).openAccess).toBe(
      true,
    );
  });
});
