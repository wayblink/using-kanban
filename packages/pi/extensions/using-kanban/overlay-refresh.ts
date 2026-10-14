/**
 * overlay-refresh.ts — when a finished `/ukb` command should repaint the panel.
 *
 * Pure on purpose: it is a decision about argv and an exit code, so it is
 * unit-testable without a Pi host (the same reason `overlay-render.ts` and
 * `overlay-command.ts` are).
 *
 * This exists because of a live bug: a human typing `/ukb done 319` bypasses the
 * `ukb` *tool*, so `tool_execution_end` never fires, and the panel kept drawing
 * the pre-`done` board until the next agent turn. A stale panel is
 * indistinguishable from a broken one, which is worse than either.
 */

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
