import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AccountStore } from "@wayblink/using-kanban-core";
import { authorizeRequest, LoginThrottle } from "../src/auth.js";
import { resolveServerOptions } from "../src/options.js";
import { startServer, type RunningServer } from "../src/server.js";

const TOKEN = "server-token";
const dirs: string[] = [];
const servers: RunningServer[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ukb-auth-test-"));
  dirs.push(dir);
  return dir;
}

async function serving(dir: string): Promise<string> {
  const server = await startServer({ dir, token: TOKEN });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

async function withAccount(): Promise<{
  baseUrl: string;
  accounts: AccountStore;
}> {
  const dir = tempDir();
  const accounts = AccountStore.inStoreDir(dir);
  await accounts.addUser("alice", "alice password", "admin");
  return { baseUrl: await serving(dir), accounts };
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

afterAll(async () => {
  await Promise.all(
    servers.map((server) => server.close().catch(() => undefined)),
  );
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("accounts on the server", () => {
  it("asks for credentials once an account exists", async () => {
    const { baseUrl } = await withAccount();
    const response = await fetch(`${baseUrl}/api/board`);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Basic /);
  });

  it("accepts the password and tells the caller who they are", async () => {
    const { baseUrl } = await withAccount();
    const response = await fetch(`${baseUrl}/api/me`, {
      headers: { authorization: basic("alice", "alice password") },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { user?: string; role?: string };
    expect(body.user).toBe("alice");
    expect(body.role).toBe("admin");
  });

  it("closes the board on a wrong password", async () => {
    const { baseUrl } = await withAccount();
    const response = await fetch(`${baseUrl}/api/board`, {
      headers: { authorization: basic("alice", "not the password") },
    });
    expect(response.status).toBe(401);
  });

  it("accepts a machine token instead of a password", async () => {
    const { baseUrl, accounts } = await withAccount();
    const { token } = accounts.createToken("alice", "laptop");
    const response = await fetch(`${baseUrl}/api/board`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
  });

  it("keeps the generated server token usable for scripts", async () => {
    const { baseUrl } = await withAccount();
    const response = await fetch(`${baseUrl}/api/board?token=${TOKEN}`);
    expect(response.status).toBe(200);
  });

  it("leaves the health probe open", async () => {
    const { baseUrl } = await withAccount();
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
  });

  it("protects static files too", async () => {
    const { baseUrl } = await withAccount();
    expect((await fetch(`${baseUrl}/`)).status).toBe(401);
  });

  it("keeps loopback behavior when there are no accounts", async () => {
    const baseUrl = await serving(tempDir());
    expect((await fetch(`${baseUrl}/api/board`)).status).toBe(200);
    const mutation = await fetch(`${baseUrl}/api/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "no token" }),
    });
    expect(mutation.status).toBe(401);
  });

  it("refuses a non-loopback bind without accounts, as a setup step", async () => {
    const dir = tempDir();
    const failure = await startServer({
      dir,
      host: "0.0.0.0",
      port: 0,
      token: TOKEN,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    const error = failure as Error & { exitCode?: number };
    expect(error.message).toMatch(
      /^refusing to bind 0\.0\.0\.0 without accounts/,
    );
    expect(error.message).toContain(join(dir, ".ukb"));
    expect(error.exitCode).toBe(78);
  });

  it("refuses even when the accounts file exists but holds no users", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, ".ukb"), { recursive: true });
    writeFileSync(
      join(dir, ".ukb", "accounts.json"),
      JSON.stringify({ version: 1, users: [], tokens: [] }),
    );
    await expect(
      startServer({ dir, host: "0.0.0.0", port: 0, token: TOKEN }),
    ).rejects.toThrow(/refusing to bind/);
  });
});

describe("a trusted network without accounts", () => {
  const guest = (authorization?: string): IncomingMessage =>
    ({
      headers: authorization === undefined ? {} : { authorization },
    }) as unknown as IncomingMessage;

  const lan = (dir: string, allowAnonymous = true) =>
    resolveServerOptions({
      dir,
      host: "0.0.0.0",
      token: TOKEN,
      allowAnonymous,
    });

  it("lets anonymous readers in when the flag marks the network trusted", async () => {
    const dir = tempDir();
    const options = lan(dir);
    const result = await authorizeRequest(
      guest(),
      new URL("http://board.lan/api/board"),
      options,
      AccountStore.inStoreDir(dir),
      false,
      "192.168.1.20",
      new LoginThrottle(),
    );
    expect(result.ok).toBe(true);
  });

  it("still requires the machine token to mutate", async () => {
    const dir = tempDir();
    const options = lan(dir);
    const accounts = AccountStore.inStoreDir(dir);

    const refused = await authorizeRequest(
      guest(),
      new URL("http://board.lan/api/cards"),
      options,
      accounts,
      true,
      "192.168.1.20",
      new LoginThrottle(),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.status).toBe(401);

    const allowed = await authorizeRequest(
      guest(`Bearer ${TOKEN}`),
      new URL("http://board.lan/api/cards"),
      options,
      accounts,
      true,
      "192.168.1.20",
      new LoginThrottle(),
    );
    expect(allowed.ok).toBe(true);
  });

  it("leaves anonymous reads closed unless the flag is set", async () => {
    const dir = tempDir();
    const result = await authorizeRequest(
      guest(),
      new URL("http://board.lan/api/board"),
      lan(dir, false),
      AccountStore.inStoreDir(dir),
      false,
      "192.168.1.20",
      new LoginThrottle(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("keeps accounts stricter even when the flag is set", async () => {
    const dir = tempDir();
    await AccountStore.inStoreDir(dir).addUser(
      "alice",
      "alice password",
      "admin",
    );
    const result = await authorizeRequest(
      guest(),
      new URL("http://board.lan/api/board"),
      lan(dir),
      AccountStore.inStoreDir(dir),
      false,
      "192.168.1.20",
      new LoginThrottle(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });
});

describe("auth off", () => {
  it("lets an anonymous request through without opening accounts", async () => {
    const dir = tempDir();
    await AccountStore.inStoreDir(dir).addUser(
      "alice",
      "alice password",
      "admin",
    );
    const options = resolveServerOptions({
      dir,
      host: "0.0.0.0",
      token: TOKEN,
      auth: false,
    });
    const result = await authorizeRequest(
      { headers: {} } as unknown as IncomingMessage,
      new URL("http://board.lan/api/cards"),
      options,
      AccountStore.inStoreDir(dir),
      true,
      "192.168.1.20",
      new LoginThrottle(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.identity).toBeNull();
  });
});
