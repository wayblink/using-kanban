import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { openKanban } from "@wayblink/using-kanban-core";
import { startServer, type RunningServer } from "../src/server.js";

const TOKEN = "test-token";
const tempDirs: string[] = [];
const running: RunningServer[] = [];

let baseUrl = "";
let currentDir = "";

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ukb-sse-test-"));
  tempDirs.push(dir);
  currentDir = dir;
  const server = await startServer({ dir, token: TOKEN });
  running.push(server);
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await Promise.all(
    running.map((server) => server.close().catch(() => undefined)),
  );
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface SseEvent {
  id: number;
  type: string;
  cardId: number;
  actor: { name: string };
}

/** Reads `count` SSE data events, then disconnects. */
async function readSseEvents(
  path: string,
  count: number,
  timeoutMs = 8000,
): Promise<SseEvent[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events: SseEvent[] = [];

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body?.getReader();
    if (!reader) throw new Error("no response body");
    const decoder = new TextDecoder();
    let buffer = "";

    while (events.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trim())
          .join("");
        if (data.length > 0) {
          events.push(JSON.parse(data) as SseEvent);
        }
      }
    }
    await reader.cancel();
  } finally {
    clearTimeout(timer);
    controller.abort();
  }

  return events;
}

describe("SSE event stream", () => {
  it("backfills events after the requested cursor", async () => {
    await fetch(`${baseUrl}/api/cards?token=${TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "one" }),
    });
    await fetch(`${baseUrl}/api/cards?token=${TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "two" }),
    });

    const events = await readSseEvents(`/api/events?token=${TOKEN}&since=0`, 2);
    expect(events.map((event) => event.type)).toEqual([
      "card.created",
      "card.created",
    ]);
    expect(events.map((event) => event.cardId)).toEqual([1, 2]);
  });

  it("streams events written by another process — the CLI or an MCP server", async () => {
    const stream = readSseEvents(`/api/events?token=${TOKEN}`, 3);

    // Give the stream a moment to connect, then write from a separate instance
    // sharing the same store — exactly how the CLI behaves.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const cli = openKanban({ dir: currentDir });
    cli.add(
      { title: "created by the CLI" },
      { type: "human", name: "jyxc" },
      "cli",
    );
    const { card } = cli.add(
      { title: "claimed by the CLI" },
      { type: "human", name: "jyxc" },
      "cli",
    );
    cli.claim(card.id, { type: "agent", name: "claude-code" }, "mcp");
    cli.close();

    const events = await stream;
    expect(events.map((event) => event.type)).toEqual([
      "card.created",
      "card.created",
      "card.moved",
    ]);
    expect(events[2]?.actor.name).toBe("claude-code");
    expect(events.map((event) => event.id)).toEqual([1, 2, 3]);
  });

  it("honours the since cursor for late joiners", async () => {
    const cli = openKanban({ dir: currentDir });
    cli.add({ title: "old" }, { type: "human", name: "jyxc" });
    cli.close();

    const stream = readSseEvents(`/api/events?token=${TOKEN}&since=1`, 1);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const writer = openKanban({ dir: currentDir });
    writer.add({ title: "new" }, { type: "human", name: "jyxc" });
    writer.close();

    const events = await stream;
    expect(events).toHaveLength(1);
    expect(events[0]?.cardId).toBe(2);
  });
});
