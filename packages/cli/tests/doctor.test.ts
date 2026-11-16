import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveDefaultUiDir, runCommand, type Io } from "../src/commands.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ukb-doctor-test-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeIo(dir: string, home: string = dir): Io & { out: string[] } {
  const out: string[] = [];
  return {
    cwd: dir,
    home,
    // the store is centralised, so tests say where it is
    env: { USER: "tester", UKB_MACHINE_NAME: "tester", UKB_DIR: dir },
    stdout: (text) => out.push(text),
    stderr: (text) => out.push(text),
    out,
  };
}

describe("ukb doctor", () => {
  it("reports a healthy project and exits 0", async () => {
    const dir = tempDir();
    const io = makeIo(dir);
    await runCommand(["init", "--for", "claude-code"], io);

    const doctor = makeIo(dir);
    expect(await runCommand(["doctor"], doctor)).toBe(0);
    const output = doctor.out.join("\n");
    expect(output).toContain("✓ node");
    expect(output).toContain("✓ store");
    expect(output).toContain(".ukb (sqlite");
    expect(output).toContain("✓ mcp server");
    expect(output).toContain("✓ web ui");
    expect(output).toContain("✓ identity");
    expect(output).toContain("everything looks good");
  });

  it("counts the cards on the board", async () => {
    const dir = tempDir();
    await runCommand(["add", "one"], makeIo(dir));
    await runCommand(["add", "two"], makeIo(dir));

    const io = makeIo(dir);
    await runCommand(["doctor"], io);
    expect(io.out.join("\n")).toContain("2 cards");
  });

  it("fails loudly when no framework is wired up, and says how to fix it", async () => {
    const io = makeIo(tempDir());
    expect(await runCommand(["doctor"], io)).toBe(1);
    expect(io.out.join("\n")).toContain("✗ frameworks");
    expect(io.out.join("\n")).toContain("ukb init --for");
    expect(io.out.join("\n")).toContain("1 problem(s) to fix");
  });

  it("sees a wired-up project", async () => {
    const dir = tempDir();
    const io = makeIo(dir);
    await runCommand(["init", "--for", "claude-code"], io);

    const doctor = makeIo(dir);
    await runCommand(["doctor"], doctor);
    expect(doctor.out.join("\n")).toContain("claude-code (.mcp.json)");
  });
});

/**
 * The Pi front door is the one a broken install loses silently: Pi reads the
 * package path out of `~/.pi/agent/settings.json`, and a path that moved or was
 * never written gives no board, no tools, and no error at all. `ukb doctor` is
 * where that has to surface.
 */
function piPackage(dir: string): string {
  // A stand-in for `<repo>/packages/pi`: only the manifest and the extension
  // directory matter to the check.
  const pkg = join(dir, "fixture-pi");
  mkdirSync(join(pkg, "extensions", "using-kanban"), { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "@wayblink/using-kanban-pi",
      pi: { extensions: ["./extensions"], skills: ["./skills"] },
    }),
  );
  return pkg;
}

function writePiSettings(home: string, packages: unknown[]): void {
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages }, null, 2),
  );
}

describe("ukb doctor — the Pi front door", () => {
  it("says nothing but a note when Pi has never run on this machine", async () => {
    const io = makeIo(tempDir());
    await runCommand(["doctor"], io);
    expect(io.out.join("\n")).toContain("✓ pi");
    expect(io.out.join("\n")).toContain("nothing to wire");
  });

  it("confirms the package is registered and on disk", async () => {
    const home = tempDir();
    const pkg = piPackage(home);
    writePiSettings(home, [pkg]);

    const io = makeIo(tempDir(), home);
    await runCommand(["doctor"], io);
    expect(io.out.join("\n")).toContain("✓ pi");
    expect(io.out.join("\n")).toContain("registered");
  });

  it("fails when settings.json exists but names no package", async () => {
    const home = tempDir();
    writePiSettings(home, ["npm:pi-mermaid"]);

    const io = makeIo(tempDir(), home);
    expect(await runCommand(["doctor"], io)).toBe(1);
    expect(io.out.join("\n")).toContain("✗ pi");
    expect(io.out.join("\n")).toContain("ukb init --for pi");
  });

  it("fails when the registered path is not on disk any more", async () => {
    const home = tempDir();
    writePiSettings(home, [join(home, "moved-away", "packages", "pi")]);

    const io = makeIo(tempDir(), home);
    expect(await runCommand(["doctor"], io)).toBe(1);
    expect(io.out.join("\n")).toContain("✗ pi");
    expect(io.out.join("\n")).toContain("not on disk");
  });
});

describe("default UI resolution", () => {
  it("finds the bundled Web UI directory", async () => {
    // Regression: require.resolve returns a path, not a file: URL.
    const dir = await resolveDefaultUiDir();
    expect(dir).toBeDefined();
    expect(dir).toContain("web");
    expect(dir).not.toContain("undefined");
  });
});
