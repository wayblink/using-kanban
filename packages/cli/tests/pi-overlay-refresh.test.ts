/**
 * The overlay's pure modules live in packages/pi, but that package declares no
 * dependencies on purpose: Pi supplies its host modules at runtime, and any
 * devDependency there makes pnpm auto-install those peers — a second copy of
 * pi-tui/typebox in the workspace. The modules are deliberately Pi-free (that
 * is why they are unit-testable at all), so they are exercised from this suite,
 * which already reads the packages/pi tree (see init.test.ts).
 */
import { createServer, type RequestListener } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  createOverlayRefreshScheduler,
  readRemoteOverlayBoard,
  shouldRefreshAfterCommand,
} from "../../pi/extensions/using-kanban/overlay-refresh.js";

describe("shouldRefreshAfterCommand", () => {
  it("repaints after a mutation", () => {
    // These are the verbs a human actually types, and the ones whose absence
    // from this list produced a panel that looked broken.
    for (const verb of [
      "done",
      "claim",
      "review",
      "add",
      "edit",
      "move",
      "reopen",
      "delete",
      "block",
      "unblock",
      "relate",
      "unrelate",
      "note",
      "note-edit",
      "note-remove",
    ]) {
      expect(shouldRefreshAfterCommand([verb, "1"], 0), verb).toBe(true);
    }
  });

  it("skips reads, which cannot have changed a card", () => {
    for (const verb of ["mine", "list", "board", "show", "help"]) {
      expect(shouldRefreshAfterCommand([verb], 0), verb).toBe(false);
      expect(shouldRefreshAfterCommand([verb, "319"], 0), verb).toBe(false);
    }
  });

  it("skips a failed command — it changed nothing", () => {
    expect(shouldRefreshAfterCommand(["done", "319"], 2)).toBe(false);
    expect(shouldRefreshAfterCommand(["bogus"], 1)).toBe(false);
  });

  it("treats an unknown verb as a mutation, not as a read", () => {
    // The denylist is the point: a verb added later repaints by default rather
    // than silently leaving the panel stale.
    expect(shouldRefreshAfterCommand(["archive", "319"], 0)).toBe(true);
  });

  it("treats no verb as the default read", () => {
    expect(shouldRefreshAfterCommand([], 0)).toBe(false);
  });

  it("ignores flags when deciding, since the verb leads", () => {
    expect(shouldRefreshAfterCommand(["board", "--project", "web"], 0)).toBe(
      false,
    );
    expect(shouldRefreshAfterCommand(["done", "--agent", "pi"], 0)).toBe(true);
  });
});

async function withBoardServer(
  handler: RequestListener,
  test: (url: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a TCP address");
    }
    await test(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("remote Pi overlay", () => {
  it("reads the summary and global project list in one authenticated request", async () => {
    const requests: Array<[string | undefined, string | undefined]> = [];
    const snapshot = {
      someday: [],
      todo: [{ id: 1, title: "Remote task", project: "repo" }],
      doing: [],
      review: [],
      done: [],
      projects: ["repo"],
    };
    await withBoardServer(
      (req, res) => {
        requests.push([req.url, req.headers.authorization]);
        res.end(JSON.stringify(snapshot));
      },
      async (server) => {
        const read = await readRemoteOverlayBoard(server, "test-token");
        expect(read.error).toBeNull();
        expect(JSON.parse(read.stdout ?? "")).toEqual(snapshot);
        expect(requests).toEqual([
          ["/api/board?summary=1", "Bearer test-token"],
        ]);
      },
    );
  });

  it("times out if the server sends headers but stalls before the board arrives", async () => {
    await withBoardServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write("{");
      },
      async (server) => {
        const read = await readRemoteOverlayBoard(server, null, 150);
        expect(read.stdout).toBeNull();
        expect(read.error).toMatch(/timed out/i);
      },
    );
  });

  it("explains how to sign in when the remote board returns 401", async () => {
    await withBoardServer(
      (_req, res) => {
        res.writeHead(401).end();
      },
      async (server) => {
        const read = await readRemoteOverlayBoard(server, null);
        expect(read.stdout).toBeNull();
        expect(read.error).toContain("ukb login");
      },
    );
  });

  it("returns immediately while a read is pending and coalesces overlapping refreshes", async () => {
    let finish = () => {};
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const schedule = createOverlayRefreshScheduler(refresh);

    expect(schedule()).toBeUndefined();
    schedule();
    schedule();
    expect(refresh).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
