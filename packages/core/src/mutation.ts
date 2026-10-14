/**
 * Mutation replies.
 *
 * Every door answers a mutation with a sentence, and every door used to build
 * that sentence by hand at the call site: the CLI had a `TRANSITION_VERBS` table
 * of adjectives, MCP had `moved to ${to}`. So `#3` moving todo → doing was
 * reported as "claimed" from one door and "moved to doing" from another, and
 * neither said where the card had come from — which is the half a reader needs
 * to check the reply against what they asked for.
 *
 * `describeMutation` derives the reply from the event the mutation actually
 * emitted, so the tuple cannot drift from what happened and cannot be forgotten
 * by a new call site. A mutation that changed nothing emits no event, and the
 * reply then carries no tuple rather than claiming a move that did not occur.
 */

import type { Card } from "./types.js";
import type { MutationResult } from "./kanban.js";
import { sanitizeTerminalText } from "./sanitize.js";

/** How the column a card landed in reads after its name. */
function destinationSuffix(card: Card): string {
  // "review" alone reads as the verb "go and review". With a reviewer named it
  // is a hand-off to someone; without one it is a queue.
  if (card.state === "review") {
    return card.reviewer
      ? ` (${sanitizeTerminalText(card.reviewer)})`
      : " queue";
  }
  return "";
}

/**
 * The column a card moved between, as `from → to`, or null when the mutation
 * emitted no event.
 *
 * A same-state move is a real mutation — `claim` on a card that `move` left in
 * `doing` with nobody owning it — so it is reported as the change it is rather
 * than as a no-op.
 */
export function describeTransition(result: MutationResult): string | null {
  const moved = result.events.find((event) => event.type === "card.moved");
  if (!moved) return null;

  const payload = moved.payload;
  const from = payload.from;
  const to = payload.to;
  if (typeof from !== "string" || typeof to !== "string") return null;

  const assigned = (payload.patch as { assignee?: unknown } | undefined)
    ?.assignee;
  if (typeof assigned === "string" && assigned.length > 0) {
    return `${from} → ${to} · now assigned to ${sanitizeTerminalText(assigned)}`;
  }

  const suffix = from === to ? "" : destinationSuffix(result.card);
  // A card parked in `doing` with no owner is a state the board should say out
  // loud: the column asserts work is in progress and nothing names who.
  const unowned =
    to === "doing" && !result.card.assignee ? " · unassigned" : "";
  return `${from} → ${to}${suffix}${unowned}`;
}

/**
 * The reply to a mutation: the caller's verb, the card, and what changed.
 *
 * `brief` is the door's own card rendering, so each door keeps its formatting
 * (the CLI's is terminal-sanitized, MCP's is its own) while the transition
 * tuple — the part that used to be hand-written per call site — is shared.
 */
export function describeMutation(
  brief: string,
  result: MutationResult,
  verb: string,
): string {
  const transition = describeTransition(result);
  return transition === null
    ? `${verb} ${brief}`
    : `${verb} ${brief} · ${transition}`;
}
