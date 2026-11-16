import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server.js";

const dirs: string[] = [];
const servers: RunningServer[] = [];
const TOKEN = "compression-token";

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ukb-compression-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    servers.map((server) => server.close().catch(() => undefined)),
  );
  servers.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

async function uiServer(): Promise<{ base: string; marker: string }> {
  const dir = tempDir();
  const uiDir = join(dir, "ui");
  mkdirSync(uiDir, { recursive: true });
  const marker = "compression-check-marker";
  writeFileSync(
    join(uiDir, "index.html"),
    `<!doctype html><title>ukb</title><p>${marker}</p>${"x".repeat(4096)}`,
  );
  const server = await startServer({
    dir,
    token: TOKEN,
    uiDir,
    // The UI is served on loopback; the test is about the wire, not auth.
    port: 0,
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, marker };
}

async function apiServer(): Promise<string> {
  const server = await startServer({ dir: tempDir(), token: TOKEN });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

describe("transport compression", () => {
  it("gzips the static UI and revalidates with an ETag", async () => {
    const { base, marker } = await uiServer();

    const compressed = await fetch(`${base}/`, {
      headers: { "accept-encoding": "gzip" },
    });
    expect(compressed.status).toBe(200);
    expect(compressed.headers.get("content-encoding")).toBe("gzip");
    expect(compressed.headers.get("vary")).toContain("Accept-Encoding");
    expect(await compressed.text()).toContain(marker);
    const etag = compressed.headers.get("etag");
    expect(etag).toBeTruthy();

    const revalidated = await fetch(`${base}/`, {
      headers: { "accept-encoding": "gzip", "if-none-match": etag ?? "" },
    });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe("");
  });

  it("gzips a large board payload but not a small one", async () => {
    const base = await apiServer();
    for (let index = 0; index < 30; index += 1) {
      const response = await fetch(`${base}/api/cards`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
          "X-Actor-Name": "compression",
        },
        body: JSON.stringify({
          title: `card ${index}`,
          body: "body ".repeat(80),
        }),
      });
      expect(response.status).toBe(201);
    }

    const compressed = await fetch(`${base}/api/board?summary=1`, {
      headers: { "accept-encoding": "gzip" },
    });
    expect(compressed.status).toBe(200);
    expect(compressed.headers.get("content-encoding")).toBe("gzip");
    const board = (await compressed.json()) as { todo: unknown[] };
    expect(board.todo.length).toBe(30);

    const plain = await fetch(`${base}/api/board?summary=1`, {
      headers: { "accept-encoding": "identity" },
    });
    expect(plain.headers.get("content-encoding")).toBeNull();

    const small = await fetch(`${base}/healthz`, {
      headers: { "accept-encoding": "gzip" },
    });
    expect(small.headers.get("content-encoding")).toBeNull();
  });
});
