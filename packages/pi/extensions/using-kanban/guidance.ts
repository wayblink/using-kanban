/**
 * guidance.ts — the prompt copy the `ukb` tool advertises to the model.
 *
 * Pure and Pi-free so it is unit-testable and so a config override can be
 * resolved without importing the extension. Pi injects `promptSnippet` as
 * `toolSnippets` and `promptGuidelines` as `toolGuidelines` into the system
 * prompt; a skill's body is loaded only when the model chooses to load the
 * skill, so the rules the board actually depends on have to live here.
 *
 * Kept as plain sentences in priority order — Pi adds the bullets, so a literal
 * "1." in a string would render as "• 1. …".
 */

import type { UkbConfig } from "./config.js";

export const DEFAULT_PROMPT_SNIPPET =
  "Shared kanban board: see your cards, claim work before starting it, hand it off for review.";

export const DEFAULT_PROMPT_GUIDELINES: readonly string[] = [
  "Use the board as your todo list for anything another agent or a human may need to see, and `mine` it at the start of a turn — it is a call to act, not a status report. Skip it for a trivial edit you are about to make yourself: a board nobody reads is worse than no board.",
  "Read a card's `body` before acting on it — it holds the target files and the acceptance criteria. A card with an empty body is a notification, not a task; get the detail before starting.",
  "`claim` a todo card BEFORE starting work, and move it to `review` when the work is ready. Never work an unclaimed card. If `claim` fails with claim_conflict, someone else got there first — pick another card rather than fighting it.",
  "Keep exactly one card in `doing` at a time. That column is the answer to 'who is working on what' for the human watching the board as much as for you; several cards in flight means none of them are.",
  "A card whose upstream work is unfinished cannot be claimed or moved to `doing`. `relate` the dependency first, or pick a card that is actually ready.",
  "An umbrella card (a big goal) holds the work supporting it as children: `parent <child> --of <epic>`. It is composition, not blocking — an umbrella does not block its children, and the hierarchy is one level deep. An umbrella with unfinished children cannot be claimed or reviewed: work the children instead, and `done` the umbrella when they are all finished.",
  "`done` normally belongs to the reviewer. `invalid_state` means the transition is wrong or a blocker is unfinished; `forbidden` means the card is not yours to change. Re-read it with `show` before retrying either.",
  "Put the paperwork on the card as a `note` — a design doc, runbook, or mockup, as `--url https://…` or a path to a file on this machine — rather than growing the body into an essay. One link, one line of what it is.",
  "After `delete` the card is gone from the board while the event log keeps its history, so do not assume an id you saw a moment ago is still addressable — re-read the board.",
];

export interface ResolvedGuidance {
  readonly promptSnippet: string;
  readonly promptGuidelines: readonly string[];
}

/**
 * Config overrides the built-ins field by field. `validateGuidanceFields` has
 * already rejected blanks, so anything present here is usable as-is.
 */
export function resolveGuidance(config: UkbConfig = {}): ResolvedGuidance {
  return {
    promptSnippet: config.guidance?.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
    promptGuidelines:
      config.guidance?.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
  };
}
