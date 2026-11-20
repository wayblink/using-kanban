/**
 * web.js — start `ukb web` (the full board UI) for the DSH panel's Full board
 * button.
 *
 * `ukb web` is the one CLI verb that does not return: it serves the API and the
 * Web UI until it is signalled. The panel is a browser half and cannot spawn a
 * process, so the Host starts the CLI detached, reads the URL the CLI prints —
 * the port may be OS-assigned and the token is generated per launch, so the
 * process that made them is the only one that knows both — and hands that URL
 * back for the page to open in a tab.
 *
 * This is the Pi extension's `/ukb web` launcher
 * (`packages/pi/extensions/using-kanban/web-command.ts`) ported to plain JS:
 * same detached start, same URL-from-the-banner rule, same SIGTERM-then-SIGKILL
 * stop. The bundle ships without a build step, which is why the logic is not
 * imported from the TypeScript package.
 */

import { spawn } from "node:child_process";

/** The one verb that serves until signalled instead of exiting. */
export const WEB_VERB = "web";

/** The page opens the tab; a browser on the Host machine would be a second one. */
export const WEB_ARGS = Object.freeze(["--no-open"]);

/** How long the CLI gets to print its URL before the launch counts as failed. */
export const WEB_START_TIMEOUT_MS = 15_000;

/** How long a stopping server gets to exit before it is killed outright. */
export const WEB_STOP_TIMEOUT_MS = 3_000;

/**
 * How long the pipes stay open after the URL appears. The banner is followed by
 * a few more lines from the same synchronous burst, and closing the read end
 * mid-write would turn a completed startup into an EPIPE.
 */
export const WEB_DETACH_DELAY_MS = 250;

/**
 * The first URL in `text`. The trailing whitespace is required, not cosmetic:
 * this runs over a growing stdout buffer, and a URL cut in half by a chunk
 * boundary would otherwise be reported as a working address.
 */
const URL_PATTERN = /https?:\/\/[^\s]+(?=\s)/;

/** The URL out of the CLI's banner — `using-kanban — http://…/?token=…`. */
export function extractServerUrl(text) {
  const match = URL_PATTERN.exec(text);
  return match === null ? null : match[0];
}

/**
 * The full board when the CLI is pointed at a shared server.
 *
 * `ukb web` is a local-mode verb (the server lives on the machine that owns the
 * store), so a remote board is opened at its own URL instead of being started
 * here. `UKB_SERVER` wins over the config file, exactly as in the CLI.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ server?: unknown } | null | undefined} config
 * @returns {string | null}
 */
export function remoteWebUrl(env, config) {
  const fromEnv = env.UKB_SERVER?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const fromConfig =
    typeof config?.server === "string" ? config.server.trim() : "";
  return fromConfig === "" ? null : fromConfig;
}

/**
 * @typedef {object} WebStream
 * @property {(event: "data", listener: (chunk: { toString(): string }) => void) => void} on
 * @property {() => void} destroy
 *
 * @typedef {object} WebChildProcess
 * @property {WebStream | null} stdout
 * @property {WebStream | null} stderr
 * @property {(listener: (code: number | null, signal: NodeJS.Signals | null) => void) => void} onExit
 * @property {(listener: (error: Error) => void) => void} onError
 * @property {(signal?: NodeJS.Signals) => boolean} kill
 * @property {() => void} unref
 */

/**
 * @typedef {object} WebServer
 * @property {string} url the URL the CLI printed, token included
 * @property {boolean} exited true once the process is gone, so a later click
 *   starts a fresh one instead of reusing a dead address
 * @property {() => Promise<void>} stop SIGTERM first — the CLI closes its
 *   server on it — then SIGKILL
 *
 * @typedef {{ ok: true, server: WebServer }
 *   | { ok: false, error: string, code: number | null }} WebLaunch
 */

/**
 * The real spawner: the resolved `ukb` command in its own process group, stdio
 * piped so the launcher can read the URL.
 *
 * `detached` is what lets the server outlive a Host reload; `unref` (applied by
 * the launcher once the URL is in hand) is what stops the child's handle from
 * holding the Host open.
 *
 * @param {{ command: string, prefix: readonly string[], env?: Record<string, string> }} cli
 * @returns {(argv: readonly string[]) => WebChildProcess}
 */
export function createDetachedWebSpawner(cli) {
  return (argv) => {
    const child = spawn(cli.command, [...cli.prefix, ...argv], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...cli.env },
    });
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      onExit: (listener) =>
        child.once("exit", (code, signal) => listener(code, signal)),
      onError: (listener) => child.once("error", listener),
      kill: (signal) => child.kill(signal),
      unref: () => child.unref(),
    };
  };
}

/**
 * Start the server and resolve as soon as the URL exists.
 *
 * @param {{
 *   argv: readonly string[],
 *   spawn: (argv: readonly string[]) => WebChildProcess,
 *   startTimeoutMs?: number,
 *   stopTimeoutMs?: number,
 *   detachDelayMs?: number,
 * }} options
 * @returns {Promise<WebLaunch>}
 */
export async function launchWebServer(options) {
  const startTimeoutMs = options.startTimeoutMs ?? WEB_START_TIMEOUT_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? WEB_STOP_TIMEOUT_MS;
  const detachDelayMs = options.detachDelayMs ?? WEB_DETACH_DELAY_MS;

  /** @type {WebChildProcess} */
  let child;
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
  /** @type {(code: number | null) => void} */
  let settleExit = () => undefined;
  const exit = new Promise((resolve) => {
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

  /** @param {number} ms @returns {Promise<"exited" | "timeout">} */
  const waitForExit = async (ms) => {
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ms);
    });
    const result = await Promise.race([exit.then(() => "exited"), timeout]);
    if (timer !== undefined) clearTimeout(timer);
    return /** @type {"exited" | "timeout"} */ (result);
  };

  const stop = async () => {
    if (exited) return;
    child.kill("SIGTERM");
    if ((await waitForExit(stopTimeoutMs)) === "timeout") {
      child.kill("SIGKILL");
      await waitForExit(1_000);
    }
  };

  /** @type {WebLaunch} */
  const launched = await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    /** @param {WebLaunch} result */
    const finish = (result) => {
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
    // fine does not hold the Host open, and the `settled` guard makes the late
    // firing a no-op instead of a kill.
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
    // The server must outlive the Host that started it, and the pipes must not
    // hold the Host open: a detached child that is still "waited for" keeps the
    // process alive on quit.
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

/**
 * What to say about a CLI that exited without serving.
 *
 * @param {number | null} code
 * @param {NodeJS.Signals | null} signal
 * @param {string} stdout
 * @param {string} stderr
 * @returns {string}
 */
function describeExit(code, signal, stdout, stderr) {
  const how =
    code !== null
      ? ` (code ${code})`
      : signal !== null
        ? ` (signal ${signal})`
        : "";
  // stderr first — that is where a failure lands — but `ukb web --help` is a
  // deliberate exit 0 whose useful text is on stdout.
  return `ukb web exited before serving${how}${tail(stderr) || tail(stdout)}`;
}

/** The last few lines of CLI output, short enough to read in a panel. */
function tail(text, lines = 3) {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  const recent = trimmed.split("\n").slice(-lines).join(" ").trim();
  const clipped = recent.length > 300 ? `${recent.slice(0, 297)}…` : recent;
  return `: ${clipped}`;
}

/** @param {unknown} error */
function message(error) {
  return error instanceof Error ? error.message : String(error);
}
