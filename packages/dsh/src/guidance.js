/**
 * guidance.js — the prompt copy the `ukb` tool advertises to the model.
 *
 * Ported from `packages/pi/extensions/using-kanban/guidance.ts`. Pure and
 * host-free so it is unit-testable and config-overridable.
 *
 * Why these live here and not only in `SKILL.md`: a skill's name and description
 * reach the system prompt, while the body loads only when the model chooses to
 * open it. The rules the board depends on — claim before working, one card in
 * `doing`, the umbrella/child contract — have to be present before that choice.
 */

export const DEFAULT_PROMPT_SNIPPET =
  "Shared kanban board: see your cards, claim work before starting it, hand it off for review.";

export const DEFAULT_PROMPT_GUIDELINES = [
  "Use the board as your todo list for anything another agent or a human may need to see, and `mine` it at the start of a turn — it is a call to act, not a status report. Skip it for a trivial edit you are about to make yourself: a board nobody reads is worse than no board.",
  "Read a card's `body` before acting on it — it holds the target files and the acceptance criteria. A card with an empty body is a notification, not a task; get the detail before starting.",
  "`claim` a todo card BEFORE starting work, and move it to `review` when the work is ready. Never work an unclaimed card. If `claim` fails with claim_conflict, someone else got there first — pick another card rather than fighting it.",
  "Keep exactly one card in `doing` at a time. That column is the answer to 'who is working on what' for the human watching the board as much as for you; several cards in flight means none of them are.",
  "A card whose upstream work is unfinished cannot be claimed or moved to `doing`. `relate` the dependency first, or pick a card that is actually ready.",
  "An umbrella card (a big goal) holds the work supporting it as children: `parent <child> --of <epic>`. It is composition, not blocking — an umbrella does not block its children, and the hierarchy nests to any depth (a phase can hold tasks), with cycles refused. The two ends move together: `claim` the umbrella first, then its parts may be `doing` or `review`, and the umbrella cannot go to `review` or `done` until every child is `done`. A child of a `review`/`done` umbrella cannot be reopened until the umbrella comes back out.",
  "`done` normally belongs to the reviewer. `invalid_state` means the transition is wrong or a blocker is unfinished; `forbidden` means the card is not yours to change. Re-read it with `show` before retrying either.",
  "Put the paperwork on the card as a `note` — a design doc, runbook, or mockup, as `--url https://…` or a path to a file on this machine — rather than growing the body into an essay. One link, one line of what it is.",
  "After `delete` the card is gone from the board while the event log keeps its history, so do not assume an id you saw a moment ago is still addressable — re-read the board.",
];

/**
 * @param {{ promptSnippet?: string, promptGuidelines?: readonly string[] }} [overrides]
 * @returns {{ promptSnippet: string, promptGuidelines: readonly string[] }}
 */
export function resolveGuidance(overrides) {
  return {
    promptSnippet: overrides?.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
    promptGuidelines: overrides?.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
  };
}

/**
 * `systemPrompt.section()` carries one flat string, so the snippet and the
 * bullets are joined here.
 * @param {{ promptSnippet: string, promptGuidelines: readonly string[] }} guidance
 * @returns {string}
 */
export function renderGuidance(guidance) {
  const bullets = guidance.promptGuidelines.map((line) => `- ${line}`).join("\n");
  return `${guidance.promptSnippet}\n\n${bullets}`;
}
