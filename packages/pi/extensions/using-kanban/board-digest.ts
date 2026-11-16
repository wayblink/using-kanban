/**
 * board-digest.ts — the one line the board says to the model at the start of a
 * run, instead of a ninth rule it has already stopped reading.
 *
 * `guidance.ts` carries the standing rules: what the workflow is, why the
 * `doing` column is exclusive, how a handoff works. Pi injects those once, into
 * the system prompt, where they sit for the whole session. That is the right
 * place for the rules and the wrong place for a habit — by the fortieth turn a
 * static bullet is scenery, and the measured behaviour says exactly that: the
 * opening `mine` kept happening while `add`/`claim`/`review` fell away.
 *
 * So this module produces the other half: a fact about *this* turn. Three
 * counts, the ids of the cards actually mine, and one clause on what the state
 * asks for. It is cheap to re-read precisely because it is not a rule.
 *
 * Two deliberate silences:
 *
 * - Nothing actionable means no line at all. A digest that appears on an empty
 *   board is noise on every turn that follows, and noise is how the last
 *   version of this instruction died.
 * - It never guesses. A card assigned to someone else is not mine to report,
 *   and a `review` with a named reviewer who is not me is that person's inbox.
 *
 * Pure and Pi-free, like `guidance.ts`, so it can be tested without a harness.
 */

import type { BoardSnapshot, CardLite } from "./overlay-render.js";

/**
 * The ceiling on the line. A digest that grows into a paragraph is just the
 * system prompt again, so the title is shortened to a recognisable stub and the
 * whole line is capped.
 */
export const MAX_DIGEST_CHARS = 220;

/** How much of a card title survives — enough to recognise, not to explain. */
const TITLE_CHARS = 18;

export interface BoardDigest {
  /** Cards I am holding in `doing`. */
  readonly doing: number;
  /** Cards in `todo` that I could claim: unassigned, or assigned to me. */
  readonly todo: number;
  /** Cards in `review` waiting on me: mine, or with no reviewer named. */
  readonly review: number;
  /** The single line to inject. */
  readonly text: string;
}

export interface DigestInput {
  /** The board as `ukb board --json --brief` writes it. */
  readonly board: BoardSnapshot;
  /** Who this front door acts as on the board. */
  readonly agent: string;
  /**
   * Project slug to count, or null for the whole board. Null is the honest
   * fallback: from a directory that is not a Git repository there is no
   * "current project" to scope to, and hiding work behind a guess is worse than
   * showing one project too many.
   */
  readonly project?: string | null;
}

/** One line, or null when there is nothing for this turn to act on. */
export function buildBoardDigest(input: DigestInput): BoardDigest | null {
  const agent = input.agent.trim();
  const project = input.project ?? null;
  const inScope = (card: CardLite): boolean =>
    project === null || card.project === project;

  const doing = input.board.doing.filter(
    (card) => inScope(card) && card.assignee === agent,
  );
  const todo = input.board.todo.filter(
    (card) =>
      inScope(card) && (card.assignee === null || card.assignee === agent),
  );
  const review = input.board.review.filter(
    (card) =>
      inScope(card) && (card.reviewer === null || card.reviewer === agent),
  );

  if (doing.length === 0 && todo.length === 0 && review.length === 0) {
    return null;
  }

  const parts: string[] = [];
  if (doing.length > 0) {
    const first = doing[0] as CardLite;
    parts.push(`doing ${doing.length}（你: ${cardRef(first)}）`);
  }
  if (todo.length > 0) parts.push(`todo ${todo.length} 待认领`);
  if (review.length > 0) parts.push(`review ${review.length} 等你`);

  // One clause, and only the one the state actually asks for. Holding a card
  // and starting new work are different situations; saying both turns the line
  // back into a rule.
  const clause =
    doing.length > 0
      ? "做完立刻 review，别让它躺在 doing"
      : "开工前先 claim，别让没认领的活在 doing 里";

  return {
    doing: doing.length,
    todo: todo.length,
    review: review.length,
    text: clamp(`board: ${parts.join(" · ")} — ${clause}`),
  };
}

/** Sentinel for `UKB_DIGEST` that switches the per-run line off. */
export const DIGEST_OFF = "off";

/**
 * Whether the per-run digest is switched off.
 *
 * `UKB_DIGEST=off` silences it for a session, `on` forces it on. Anything else
 * (including an unset variable) keeps the default, which is on: the line exists
 * because the static rules stopped being read, so an opt-in default would
 * reproduce the bug it was written for.
 */
export function isDigestDisabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.UKB_DIGEST?.trim().toLowerCase();
  if (raw === DIGEST_OFF || raw === "0" || raw === "false") return true;
  return false;
}

/** `#2960 用户页` — the id is the handle, the title only has to be recognisable. */
function cardRef(card: CardLite): string {
  return `#${card.id} ${shortTitle(card.title)}`;
}

/** One line, never longer than TITLE_CHARS, never carrying a newline. */
function shortTitle(title: string): string {
  const flat = title.replace(/\s+/g, " ").trim();
  if (flat.length <= TITLE_CHARS) return flat;
  return `${flat.slice(0, TITLE_CHARS - 1)}…`;
}

function clamp(text: string): string {
  if (text.length <= MAX_DIGEST_CHARS) return text;
  return `${text.slice(0, MAX_DIGEST_CHARS - 1)}…`;
}
