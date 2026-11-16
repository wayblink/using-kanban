import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AccountStore } from "@wayblink/using-kanban-core";
import { runUserCommand, type UserIo, type UserPrompts } from "../src/user.js";

function boardDir(): string {
  return mkdtempSync(join(tmpdir(), "ukb-user-test-"));
}

function capture(): { io: UserIo; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    io: {
      cwd: process.cwd(),
      env: process.env,
      stdout: (text) => lines.push(text),
      stderr: () => {},
    },
  };
}

function prompts(passwords: readonly string[], stdin = ""): UserPrompts {
  let index = 0;
  return {
    readLine: async () => stdin,
    readPassword: async () => {
      // A single value stands for the pair (password + confirmation).
      const value = passwords[Math.min(index, passwords.length - 1)] ?? "";
      index += 1;
      return value;
    },
  };
}

describe("ukb user", () => {
  it("makes the first account an admin and later ones members", async () => {
    const dir = boardDir();
    const first = capture();
    await runUserCommand(
      ["add", "alice"],
      {},
      first.io,
      dir,
      prompts(["alice password"]),
    );
    const second = capture();
    await runUserCommand(
      ["add", "bob"],
      {},
      second.io,
      dir,
      prompts(["bob password!"]),
    );

    expect(first.lines.join("\n")).toContain("account alice added (admin)");
    expect(second.lines.join("\n")).toContain("account bob added (member)");
    expect([...first.lines, ...second.lines].join("\n")).not.toContain(
      "alice password",
    );
  });

  it("honours an explicit role and lists accounts without secrets", async () => {
    const dir = boardDir();
    await runUserCommand(
      ["add", "carol"],
      { role: "admin" },
      capture().io,
      dir,
      prompts(["carol password"]),
    );
    const listing = capture();
    await runUserCommand(["list"], {}, listing.io, dir);
    const text = listing.lines.join("\n");
    expect(text).toContain("carol\tadmin");
    expect(text).not.toContain("hash");
    expect(text).not.toContain("salt");
  });

  it("refuses mismatched password confirmation", async () => {
    await expect(
      runUserCommand(
        ["add", "dave"],
        {},
        capture().io,
        boardDir(),
        prompts(["one password", "two password"]),
      ),
    ).rejects.toThrow("passwords do not match");
  });

  it("reads a piped password without touching the terminal prompt", async () => {
    const dir = boardDir();
    let prompted = false;
    const stdinPrompts: UserPrompts = {
      readLine: async () => "erin password\n",
      readPassword: async () => {
        prompted = true;
        return "";
      },
    };
    await runUserCommand(
      ["add", "erin"],
      { "password-stdin": true },
      capture().io,
      dir,
      stdinPrompts,
    );
    expect(prompted).toBe(false);
    const accounts = AccountStore.inStoreDir(dir);
    expect(
      await accounts.verifyPassword("erin", "erin password"),
    ).toMatchObject({ name: "erin" });
  });

  it("shows a machine token once, then lists and revokes it", async () => {
    const dir = boardDir();
    await runUserCommand(
      ["add", "alice"],
      {},
      capture().io,
      dir,
      prompts(["alice password"]),
    );

    const minted = capture();
    await runUserCommand(
      ["token", "add", "alice", "--label", "laptop"],
      { label: "laptop" },
      minted.io,
      dir,
      prompts([]),
    );
    const token = minted.lines.find((line) => line.startsWith("ukb_"));
    expect(token).toBeDefined();
    const accounts = AccountStore.inStoreDir(dir);
    expect(accounts.verifyToken(token!)).toMatchObject({ name: "alice" });

    const listing = capture();
    await runUserCommand(["token", "list"], {}, listing.io, dir);
    const listed = listing.lines.find((line) => line.includes("\tlaptop\t"));
    expect(listed).toBeDefined();
    const id = listed!.split("\t")[0]!;

    const revoked = capture();
    await runUserCommand(["token", "revoke", id], {}, revoked.io, dir);
    expect(revoked.lines.join("\n")).toContain(`token ${id} revoked`);
    expect(accounts.verifyToken(token!)).toBeNull();
  });

  it("removes an account", async () => {
    const dir = boardDir();
    await runUserCommand(
      ["add", "alice"],
      {},
      capture().io,
      dir,
      prompts(["alice password"]),
    );
    const removed = capture();
    await runUserCommand(["remove", "alice"], {}, removed.io, dir);
    expect(removed.lines.join("\n")).toContain("account alice removed");
    expect(AccountStore.inStoreDir(dir).hasUsers()).toBe(false);
  });

  it("says what to do when there are no accounts yet", async () => {
    const listing = capture();
    await runUserCommand(["list"], {}, listing.io, boardDir());
    expect(listing.lines.join("\n")).toContain("no accounts yet");
  });
});
