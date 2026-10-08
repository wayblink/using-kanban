import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "@using-kanban/server";

const tempDirs: string[] = [];
const running: RunningServer[] = [];

const UI_DIR = new URL("../src", import.meta.url).pathname;
const DIST_DIR = new URL("../dist", import.meta.url).pathname;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ukb-web-test-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(
    running.map((server) => server.close().catch(() => undefined)),
  );
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function startWithUi(): Promise<RunningServer> {
  const server = await startServer({
    dir: tempDir(),
    token: "web-token",
    uiDir: UI_DIR,
  });
  running.push(server);
  return server;
}

describe("serving the default UI", () => {
  it("serves index.html, the stylesheet, and the app module", async () => {
    const server = await startWithUi();
    const base = `http://127.0.0.1:${server.port}`;

    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    const html = await index.text();
    expect(html).toContain("using-kanban");
    expect(html).toContain("./app.js");

    const css = await fetch(`${base}/style.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toContain("--col-todo");

    const js = await fetch(`${base}/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    const app = await js.text();
    expect(app).toContain("actionForColumn");
    expect(app).toContain("EventSource");
  });

  it("serves the tokenised URL as a single entry point", async () => {
    const server = await startWithUi();
    expect(server.url).toContain("token=web-token");

    const withToken = await fetch(server.url);
    expect(withToken.status).toBe(200);
  });

  it("never serves content from outside the UI directory", async () => {
    const server = await startWithUi();
    const base = `http://127.0.0.1:${server.port}`;

    // fetch() normalises dot segments client-side, and encoded variants resolve
    // to non-existent filenames inside the UI dir, so every attempt falls back
    // to the SPA shell. What matters: nothing from outside ever leaks.
    for (const path of [
      "/../package.json",
      "/../../etc/passwd",
      "/..%2f..%2fpackage.json",
      "/%2e%2e/package.json",
      "/src/../package.json",
    ]) {
      const response = await fetch(`${base}${path}`);
      const text = await response.text();
      expect(text).not.toContain('"name": "@using-kanban/web"');
      expect(text).not.toContain("root:x:");
      expect(text.startsWith("<!doctype html>")).toBe(true);
    }
  });

  it("falls back to the UI shell for unknown asset paths", async () => {
    const server = await startWithUi();
    const response = await fetch(
      `http://127.0.0.1:${server.port}/does-not-exist.js`,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<!doctype html>");
  });

  it("still serves the API alongside the UI", async () => {
    const server = await startWithUi();
    const base = `http://127.0.0.1:${server.port}`;

    const created = await fetch(`${base}/api/cards?token=web-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Actor-Name": "jyxc" },
      body: JSON.stringify({ title: "ui card" }),
    });
    expect(created.status).toBe(201);

    const board = await fetch(`${base}/api/board`);
    const body = (await board.json()) as { todo: { title: string }[] };
    expect(body.todo.map((card) => card.title)).toEqual(["ui card"]);
  });
});

describe("the inlined single-file build", () => {
  it("is self-contained and still serves the board", async () => {
    if (!existsSync(DIST_DIR)) {
      // `pnpm build` (node scripts/inline.mjs) produces it.
      throw new Error("packages/web/dist is missing — run the build first");
    }

    const server = await startServer({
      dir: tempDir(),
      token: "inline-token",
      uiDir: DIST_DIR,
    });
    running.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(response.status).toBe(200);
    const html = await response.text();

    // No external assets: CSS and JS are inlined.
    expect(html).not.toContain("./style.css");
    expect(html).not.toContain("./app.js");
    expect(html).toContain("<style>");
    expect(html).toContain("actionForColumn");
    expect(html).toContain("EventSource");

    // And the API it talks to is still there.
    const created = await fetch(
      `http://127.0.0.1:${server.port}/api/cards?token=inline-token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Actor-Name": "jyxc" },
        body: JSON.stringify({ title: "inline card" }),
      },
    );
    expect(created.status).toBe(201);
  });
});
