import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AccountStore, AccountsError } from "../src/accounts.js";

function store(): { dir: string; accounts: AccountStore } {
  const dir = mkdtempSync(join(tmpdir(), "ukb-accounts-"));
  return { dir, accounts: AccountStore.inStoreDir(dir) };
}

function fileOf(dir: string): string {
  return join(dir, ".ukb", "accounts.json");
}

describe("AccountStore", () => {
  it("creates a 0600 file that never holds the plain password", async () => {
    const { dir, accounts } = store();
    await accounts.addUser("alice", "correct horse battery", "admin");

    expect(accounts.hasUsers()).toBe(true);
    expect(statSync(fileOf(dir)).mode & 0o777).toBe(0o600);
    const raw = readFileSync(fileOf(dir), "utf8");
    expect(raw).not.toContain("correct horse battery");

    expect(
      await accounts.verifyPassword("alice", "correct horse battery"),
    ).toEqual({
      name: "alice",
      role: "admin",
    });
    expect(await accounts.verifyPassword("alice", "wrong password")).toBeNull();
    expect(await accounts.verifyPassword("nobody", "whatever")).toBeNull();
  });

  it("rejects duplicate names case-insensitively, bad names and short passwords", async () => {
    const { accounts } = store();
    await accounts.addUser("alice", "long enough password", "member");
    await expect(
      accounts.addUser("Alice", "another password", "member"),
    ).rejects.toMatchObject({
      code: "duplicate",
    });
    await expect(
      accounts.addUser("a:b", "long enough password"),
    ).rejects.toMatchObject({
      code: "invalid_name",
    });
    await expect(
      accounts.addUser("", "long enough password"),
    ).rejects.toMatchObject({
      code: "invalid_name",
    });
    await expect(accounts.addUser("bob", "short")).rejects.toMatchObject({
      code: "invalid_password",
    });
  });

  it("persists across instances and follows a password change", async () => {
    const { dir, accounts } = store();
    await accounts.addUser("alice", "first password ok", "admin");
    await accounts.setPassword("alice", "second password ok");

    const reopened = AccountStore.inStoreDir(dir);
    expect(
      await reopened.verifyPassword("alice", "first password ok"),
    ).toBeNull();
    expect(
      await reopened.verifyPassword("alice", "second password ok"),
    ).toEqual({
      name: "alice",
      role: "admin",
    });
  });

  it("removes a user and revokes their tokens with them", async () => {
    const { accounts } = store();
    await accounts.addUser("alice", "long enough password", "admin");
    await accounts.addUser("bob", "long enough password", "member");
    const { token } = accounts.createToken("bob", "laptop");
    expect(accounts.verifyToken(token)).not.toBeNull();

    accounts.removeUser("bob");
    expect(accounts.hasUsers()).toBe(true);
    expect(accounts.listUsers().map((user) => user.name)).toEqual(["alice"]);
    expect(accounts.verifyToken(token)).toBeNull();
  });

  it("shows a token once, stores only its hash and revokes by id", async () => {
    const { dir, accounts } = store();
    await accounts.addUser("alice", "long enough password", "admin");
    const { token, record } = accounts.createToken("alice", "laptop");

    expect(token.startsWith("ukb_")).toBe(true);
    expect(record.id).toHaveLength(12);
    expect(record.label).toBe("laptop");
    expect(readFileSync(fileOf(dir), "utf8")).not.toContain(token.slice(4));
    expect(accounts.verifyToken(token)).toMatchObject({
      name: "alice",
      role: "admin",
    });
    expect(accounts.verifyToken("ukb_nope")).toBeNull();

    expect(accounts.listTokens()).toEqual([
      expect.objectContaining({
        id: record.id,
        label: "laptop",
        user: "alice",
      }),
    ]);
    accounts.revokeToken(record.id);
    expect(accounts.verifyToken(token)).toBeNull();
  });

  it("fails closed on a malformed file", async () => {
    const { dir } = store();
    const path = fileOf(dir);
    await (
      await import("node:fs/promises")
    ).mkdir(join(dir, ".ukb"), { recursive: true });
    await (
      await import("node:fs/promises")
    ).writeFile(path, "{not json", { mode: 0o600 });
    const accounts = AccountStore.inStoreDir(dir);
    expect(() => accounts.hasUsers()).toThrow(AccountsError);
    await expect(
      accounts.verifyPassword("alice", "whatever ok"),
    ).rejects.toThrow(AccountsError);
  });

  it("never leaks hashes through the list views", async () => {
    const { accounts } = store();
    await accounts.addUser("alice", "long enough password", "admin");
    const text = JSON.stringify(accounts.listUsers());
    expect(text).not.toContain("hash");
    expect(text).not.toContain("salt");
  });
});
