/**
 * web-command.ts — `/ukb web` without freezing the session.
 *
 * `ukb web` is the one CLI verb that does not return: it serves the API and the
 * Web UI until it is signalled. The generic `/ukb` path awaits the CLI and
 * prints what it collected once the process is gone, so running that verb there
 * parked the whole TUI on a child that had no intention of finishing — no
 * output, no input, until the command was aborted. (The CLI is right: a server
 * started in a terminal belongs in the foreground. The extension was wrong to
 * treat a long-running verb as a one-shot.)
 *
 * So it starts it the way a server wants to be started: detached, in the
 * background, with the URL the CLI prints as its first line read back out of
 * stdout. Reading that line, rather than rebuilding the URL here, matters: the
 * port may be OS-assigned (`--port 0` is the CLI's default) and the token is
 * generated per launch, so the process that made them is the only one that
 * knows both.
 *
 * The process is handed to the caller, which owns its lifetime — this session
 * starts it, this session stops it.
 */

import { spawn } from "node:child_process";

/** The one verb that serves until signalled instead of exiting. */
export const WEB_VERB = "web";

/** `/ukb web stop` — wind this session's server down. */
export const WEB_STOP = "stop";

export const WEB_USAGE =
  "usage: /ukb web [--port N] [--no-open] [--host H] [--ui <dir>] " +
  "[--token T] [--doc-root <dir>[,<dir>]] | /ukb web stop";

/** How long the CLI gets to print its URL before the launch counts as failed. */
export const WEB_START_TIMEOUT_MS = 15_000;

/** How long a stopping server gets to exit before it is killed outright. */
export const WEB_STOP_TIMEOUT_MS = 3_000;

/**
 * How long the pipes stay open after the URL appears.
 *
 * The banner is followed by a few more lines (store, ui, docs, "Ctrl+C to
 * stop"), all issued in the same synchronous burst. The pause covers the case
 * where some are still in flight, so closing the read end cannot turn a
 * completed startup into an EPIPE.
 */
export const WEB_DETACH_DELAY_MS = 250;

export interface WebCommand {
  readonly action: "start" | "stop";
  /** Flags after the verb, handed to the CLI verbatim. */
  readonly args: readonly string[];
  readonly error: string | null;
}

/**
 * Parses the tokens after `/ukb web`.
 *
 * Lenient about flags on purpose: the CLI owns their vocabulary, and its own
 * `--help`/error text is the better teacher. `stop` is interpreted here because
 * it is the extension's word, not a CLI flag — the server it stops was started
 * by this session, and no process on the board knows about it.
 */
export function parseWebCommand(tokens: readonly string[]): WebCommand {
  const [first, ...rest] = tokens;
  if (first === undefined || first === "") {
    return { action: "start", args: [], error: null };
  }
  if (first.toLowerCase() === WEB_STOP) {
    return rest.length === 0
      ? { action: "stop", args: [], error: null }
      : {
          action: "stop",
          args: [],
          error: `ukb web stop takes no arguments — ${WEB_USAGE}`,
        };
  }
  if (first.startsWith("-")) {
    return { action: "start", args: [...tokens], error: null };
  }
  return {
    action: "start",
    args: [],
    error: `unknown ukb web argument: ${first} — ${WEB_USAGE}`,
  };
}

/**
 * The first URL in `text`. The trailing whitespace is required, not cosmetic:
 * the launcher runs this over a growing stdout buffer, and a URL cut in half by
 * a chunk boundary would otherwise be reported as a working address.
 */
const URL_PATTERN = /https?:\/\/[^\s]+(?=\s)/;

/** The URL out of the CLI's banner — `using-kanban — http://…/?token=…`. */
export function extractServerUrl(text: string): string | null {
  const match = URL_PATTERN.exec(text);
  return match === null ? null : match[0];
}

/** The slice of a readable the launcher touches. */
export interface WebStream {
  on(event: "data", listener: (chunk: { toString(): string }) => void): void;
  /** Stop reading. Writes the child already issued are unaffected. */
  destroy(): void;
}

/**
 * The slice of a `ChildProcess` the launcher touches.
 *
 * Callbacks rather than an event emitter so a test double stays a dozen lines
 * and the adapter in index.ts keeps the overloaded `once` typing out of here.
 */
