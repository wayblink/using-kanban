import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RemoteBoard, type Actor } from "@wayblink/using-kanban-core";
import { startServer, type RunningServer } from "../src/server.js";

const TOKEN = "remote-test-token";
const dirs: string[] = [];
const servers: RunningServer[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ukb-remote-test-"));
  dirs.push(dir);
  return dir;
}

async function remoteBoard(token: string | null = TOKEN): Promise<{
  remote: RemoteBoard;
  server: RunningServer;
}> {
  const server = await startServer({ dir: tempDir(), token: TOKEN });
  servers.push(server);
  return {
    server,
    remote: new RemoteBoard({
      baseUrl: `http://127.0.0.1:${server.port}`,
      token,
    }),
  };
}

const alice: Actor = { type: "human", name: "alice" };

afterAll(async () => {
  await Promise.all(
    servers.map((server) => server.close().catch(() => undefined)),
  );
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("remote board", () => {
  it("drives the whole board over HTTP", async () => {
    const { remote } = await remoteBoard();

    const added = await remote.add(
      {
        title: "Remote card",
        project: "web",
        priority: "high",
        reviewer: "alice",
      },
      alice,
    );
    expect(added.card.title).toBe("Remote card");
    expect(added.card.project).toBe("web");

    const board = await remote.board();
    expect(board.todo.map((card) => card.title)).toContain("Remote card");
    expect((await remote.cards()).length).toBe(1);
    expect(await remote.projects()).toEqual(["web"]);
    expect((await remote.projectSummary())[0]).toMatchObject({
      project: "web",
      todo: 1,
    });

    const claimed = await remote.claim(added.card.id, alice);
    expect(claimed.card.state).toBe("doing");
    expect((await remote.mine("alice")).map((card) => card.id)).toContain(
      added.card.id,
    );
    expect(await remote.mine("someone-else")).toEqual([]);

    const noted = await remote.addNote(
      added.card.id,
      { text: "design doc", url: "https://example.com/doc" },
      alice,
    );
    const noteId = noted.card.notes[0]?.id;
    expect(noteId).toBeDefined();
    expect(
      (
        await remote.updateNote(
          added.card.id,
          noteId!,
          { text: "renamed" },
          alice,
        )
      ).card.notes[0]?.text,
    ).toBe("renamed");
    await remote.removeNote(added.card.id, noteId!, alice);

    const reviewed = await remote.review(added.card.id, alice);
    expect(reviewed.card.state).toBe("review");
    expect((await remote.reviewQueue("alice")).length).toBe(1);
    expect((await remote.done(added.card.id, alice)).card.state).toBe("done");
    expect((await remote.reopen(added.card.id, alice)).card.state).toBe("todo");
    expect((await remote.move(added.card.id, "doing", alice)).card.state).toBe(
      "doing",
    );

    expect((await remote.history(added.card.id)).length).toBeGreaterThan(3);
    expect(await remote.card(9999)).toBeNull();
    await expect(remote.claim(9999, alice)).rejects.toMatchObject({
      name: "KanbanError",
      code: "card_not_found",
    });

    await remote.remove(added.card.id, alice);
    expect(await remote.card(added.card.id)).toBeNull();
  });

  it("keeps hierarchy and relations on the wire", async () => {
    const { remote } = await remoteBoard();
    const parent = await remote.add({ title: "Umbrella" }, alice);
    const child = await remote.add({ title: "Part" }, alice);
    const other = await remote.add({ title: "Other" }, alice);

    const parented = await remote.parent(child.card.id, parent.card.id, alice);
    expect(parented.card.parent).toBe(parent.card.id);
    expect(
      (await remote.childrenOf(parent.card.id)).map((card) => card.id),
    ).toEqual([child.card.id]);

    const blocked = await remote.block(child.card.id, other.card.id, alice);
    expect(blocked.card.blockedBy).toContain(other.card.id);
    expect(
      (await remote.unblock(child.card.id, other.card.id, alice)).card
        .blockedBy,
    ).not.toContain(other.card.id);

    const related = await remote.relate(
      child.card.id,
      other.card.id,
      "upstream",
      alice,
    );
    expect(related.card.blockedBy).toContain(other.card.id);
    expect(
      (await remote.unrelate(child.card.id, other.card.id, alice)).card
        .blockedBy,
    ).not.toContain(other.card.id);

    expect(
      (await remote.unparent(child.card.id, alice)).card.parent,
    ).toBeNull();
  });

  it("turns a missing token into advice, not a bare 401", async () => {
    const { remote } = await remoteBoard(null);
    await expect(remote.add({ title: "nope" }, alice)).rejects.toThrow(
      /credentials/u,
    );
  });
});
