/**
 * Accounts and machine tokens for a shared board.
 *
 * A personal board used from several machines still needs one door: when the
 * server binds beyond loopback, "who may read this" stops being implied by the
 * machine. This store is the whole of that answer — named accounts with
 * scrypt-hashed passwords, plus tokens for machines that should not keep a
 * password on disk.
 *
 * It lives beside the board (`<dir>/.ukb/accounts.json`) on purpose: one store
 * directory is one board and one door, and the CLI can manage both without a
 * running server. The file is created 0600 and written atomically; passwords and
 * raw tokens never appear in it.
 */
import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  chmodSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const ACCOUNTS_FILE_NAME = "accounts.json";
export const ACCOUNT_ROLES = ["admin", "member"] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export type AccountsErrorCode =
  | "invalid_name"
  | "invalid_password"
  | "invalid_role"
  | "duplicate"
  | "not_found"
  | "invalid_file";

/** A readable failure for the CLI and the server's auth path. */
export class AccountsError extends Error {
  constructor(
    readonly code: AccountsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AccountsError";
  }
}

/** What the rest of the system gets to see about one person. */
export interface AccountUserInfo {
  readonly name: string;
  readonly role: AccountRole;
  readonly createdAt: string;
}

/** What the rest of the system gets to see about one machine token. */
export interface AccountTokenInfo {
  readonly id: string;
  readonly label: string;
  readonly user: string;
  readonly role: AccountRole;
  readonly createdAt: string;
}

export interface AccountTokenResult {
  /** The raw token — shown to the operator once, never stored. */
  readonly token: string;
  readonly record: AccountTokenInfo;
}

/** The identity behind a request, once a credential has been checked. */
export interface AccountIdentity {
  readonly name: string;
  readonly role: AccountRole;
}

interface StoredUser extends AccountUserInfo {
  readonly salt: string;
  readonly hash: string;
  readonly n: number;
  readonly r: number;
  readonly p: number;
}

interface StoredToken extends AccountTokenInfo {
  readonly hash: string;
}

interface AccountsFile {
  readonly version: 1;
  readonly users: readonly StoredUser[];
  readonly tokens: readonly StoredToken[];
}

/** scrypt parameters recorded per account so a future cost bump can migrate lazily. */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_BYTES = 16;
const SCRYPT_MAX_MEM = 64 * 1024 * 1024;

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 256;
const TOKEN_BYTES = 32;
const TOKEN_PREFIX = "ukb_";

const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;
/** A fixed salt for unknown names, so a miss costs the same as a wrong password. */
const DUMMY_SALT = Buffer.alloc(SALT_BYTES, 7);

const EMPTY_FILE: AccountsFile = { version: 1, users: [], tokens: [] };

function scrypt(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    scryptCallback(
      password,
      salt,
      KEY_LENGTH,
      { N: n, r, p, maxmem: SCRYPT_MAX_MEM },
      (error, key) => {
        if (error) reject(error);
        else resolvePromise(key);
      },
    );
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeName(raw: string): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!NAME_PATTERN.test(name)) {
    throw new AccountsError(
      "invalid_name",
      "a name is 1-64 letters, digits, dots, dashes or underscores, starting with a letter or digit",
    );
  }
  return name;
}

function checkPassword(password: string): void {
  if (
    typeof password !== "string" ||
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    throw new AccountsError(
      "invalid_password",
      `a password is ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters`,
    );
  }
}

function checkRole(role: string): AccountRole {
  if (!(ACCOUNT_ROLES as readonly string[]).includes(role)) {
    throw new AccountsError(
      "invalid_role",
      `role must be one of: ${ACCOUNT_ROLES.join(", ")}`,
    );
  }
  return role as AccountRole;
}

/**
 * The account file, read lazily and cached until its metadata changes.
 *
 * Reads compare mtime and size, so an operator editing the file (or another
 * process adding an account) is picked up without a restart, while a request
 * storm costs one stat instead of a parse.
 */
export class AccountStore {
  private cache: {
    readonly mtimeMs: number;
    readonly ctimeMs: number;
    readonly size: number;
    readonly data: AccountsFile;
  } | null = null;

  constructor(readonly path: string) {}

  /** The store for a board directory: `<dir>/.ukb/accounts.json`. */
  static inStoreDir(dir: string): AccountStore {
    return new AccountStore(join(dir, ".ukb", ACCOUNTS_FILE_NAME));
  }

  /** True when the file exists and holds at least one usable account. */
  hasUsers(): boolean {
    return this.read().users.length > 0;
  }

  listUsers(): AccountUserInfo[] {
    return [...this.read().users]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(({ name, role, createdAt }) => ({ name, role, createdAt }));
  }

  listTokens(): AccountTokenInfo[] {
    return [...this.read().tokens]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(({ id, label, user, role, createdAt }) => ({
        id,
        label,
        user,
        role,
        createdAt,
      }));
  }

