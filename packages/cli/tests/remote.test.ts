import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "@wayblink/using-kanban-server";
import { resolveCredentialsPath } from "@wayblink/using-kanban-config";
import { runCommand, type Io } from "../src/commands.js";

const TOKEN = "cli-remote-token";
const servers: RunningServer[] = [];

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ukb-cli-remote-"));
}

async function serve(): Promise<string> {
  const server = await startServer({ dir: tempDir(), token: TOKEN });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

function capture(env: NodeJS.ProcessEnv): {
  io: Io;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      cwd: tempDir(),
      env,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    },
  };
}

afterAll(async () => {
  await Promise.all(
    servers.map((server) => server.close().catch(() => undefined)),
  );
});

describe("remote mode", () => {
  it("writes to the server and never touches the local store", async () => {
    const server = await serve();
    const localDir = tempDir();
    const { io, out } = capture({
      ...process.env,
      UKB_DIR: localDir,
      UKB_SERVER: server,
      UKB_TOKEN: TOKEN,
    });

    await runCommand(["add", "Remote card", "--project", "web"], io);
    expect(out.join("\n")).toContain("created");

    const board = capture({
      ...process.env,
      UKB_SERVER: server,
      UKB_TOKEN: TOKEN,
    });
    await runCommand(["board", "--json"], board.io);
    const parsed = JSON.parse(board.out.join("\n")) as {
      todo: { title: string }[];
    };
    expect(parsed.todo.map((card) => card.title)).toContain("Remote card");

    expect(existsSync(join(localDir, ".ukb"))).toBe(false);
  });

  it("stores a token with ukb login and reuses it", async () => {
    const server = await serve();
    const configHome = tempDir();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: tempDir(),
      XDG_CONFIG_HOME: configHome,
      UKB_SERVER: server,
    };

    const login = capture(env);
    await runCommand(["login", "--server", server, "--token", TOKEN], login.io);
    expect(login.out.join("\n")).toContain("signed in");

    const credentials = resolveCredentialsPath(env);
    expect(statSync(credentials).mode & 0o777).toBe(0o600);

    // No UKB_TOKEN here: the stored credential is what authenticates the write.
    const write = capture({ ...env });
    await runCommand(["add", "Via stored token"], write.io);
    expect(write.out.join("\n")).toContain("created");

    const logout = capture(env);
    await runCommand(["logout", "--server", server], logout.io);
    expect(logout.out.join("\n")).toContain("signed out");
  });

  it("refuses local-only commands when pointed at a server", async () => {
    const server = await serve();
    const { io } = capture({
      ...process.env,
      UKB_SERVER: server,
      UKB_TOKEN: TOKEN,
    });
    await expect(runCommand(["user", "list"], io)).rejects.toThrow(
      /runs on the machine/,
    );
  });
});
