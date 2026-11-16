/**
 * `ukb user …` — the door keys for a shared board.
 *
 * Accounts live beside the board (`<dir>/.ukb/accounts.json`), so a server can
 * keep running while an operator adds a person or a machine. Passwords are typed
 * without echo or piped in; nothing here ever prints one back.
 */
import { AccountStore, type AccountRole } from "@wayblink/using-kanban-core";
import { flagBoolean, flagString, UsageError } from "./argv.js";

export interface UserIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Injectable terminal reads so the command can be tested without a TTY. */
export interface UserPrompts {
  /** One line from stdin (used by `--password-stdin`). */
  readLine: () => Promise<string>;
  /** One muted line from the terminal. */
  readPassword: (prompt: string) => Promise<string>;
}

const USAGE = `ukb user — accounts for a shared board

usage:
  ukb user add <name> [--role admin|member] [--password-stdin]
  ukb user list
  ukb user passwd <name> [--password-stdin]
  ukb user remove <name>
  ukb user token add <name> [--label <text>]
  ukb user token list
  ukb user token revoke <id>

The first account is an admin. Passwords are 8-256 characters; without
--password-stdin they are typed twice, without echo.`;

function accountsFor(dir: string): AccountStore {
  return AccountStore.inStoreDir(dir);
}

function roleOf(flags: Record<string, string | true>): AccountRole | undefined {
  const value = flagString(flags, "role");
  if (value === undefined) return undefined;
  if (value !== "admin" && value !== "member") {
    throw new UsageError('--role must be "admin" or "member"');
  }
  return value;
}

async function readPassword(
  flags: Record<string, string | true>,
  prompts: UserPrompts,
  confirm: boolean,
): Promise<string> {
  if (flagBoolean(flags, "password-stdin")) {
    const password = (await prompts.readLine()).replace(/\r?\n$/, "");
    if (password === "") throw new UsageError("no password on stdin");
    return password;
  }
  const first = await prompts.readPassword("Password: ");
  if (!confirm) return first;
  const second = await prompts.readPassword("Repeat password: ");
  if (first !== second) throw new UsageError("passwords do not match");
  return first;
}

function requireName(
  positionals: readonly string[],
  index: number,
  verb: string,
): string {
  const name = positionals[index];
  if (name === undefined) throw new UsageError(`${verb} needs an account name`);
  return name;
}

/** Runs `ukb user …`; returns the process exit code. */
export async function runUserCommand(
  positionals: readonly string[],
  flags: Record<string, string | true>,
  io: UserIo,
  dir: string,
  prompts: UserPrompts = defaultPrompts(),
): Promise<number> {
  const [action, first, second] = positionals;
  const accounts = accountsFor(dir);

  switch (action) {
    case "add": {
      const name = requireName(positionals, 1, "ukb user add");
      const explicit = roleOf(flags);
      const role = explicit ?? (accounts.hasUsers() ? "member" : "admin");
      const password = await readPassword(flags, prompts, true);
      const user = await accounts.addUser(name, password, role);
      io.stdout(`account ${user.name} added (${user.role})`);
      if (
        !accounts.listUsers().some((candidate) => candidate.name !== user.name)
      ) {
        io.stdout(
          "this is the first account — it can sign in to the shared server",
        );
      }
      return 0;
    }
    case "list": {
      const users = accounts.listUsers();
      if (users.length === 0) {
        io.stdout(
          "no accounts yet — `ukb user add <name>` before exposing the server",
        );
        return 0;
      }
      for (const user of users) {
        io.stdout(`${user.name}\t${user.role}\t${user.createdAt}`);
      }
      return 0;
    }
    case "passwd": {
      const name = requireName(positionals, 1, "ukb user passwd");
      const password = await readPassword(flags, prompts, true);
      await accounts.setPassword(name, password);
      io.stdout(`password updated for ${name}`);
      return 0;
    }
    case "remove": {
      const name = requireName(positionals, 1, "ukb user remove");
      accounts.removeUser(name);
      io.stdout(`account ${name} removed (its tokens are revoked too)`);
      return 0;
    }
    case "token": {
      switch (first) {
        case "add": {
          const name = requireName(positionals, 2, "ukb user token add");
          const label = flagString(flags, "label") ?? "machine";
          const { token, record } = accounts.createToken(name, label);
          io.stdout(
            `token ${record.id} created for ${record.user} (${record.label})`,
          );
          io.stdout(token);
          io.stdout("store it now — it cannot be shown again");
          return 0;
        }
        case "list": {
          const tokens = accounts.listTokens();
          if (tokens.length === 0) {
            io.stdout(
              "no tokens yet — `ukb user token add <name> --label laptop`",
            );
            return 0;
          }
          for (const token of tokens) {
            io.stdout(
              `${token.id}\t${token.user}\t${token.label}\t${token.createdAt}`,
            );
          }
          return 0;
        }
        case "revoke": {
          const id = positionals[2];
          if (id === undefined)
            throw new UsageError("ukb user token revoke needs an id");
          accounts.revokeToken(id);
          io.stdout(`token ${id} revoked`);
          return 0;
        }
        default:
          void second;
          throw new UsageError("usage: ukb user token add|list|revoke …");
      }
    }
    default:
      throw new UsageError(USAGE);
  }
}

/** One line from a pipe; shared by `--password-stdin` and `ukb login`. */
export function readPipedLine(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      reject(new UsageError("expected a piped line on stdin"));
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (chunk: string) => {
      data += chunk;
      const newline = data.indexOf("\n");
      resolve(newline === -1 ? data : data.slice(0, newline));
      process.stdin.pause();
    });
  });
}

/** The real terminal: muted password prompts, one stdin line for pipes. */
function defaultPrompts(): UserPrompts {
  return {
    readLine: readPipedLine,
    readPassword: (prompt) =>
      new Promise((resolve) => {
        // readline's terminal mode echoes; muting `_writeToOutput` keeps the
        // password off the terminal the same way `read -s` does in a shell.
        void import("node:readline").then(({ createInterface }) => {
          const rl = createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: true,
          });
          const writeToOutput = (
            rl as unknown as { _writeToOutput?: (text: string) => void }
          )._writeToOutput;
          (rl as unknown as { _writeToOutput: () => void })._writeToOutput =
            () => {};
          rl.question(prompt, (answer) => {
            if (writeToOutput !== undefined) {
              (
                rl as unknown as { _writeToOutput: (text: string) => void }
              )._writeToOutput = writeToOutput;
            }
            rl.close();
            process.stdout.write("\n");
            resolve(answer);
          });
        });
      }),
  };
}