export interface WebChildProcess {
  readonly stdout: WebStream | null;
  readonly stderr: WebStream | null;
  onExit(
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  onError(listener: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
  /** Let it outlive this process: an attached child holds the event loop. */
  unref(): void;
}

export type WebSpawner = (argv: readonly string[]) => WebChildProcess;

export interface DetachedWebSpawnerOptions {
  /** The ukb CLI entry point — the same bin every other door shells out to. */
  readonly script: string;
  /** Runtime for the CLI; this process' own by default (Pi runs Node or Bun). */
  readonly execPath?: string;
}

/**
 * The real spawner: the CLI in its own process group, stdio piped so the
 * launcher can read the URL.
 *
 * `detached` is what lets the server outlive the session — without it the CLI
 * would be killed along with Pi. `unref` (applied by the launcher, once the URL
 * is in hand) is what stops the child's handle from holding Pi open; the two
 * together are why `/ukb web` does not block, and why quitting Pi does not hang.
 */
export function createDetachedWebSpawner(
  options: DetachedWebSpawnerOptions,
): WebSpawner {
  const execPath = options.execPath ?? process.execPath;
  return (argv) => {
    const child = spawn(execPath, [options.script, ...argv], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      onExit: (listener) => {
        child.once("exit", (code, signal) => listener(code, signal));
      },
      onError: (listener) => {
        child.once("error", listener);
      },
      kill: (signal) => child.kill(signal),
      unref: () => child.unref(),
    };
  };
}

/** A server this session started, and the way to wind it down. */
export interface WebServer {
  /** The URL the CLI printed, token included. */
  readonly url: string;
  /** True once the process is gone, so a later `/ukb web` can start a fresh one. */
  readonly exited: boolean;
  /** SIGTERM first — the CLI closes its server on it — then SIGKILL. */
  stop(): Promise<void>;
}

export type WebLaunch =
  | { readonly ok: true; readonly server: WebServer }
  | {
      readonly ok: false;
      readonly error: string;
      readonly code: number | null;
    };

export interface LaunchWebOptions {
  /** Full CLI argv, the `web` verb included. */
  readonly argv: readonly string[];
  readonly spawn: WebSpawner;
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly detachDelayMs?: number;
}

type Exit = "exited" | "timeout";

export async function launchWebServer(
  options: LaunchWebOptions,
): Promise<WebLaunch> {
  const startTimeoutMs = options.startTimeoutMs ?? WEB_START_TIMEOUT_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? WEB_STOP_TIMEOUT_MS;
  const detachDelayMs = options.detachDelayMs ?? WEB_DETACH_DELAY_MS;

  let child: WebChildProcess;
  try {
    child = options.spawn(options.argv);
  } catch (error) {
    return {
      ok: false,
      error: `could not start ukb web — ${message(error)}`,
      code: null,
    };
  }

  let exited = false;
  let settleExit: (code: number | null) => void = () => undefined;
  const exit = new Promise<number | null>((resolve) => {
    settleExit = resolve;
  });
  child.onExit((code) => {
    exited = true;
    settleExit(code);
  });
  child.onError(() => {
    // A spawn failure has no exit event of its own; the launch promise below
    // reports why, and `stop` must not wait for a process that never existed.
    exited = true;
    settleExit(null);
  });

  const waitForExit = async (ms: number): Promise<Exit> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<Exit>((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ms);
    });
    const result = await Promise.race([
      exit.then((): Exit => "exited"),
      timeout,
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return result;
  };

  const stop = async (): Promise<void> => {
    if (exited) return;
    child.kill("SIGTERM");
    if ((await waitForExit(stopTimeoutMs)) === "timeout") {
      child.kill("SIGKILL");
      await waitForExit(1_000);
    }
  };

  const launched = await new Promise<WebLaunch>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: WebLaunch): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
      const url = extractServerUrl(stdout);
      if (url !== null) {
        finish({
          ok: true,
          server: {
            url,
            get exited() {
              return exited;
            },
            stop,
          },
        });
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.onError((error) =>
      finish({
        ok: false,
        error: `ukb web could not start — ${error.message}`,
        code: null,
      }),
    );
    child.onExit((code, signal) =>
      finish({
        ok: false,
        error: describeExit(code, signal, stdout, stderr),
        code,
      }),
    );

    // Not cleared on success: this timer is unref'd, so a server that started
    // fine does not hold the session open for the rest of the window, and the
    // `settled` guard makes the late firing a no-op instead of a kill.
    const timer = setTimeout(() => {
      if (settled) return;
      // Nothing will attach to it — an address the user never saw is a leaked
      // process, not a server.
      child.kill("SIGKILL");
      finish({
        ok: false,
        error: `ukb web reported no URL within ${Math.round(startTimeoutMs / 1000)}s${tail(stderr)}`,
        code: null,
      });
    }, startTimeoutMs);
    timer.unref();
  });

  if (launched.ok) {
    // The server must outlive the session that started it, and the pipes must
    // not hold Pi's event loop open: a detached child that is still a "waited
    // for" child keeps the process alive on quit.
    child.unref();
    // ...and the pipes stay readable for one beat, so a write still in flight
    // cannot die of EPIPE.
    setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, detachDelayMs).unref();
  }

  return launched;
}

/** What to say about a CLI that exited without serving. */
function describeExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  stdout: string,
  stderr: string,
): string {
  const how =
    code !== null
      ? ` (code ${code})`
      : signal !== null
        ? ` (signal ${signal})`
        : "";
  // stderr first — that is where a failure lands — but `/ukb web --help` is a
  // deliberate exit 0 whose useful text is on stdout.
  return `ukb web exited before serving${how}${tail(stderr) || tail(stdout)}`;
}

/** The last few lines of CLI output, short enough to read in a notification. */
function tail(text: string, lines = 3): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  const recent = trimmed.split("\n").slice(-lines).join(" ").trim();
  const clipped = recent.length > 300 ? `${recent.slice(0, 297)}…` : recent;
  return `: ${clipped}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
