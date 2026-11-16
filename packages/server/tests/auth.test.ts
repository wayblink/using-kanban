import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AccountStore } from "@wayblink/using-kanban-core";
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

  it("refuses a non-loopback bind without accounts", async () => {
    const dir = tempDir();
    await expect(
      startServer({ dir, host: "0.0.0.0", port: 0, token: TOKEN }),
    ).rejects.toThrow(/refusing to bind/);
  });
});
