/**
 * Refresh scheduling and board reads for the Pi panel.
 */

export const OVERLAY_READ_TIMEOUT_MS = 8_000;

export interface BoardRead {
  readonly stdout: string | null;
  readonly error: string | null;
}

/** Keep Pi responsive and replay overlapping triggers with one follow-up read. */
export function createOverlayRefreshScheduler(
  refresh: () => Promise<void>,
): () => void {
  let running = false;
  let queued = false;

  const drain = async (): Promise<void> => {
    running = true;
    try {
      do {
        queued = false;
        await refresh();
      } while (queued);
    } finally {
      running = false;
    }
  };

  return () => {
    if (running) queued = true;
    else void drain();
  };
}

/** The Web board summary includes card relationships and the global project list. */
export async function readRemoteOverlayBoard(
  server: string,
  token: string | null,
  timeoutMs = OVERLAY_READ_TIMEOUT_MS,
): Promise<BoardRead> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`${server}/api/board?summary=1`, {
      headers,
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return {
        stdout: null,
        error:
          response.status === 401
            ? "remote board denied access (HTTP 401). Check your token or run ukb login."
            : `remote board returned HTTP ${response.status}`,
      };
    }
    return { stdout: await response.text(), error: null };
  } catch (error) {
    return {
      stdout: null,
      error: signal.aborted
        ? `remote board read timed out after ${timeoutMs / 1000}s`
        : `could not read the remote board — ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Slash-command verbs that only read the board.
 *
 * A denylist, not an allowlist, and deliberately so: a verb added later
 * refreshes by default. The alternative fails in the direction that caused this
 * module to exist — a new mutation verb silently leaving the panel stale.
 *
 * `mine`/`list`/`board`/`show` cannot change a card. `help` prints usage.
 * Everything else (`add`, `claim`, `done`, `note`, …) is treated as a mutation,
 * which is the safe guess.
 */
const READ_ONLY_VERBS: ReadonlySet<string> = new Set([
  "mine",
  "list",
  "board",
  "show",
  "help",
]);

/**
 * Whether the overlay should re-read the board after a command finished.
 *
 * A failed command changed nothing, so there is nothing to repaint — and paying
 * for a subprocess to redraw the same lines would be noise.
 */
export function shouldRefreshAfterCommand(
  argv: readonly string[],
  exitCode: number,
): boolean {
  if (exitCode !== 0) return false;
  const verb = argv[0];
  // No verb at all means the default `mine`, which is a read.
  if (verb === undefined) return false;
  return !READ_ONLY_VERBS.has(verb);
}