  /** Adds an account. The first one is an admin by default at the CLI layer. */
  async addUser(
    rawName: string,
    password: string,
    role: AccountRole = "member",
  ): Promise<AccountUserInfo> {
    const name = normalizeName(rawName);
    checkRole(role);
    checkPassword(password);
    const data = this.read();
    if (
      data.users.some((user) => user.name.toLowerCase() === name.toLowerCase())
    ) {
      throw new AccountsError("duplicate", `account "${name}" already exists`);
    }
    const salt = randomBytes(SALT_BYTES);
    const hash = await scrypt(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
    const stored: StoredUser = {
      name,
      role,
      salt: salt.toString("base64"),
      hash: hash.toString("base64"),
      n: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      createdAt: new Date().toISOString(),
    };
    this.write({ ...data, users: [...data.users, stored] });
    return { name, role, createdAt: stored.createdAt };
  }

  /** Replaces a password; the old one stops working immediately. */
  async setPassword(rawName: string, password: string): Promise<void> {
    const name = normalizeName(rawName);
    checkPassword(password);
    const data = this.read();
    const index = data.users.findIndex(
      (user) => user.name.toLowerCase() === name.toLowerCase(),
    );
    if (index < 0) throw new AccountsError("not_found", `no account "${name}"`);
    const salt = randomBytes(SALT_BYTES);
    const hash = await scrypt(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
    const users = [...data.users];
    users[index] = {
      ...users[index]!,
      salt: salt.toString("base64"),
      hash: hash.toString("base64"),
      n: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    };
    this.write({ ...data, users });
  }

  /** Removes the account and every token that belongs to it. */
  removeUser(rawName: string): void {
    const name = normalizeName(rawName);
    const data = this.read();
    const kept = data.users.filter(
      (user) => user.name.toLowerCase() !== name.toLowerCase(),
    );
    if (kept.length === data.users.length) {
      throw new AccountsError("not_found", `no account "${name}"`);
    }
    this.write({
      ...data,
      users: kept,
      tokens: data.tokens.filter(
        (token) => token.user.toLowerCase() !== name.toLowerCase(),
      ),
    });
  }

  /** Checks a password in constant time; returns the identity or null. */
  async verifyPassword(
    rawName: string,
    password: string,
  ): Promise<AccountIdentity | null> {
    const name =
      typeof rawName === "string" ? rawName.trim().toLowerCase() : "";
    const data = this.read();
    const user = data.users.find(
      (candidate) => candidate.name.toLowerCase() === name,
    );
    if (user === undefined || typeof password !== "string") {
      // Burn the same cost as a real check so a missing name is not an oracle.
      await scrypt(
        typeof password === "string" ? password : "",
        DUMMY_SALT,
        SCRYPT_N,
        SCRYPT_R,
        SCRYPT_P,
      );
      return null;
    }
    const expected = Buffer.from(user.hash, "base64");
    const candidate = await scrypt(
      password,
      Buffer.from(user.salt, "base64"),
      user.n,
      user.r,
      user.p,
    );
    if (candidate.length !== expected.length) return null;
    if (!timingSafeEqual(candidate, expected)) return null;
    return { name: user.name, role: user.role };
  }

  /** Mints a machine token for an account; the raw value is returned once. */
  createToken(rawUser: string, label: string): AccountTokenResult {
    const name = normalizeName(rawUser);
    const user = this.read().users.find(
      (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
    );
    if (user === undefined)
      throw new AccountsError("not_found", `no account "${name}"`);
    const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
    const id = sha256(token).slice(0, 12);
    const record: AccountTokenInfo = {
      id,
      label: (label.trim() || "machine").slice(0, 64),
      user: user.name,
      role: user.role,
      createdAt: new Date().toISOString(),
    };
    this.write({
      ...this.read(),
      tokens: [...this.read().tokens, { ...record, hash: sha256(token) }],
    });
    return { token, record };
  }

  /** Looks a token up by its hash; no plaintext is ever stored. */
  verifyToken(token: string): AccountIdentity | null {
    if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX))
      return null;
    const hash = sha256(token);
    const record = this.read().tokens.find(
      (candidate) => candidate.hash === hash,
    );
    if (record === undefined) return null;
    return { name: record.user, role: record.role };
  }

  revokeToken(id: string): void {
    const data = this.read();
    const kept = data.tokens.filter((token) => token.id !== id);
    if (kept.length === data.tokens.length) {
      throw new AccountsError("not_found", `no token "${id}"`);
    }
    this.write({ ...data, tokens: kept });
  }

  private read(): AccountsFile {
    if (!existsSync(this.path)) {
      this.cache = null;
      return EMPTY_FILE;
    }
    const stat = statSync(this.path);
    if (
      this.cache !== null &&
      this.cache.mtimeMs === stat.mtimeMs &&
      this.cache.ctimeMs === stat.ctimeMs &&
      this.cache.size === stat.size
    ) {
      return this.cache.data;
    }
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      throw new AccountsError(
        "invalid_file",
        `cannot read ${this.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AccountsError("invalid_file", `${this.path} is not valid JSON`);
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== 1 ||
      !Array.isArray((parsed as { users?: unknown }).users) ||
      !Array.isArray((parsed as { tokens?: unknown }).tokens)
    ) {
      throw new AccountsError(
        "invalid_file",
        `${this.path} is not an accounts file`,
      );
    }
    this.cache = {
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      size: stat.size,
      data: parsed as AccountsFile,
    };
    return this.cache.data;
  }

  private write(data: AccountsFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, {
      mode: 0o600,
    });
    // `mode` only applies when the temp file is created; a leftover from a
    // crash could be wider, so tighten it before it becomes the account file.
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
    this.cache = null;
  }
}
