import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createKanbanHandler } from "../src/handler.js";
import { authorizeRequest, resolveActor } from "../src/auth.js";
import { resolveServerOptions } from "../src/options.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ukb-embed-test-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("embedding the handler", () => {
  it("works as a bare (req, res) handler in any http server", async () => {
    const handler = createKanbanHandler({
      dir: tempDir(),
      token: "embed-token",
    });
    const server: Server = createServer(handler);

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    const port =
      typeof address === "object" && address !== null ? address.port : 0;

    try {
      const created = await fetch(`http://127.0.0.1:${port}/api/cards`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer embed-token",
          "X-Actor-Name": "embedder",
        },
        body: JSON.stringify({ title: "embedded card" }),
      });
      expect(created.status).toBe(201);

      const board = await fetch(`http://127.0.0.1:${port}/api/board`);
      const body = (await board.json()) as { todo: { title: string }[] };
      expect(body.todo.map((card) => card.title)).toEqual(["embedded card"]);
    } finally {
      handler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("answers CORS preflight and tags responses for embedding", async () => {
    const handler = createKanbanHandler({
      dir: tempDir(),
      token: "cors-token",
      corsOrigin: "*",
    });
    const server: Server = createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    const port =
      typeof address === "object" && address !== null ? address.port : 0;

    try {
      const preflight = await fetch(`http://127.0.0.1:${port}/api/cards`, {
        method: "OPTIONS",
        headers: { Origin: "https://my-app.example" },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
      expect(preflight.headers.get("access-control-allow-headers")).toContain(
        "Authorization",
      );

      const get = await fetch(`http://127.0.0.1:${port}/api/board`);
      expect(get.headers.get("access-control-allow-origin")).toBe("*");
    } finally {
      handler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("authorization rules", () => {
  const options = resolveServerOptions({ host: "127.0.0.1", token: "known" });
  const remoteOptions = resolveServerOptions({
    host: "0.0.0.0",
    token: "known",
  });

  function fakeReq(
    headers: Record<string, string> = {},
  ): Parameters<typeof authorizeRequest>[0] {
    return { headers, method: "POST", url: "/" } as unknown as Parameters<
      typeof authorizeRequest
    >[0];
  }

  function urlFor(search: string): URL {
    return new URL(`/${search}`, "http://localhost");
  }

  it("lets loopback reads through without a token", () => {
    expect(authorizeRequest(fakeReq(), urlFor(""), options, false).ok).toBe(
      true,
    );
  });

  it("always requires a token for mutations", () => {
    const result = authorizeRequest(fakeReq(), urlFor(""), options, true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("requires a token for reads once bound off loopback", () => {
    const result = authorizeRequest(
      fakeReq(),
      urlFor(""),
      remoteOptions,
      false,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);

    const withToken = authorizeRequest(
      fakeReq({ authorization: "Bearer known" }),
      urlFor(""),
      remoteOptions,
      false,
    );
    expect(withToken.ok).toBe(true);
  });
});

describe("actor resolution", () => {
  const fallback = { type: "human", name: "default-user" } as const;

  it("prefers headers, then query params, then the configured default", () => {
    const req = {
      headers: { "x-actor-name": "claude-code", "x-actor-type": "agent" },
    } as unknown as Parameters<typeof resolveActor>[0];
    expect(resolveActor(req, new URL("http://localhost/"), fallback)).toEqual({
      type: "agent",
      name: "claude-code",
    });

    const bare = { headers: {} } as unknown as Parameters<
      typeof resolveActor
    >[0];
    expect(
      resolveActor(
        bare,
        new URL("http://localhost/?actor=codex&actor-type=agent"),
        fallback,
      ),
    ).toEqual({
      type: "agent",
      name: "codex",
    });

    expect(resolveActor(bare, new URL("http://localhost/"), fallback)).toEqual(
      fallback,
    );
  });

  it("rejects a malformed actor with a 400", () => {
    const req = {
      headers: { "x-actor-name": "x", "x-actor-type": "robot" },
    } as unknown as Parameters<typeof resolveActor>[0];
    expect(() =>
      resolveActor(req, new URL("http://localhost/"), fallback),
    ).toThrowError(/actor/);
  });
});
