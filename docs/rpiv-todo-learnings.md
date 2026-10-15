# What to steal from rpiv-todo

A review of [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo)
— a Pi extension whose `todo` tool is the closest thing in the wild to this board.
It solves the same problem (a durable task list the model actually keeps current)
in a different medium (a live overlay inside one Pi session) and has been hardened
by real use in ways the board has not.

Read that package's `README.md`, `docs/tool-schema.md`, and the `state/`, `tool/`,
`view/` layers before acting on this. Everything below cites where the pattern
lives so it can be checked rather than taken on faith.

> **Revision.** An earlier version of this doc led with "make no-op mutations say
> `No change`". That was over-ranked. rpiv-todo needs the string because its
> `update` action is field-assignment-shaped, so a caller can hold a wrong belief
> about a task's state and the reply corrects it. This board's verbs are
> intent-shaped — every one of its no-ops is a case where the desired state
> already holds, so the reply changes nothing about what comes next. The useful
> half of that item is the transition tuple, and the real bug the investigation
> turned up is that `move` into `doing` never assigns anyone. Both are item 4
> below. The overlay is the item that mattered, and it is shipped.

**Priority order:**

1. A live overlay — the board always on screen. **Shipped** (card #319).
2. Bind the board's rules into the tool, with a project-level override.
3. Sanitize model-authored text before it reaches a renderer.
4. Report the transition tuple; fix `move` bypassing assignment.
5. `details` should be the post-mutation snapshot.
6. A pinned error catalogue, not a hand-written one.
7. `ukb history <id>` that survives a delete.
8. Supporting test and packaging patterns.
9. One `describeMutation()` instead of four front doors formatting alone.
10. The localization rule, if the board ever localizes.

---

## 1. An on-demand overlay — the current project when asked (shipped)

The reason `rpiv-todo` exists as an _overlay_ is stated in its README:

> **The plan stays on screen.** A panel above the editor shows every task with a
> status glyph, the label of whatever is in progress, and a `Todos (done/total)`
> heading — you never have to ask the agent where it is.

Before this, the board was strictly worse for the human in that one respect:
nothing was visible until the agent happened to call `ukb mine`. The human saw the
board only by asking.

**What shipped, then changed after the live test.** A widget above the editor in
the Pi package (`packages/pi/extensions/using-kanban/`), showing in-flight work —
every `doing` and `review` card with whoever the card is waiting on — plus counts
for the rest. The first version was permanently visible and read the whole global
board; with 70+ open cards across eight projects it hid the latest conversation
under unrelated Gala backlog. The production default is therefore **on demand**
(`/ukb gui show`) and scoped to the current Git project:

```
● ukb · using-kanban · 2 doing · 1 review · 2 todo · 1 done
├─ [doing][high]    #1 Fix flaky retry backoff test                @pi
├─ [doing][normal]  #2 Wire SSE replay for board events            @codex
├─ [review][normal] #3 Overlay widget above the editor             → human
├─ [todo][normal]   #4 Add terminal sanitizer to the CLI renderer  @pi
└─ [todo][low]      #5 Hoist sanitize into a shared module
```

Design decisions worth keeping:

- **`done` is a count, never a row.** The board has three projects and a hundred
  cards; a full board can never fit. Restricting rows to in-flight work makes the
  panel bounded no matter how long the board grows.
- **State is spelled out, not drawn.** `○ ◐ ◆ ●` needs a legend that exists
  nowhere else in the board, and a reader who has not memorised it cannot tell
  in-flight from waiting. `[doing]` / `[review]` / `[todo]` uses the board's own
  column names, so a row explains itself and a terminal screenshot carries its
  own legend. The extra five characters come out of the title column, which the
  owner column then re-aligns.
- **Priority prints even when it is `normal`.** Suppressing the default would
  save six characters on most rows, but a row with no tag reads as malformed next
  to rows that have one, and the reader cannot tell "normal" from "this card
  predates priorities" — which matters, because the two sort differently against
  a `low` card. Consistency beat the width.
- **Overflow drops the todo tail first and never silently drops a `doing` row.**
  A card someone is working on is the last thing to disappear, and one row is
  reserved for `└─ +N more (2 todo, 1 review)` so the trimming is always visible.
- **It is on demand, not permanent.** Content above the editor competes with the
  latest conversation and reasoning. `/ukb gui show` shows it, `hide` removes
  it, and `display: "always"` is the explicit opt-in for the original design.
  Overlay controls deliberately share `/ukb`; there is no second slash-command
  namespace. `/ukb gui help` is the discovery surface — `gui` rather than the
  seven-letter `overlay`, because this is typed by hand and the namespace cannot
  be dropped outright: `/ukb` alone is "my open cards" and `/ukb show <id>` is
  card detail, so a bare `/ukb show` would be ambiguous.
- **One spelling for the panel, and only one.** `overlay` was first kept as an
  alias, then deprecated with a warning, then undocumented. Each step was the
  wrong shape: an alias that exists in order to be retired is two names for one
  thing, and the reader has to learn which is current. It is gone now, and
  `/ukb overlay show` fails as the unknown command it is — the CLI's error
  already says "try: ukb help", and `ukb help` documents `gui`.
- **Current project is the default scope.** Git root basename becomes the project
  slug; `scope=mine|all|project:<slug>` and `group=state|project|owner|none` are
  session-local previews, with the same choices persisted in config.
- **Refreshed on triggers, never polled:** while visible, the end of any `ukb`
  tool call, the start of each turn, and any successful `/ukb` slash command
  that changed the board. No timer or daemon.
- **The slash command needed its own trigger.** A human typing `/ukb done 319`
  drives the CLI directly, so `tool_execution_end` never fires — the panel drew
  the pre-`done` board until the next agent turn. A stale panel is
  indistinguishable from a broken one, which is the worst of the three states.
  The read-only verb list is a _denylist_, so a verb added later repaints by
  default instead of silently going stale. `overlay-refresh.ts` holds the
  decision as a pure function for exactly that reason.
- **Data comes through `ukb board --json --brief`** — the machine door's compact
  list projection, so storage resolution stays in the CLI while bodies, notes and
  audit fields do not cross the process boundary just to draw five rows.

Two more presentation rules from `docs/overlay.md` worth revisiting later:

- **Completed rows fade out.** A completed card stays visible for the rest of the
  turn, then drops on the next agent turn — the transition is seen, then the noise
  clears itself. The board's version would be the same for `done`.
- **`selectShowTaskIds()` gates `#id` prefixes on whether any visible row carries
  a `⛓ #N` reference.** Without a reference to anchor them, ids are omitted and
  the row stays quiet. The board always shows ids, which is right when ids are
  addressable; worth re-examining once `⛓` markers appear.

## 2. Bind the board's rules into the tool, and let projects override them

`todo.ts:DEFAULT_PROMPT_GUIDELINES` is eight numbered bullets, each a rule with
the exact call shape spelled out:

- "Use `todo` for complex work with 3+ steps … Skip it for single trivial tasks."
- "mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when
  done — never batch completions. **Exactly one task in_progress at a time.**"
- "Never mark a task completed if tests are failing … keep it in_progress and
  create a new task for the blocker instead."
- 'To change a status, call `update` with `{"action":"update","id":3,"status":"completed"}`.
  status is the field that changes the task; an update without a mutable field is
  rejected.'

And those are overridable from `~/.config/rpiv-todo/config.json`:

```json
{ "guidance": { "promptSnippet": "…", "promptGuidelines": ["…"] } }
```

Validation is all-or-nothing (an array with one empty string falls back wholesale,
it is not merged item by item) and documented as such in `docs/configuration.md`.

The board's tool (`packages/pi/extensions/using-kanban/index.ts`) ships **three**
generic guidelines and leans on `SKILL.md` for the rest. But only the `description`,
`promptSnippet`, and `promptGuidelines` are injected into the system prompt — the
skill file is read only when the model chooses to load it. So the hard rules the
board actually depends on are not in front of the model by default:

- **exactly one card in `doing`** per agent (the board never enforces this and
  nothing states it);
- read the body before claiming (currently only in the skill);
- claim before starting; never work an unclaimed card;
- don't create cards for trivial self-serve edits;
- `note` for a design doc, not a paragraph appended to the body;
- a blocked card cannot be claimed — so `relate` before `claim`.

**Fix.** Expand `promptGuidelines` to a numbered list mirroring `SKILL.md`'s rules,
then add `~/.config/ukb/config.json` with a `guidance` field read at extension load.
This also gives a home for the settings the overlay currently reads from the
environment (`UKB_OVERLAY`, `UKB_OVERLAY_LINES`, `UKB_OVERLAY_KEY`) — those names
should become config fields, not be replaced.

## 3. Sanitize model-authored text before it reaches a renderer (shipped)

`tool/sanitize.ts` strips complete CSI/OSC escape sequences, C0/C1 control
characters, and bidi override/isolate controls from every model-controlled string
before it reaches Pi's terminal. It exists because task text is _untrusted input
rendered into a privileged surface_: a title containing `\x1b[2J` clears the screen,
and a bidi override can make a red error line read as a green one.

The overlay now carries its own copy (it must — it renders card titles). The CLI's
`packages/cli/src/render.ts` still interpolates `card.title`, `card.body`, note
text, and note URLs straight into terminal output with no sanitizer at all, which
is the larger exposure: `ukb show` renders a whole body and every note, and any
agent that can `ukb add` controls that text.

**What shipped.** `packages/core/src/sanitize.ts` is the canonical implementation,
exported from core's index and applied at every interpolation in
`packages/cli/src/render.ts`: title, assignee, reviewer, project, createdBy, note
text/url/author, and the event history's actor name. `body` is split on newlines
_before_ sanitizing — the sanitizer turns `\n` into a space by design, so running it
over a whole body would collapse the body into one line.

Sanitizing happens on the way out only. `board --json`, the Web UI (`textContent`
throughout, no `innerHTML`) and the event log keep the true text; a caller that
needs the original bytes has the JSON door. That is what the `--json` flag bought.

**Why there are still two copies.** The Pi overlay needs the same function, and
sharing it means a subpath export on core _plus_ a `@wayblink/using-kanban-core`
dependency on `packages/pi`. Any dependency on that package makes pnpm resolve its
host-provided peers (`@earendil-works/*`, `typebox`) — which commits a lockfile that
installs a second copy of pi-tui and typebox into CI. Too much blast radius for
twenty lines, so the overlay keeps a copy and
`packages/cli/tests/pi-overlay-parity.test.ts` asserts the two agree byte-for-byte.
They cannot drift silently. If `packages/pi` ever needs a dependency for another
reason, revisit and hoist.

## 4. Report the transition tuple, and fix `move` bypassing assignment (shipped)

`formatContent` emits `Updated #3 (pending → in_progress)` — the transition is in
the caller's face on every move. The board printed only the destination
(`moved to doing #3 [doing]`). The from-state is cheap, unambiguous, and it is the
one piece of information that reveals a stale mental model: "I thought it was in
review, but it moved from todo".

**What shipped.** `packages/core/src/mutation.ts` holds `describeTransition()` and
`describeMutation()`. The tuple is derived from the `card.moved` event the
mutation actually emitted, not from a string at the call site — which is the part
that matters, because the CLI had a `TRANSITION_VERBS` table of adjectives and MCP
had `moved to ${to}`, and neither said where the card came from. A mutation that
changed nothing emits no event and therefore carries no tuple, so no door can
claim a move that did not happen.

```
claimed #1 [doing] ship it @pi reviewer:jyxc · todo → doing · now assigned to pi
moved to review #1 [review] ship it @pi reviewer:jyxc · doing → review (jyxc)
moved to doing #1 [doing] queued · todo → doing · unassigned
```

Two wordings fall out of the destination rather than the verb. With a reviewer
named it is a hand-off; without one the reply says `review queue`, because
`→ review` alone reads as the instruction "go and review". And a card parked in
`doing` with no owner gets `· unassigned`, because that column asserts work is in
progress while nothing names who.

**The bug next to it — fixed on the `claim` side, not the `move` side.**
`ukb move <id> doing` does not write an assignee, so the card sat in the working
column with `assignee: null`, and a later `claim` failed with

```
claim_conflict: card 3 is already being worked by someone else
```

which was both wrong (nobody is) and unactionable — it named a phantom owner and
the recovery it implied ("pick another card") was exactly wrong. The analysis
offered two fixes: have `move` into `doing` assign the actor, or refuse `move`
into `doing`. Both were wrong, and for the same reason: `move` is a coordinator's
verb and assigning the acting agent would invent work ownership the caller never
asked for, while refusing would remove a legitimate verb. So `move` is unchanged
and still leaves the card unassigned — the reply now says `· unassigned` so the
state is not silent — and `claim` on an unowned `doing` card assigns the actor,
because `claim` is the verb that means "this is mine". The phantom-owner branch is
gone, so `claim_conflict` now only ever means what both doors' prose already said
it meant.

Reachable from every door: `ukb move`, the MCP `kanban_move` tool, and the Pi
tool's `column` parameter.

## 5. `details` should be the post-mutation snapshot

`buildToolResult` puts the **complete post-mutation `TaskState`** under
`details`, and `changesState(op)` decides whether it is also appended to the
session branch as a `rpiv-todo-state` custom entry — so state survives
`ctx.executeTool` (codemode) calls that never land as a standalone `toolResult`.

The board's tool returns `details: { action, code }`
(`packages/pi/extensions/using-kanban/index.ts`). Because the board persists to
`~/.ukb/` rather than the session branch, replay is not needed. But `renderResult`
and the overlay both want board state to render _without another process spawn_,
and the codemode lesson has a mirror image here: the extension spawns a one-shot
CLI process per call, so `details` is the only channel that carries state into the
render path. A full `details: { action, card, board, changed }` costs nothing (the
projection is already in memory).

## 6. Validation before mutation, with a named error per failure mode

The reducer validates all of this **before** touching state, and `docs/tool-schema.md`
tabulates the exact string for each: unknown dependency, tombstoned dependency,
self-block, cycle, illegal transition, missing subject, id required, no mutable
field. "A rejected call leaves the list untouched."

The board is close — `mustCard` / `addEdge` pre-validate, cycles are rejected, and
permissions are checked before the emit. The gap is **documentation and test
coverage of the catalogue**, not the logic. `SKILL.md` lists six error codes with
one line each; recovering callers need the trigger per code (`invalid_state` covers
both a wrong transition _and_ an unfinished blocker, which are different
recoveries, and `claim_conflict` covers "someone owns it" _and_ "it is unassigned
but in doing"). A pinning test per code would make the table trustworthy —
`kanban.test.ts` already has 53 tests including six `forbidden` cases and a
`revision_conflict`.

## 7. `ukb history <id>` that survives a delete

`rpiv-todo` tombstones rather than deletes, for a stated reason: historic
`blockedBy` references must still resolve, and `get` must still work on a removed
task. Its `list` hides tombstones unless `includeDeleted: true`, and `delete` on a
tombstone errors rather than silently succeeding.

The board hard-deletes (`projection.ts: case "card.deleted"` drops the card and
prunes both edge directions) and `ukb show <deleted id>` then returns
`card_not_found`. The _edge_ problem is already solved differently and soundly (a
missing blocker cannot block forever, and `SKILL.md` states the rule), so tombstones
are not needed for correctness. What is lost is the audit trail through the front
door: the event log still holds the card's full history, but there is no way to
read it once the card is gone. `Kanban.history(id)` already exists; a
`ukb history <id>` verb reading the log directly would return the events after the
projection has dropped the card, and preserves the "who deleted this, and why"
answer.

## 8. Supporting test and packaging patterns

- **Byte-pinned formatter table tests.** `tool/response-envelope.test.ts` asserts the
  exact string for every op (`"Created #1: alpha (pending)"`,
  `"Updated #1 (pending → in_progress)"`, `"No tasks"`). The board has no such test
  for `packages/cli/src/render.ts` or `packages/mcp/src/format.ts`, so a formatting
  change is invisible until a human notices. Front-door output is a contract; pin it.
- **Config fallback table.** `config.test.ts` (157 lines) enumerates every bad input:
  wrong type, empty string, array containing an empty string, malformed JSON,
  non-object JSON. If the board grows a config file (item 2), it should ship with the
  same table.
- **A `ship-manifest` test.** Three lines:
  ```ts
  it("`package.json` `files` array covers every production .ts module", () => {
    expect(verifyShipManifest(import.meta.url).missing).toEqual([]);
  });
  ```
  It catches a published package missing a module from `files` before npm does. The
  board publishes six packages with hand-written `files` arrays — the same failure is
  one careless edit away.
- **Session-isolation tests.** `todo.session-isolation.test.ts` (340 lines) proves a
  child session cannot read or clobber another's state. The board's analogue is
  actor isolation: prove agent A cannot `edit`/`delete`/`claim` card B's work, and
  that `mine --as A` never leaks B's cards. `kanban.test.ts` covers much of the
  permission logic already; the isolation _framing_ is what makes it a suite.
- **A single `__resetState()` reset seam** wired into a global test `beforeEach` —
  the board's `packages/pi` harness is small enough not to need it yet.

## 9. One `describeMutation()` instead of four front doors formatting alone

`rpiv-todo` layers cleanly: pure reducer (`state/state-reducer.ts`) → store seam
(`state/store.ts`) → formatter (`tool/response-envelope.ts`) → view
(`view/format.ts`) → thin registration shell (`todo.ts`). The transferable habit is
that **the formatter is a pure function of (op, state) with a closed tagged union**,
so adding an action fails to compile until its presentation branch exists (`Op` +
the exhaustiveness comments in `state-reducer.ts` / `response-envelope.ts`).

The board's four front doors each format mutations independently — CLI `render.ts`,
MCP `format.ts`, the Pi tool's `renderResult`, and the Web UI's own strings — so a
new mutation can silently skip one. A single `describeMutation(result)` in core,
used by all four, would close that. Its first two customers are the transition tuple
(item 4) and the changed/unchanged distinction.

## 10. The localization rule, if the board ever localizes

`docs/overlay.md` states the split plainly: overlay chrome, `/todos` headers, and
status words localize; **"LLM-facing output — the tool response envelope, reducer
error messages, and the schema descriptions — stays English by design."** That is
the right line to draw, and the board will need it drawn explicitly if the Web UI
grows a locale — the board's docs are already partly Chinese, so the tempting move
(machine-translating tool output) is the one to refuse.

---

## What _not_ to copy

- **Session-partitioned state.** `rpiv-todo` keys state by session id so parallel
  sessions stay separate. That is correct for a private per-session todo list and
  exactly wrong here — the board's entire point is that it is shared. The useful
  residue is the actor-scoped permission test, not the isolation model.
- **`blockedBy` as a numeric array you mutate with `addBlockedBy` / `removeBlockedBy`.**
  The board's `block`/`unblock`/`relate`/`unrelate` verbs are clearer, single-purpose,
  and already bidirectional. Keep them.
- **`clear`.** `rpiv-todo`'s `clear` drops every task and resets the id counter; it is
  a per-session convenience with no shared-board equivalent. The board's `delete`
  plus project partitions cover it without a footgun.
- **The `"No change"` reply.** See the revision note at the top. The board's no-ops
  are cases where the intent is already satisfied, not a corrected belief.
- **Numeric ids.** Both use them, so nothing to learn — but note that `rpiv-todo`
  leans on per-session ids restarting at 1 while the board's ids are global and
  monotonic. The board's `#id` is meaningful in a way `rpiv-todo`'s is not; do not
  ever assume ids are stable across a `delete`.

## Concrete next steps

Items 1, 2, 3, 4 and 9 are done, plus formatter tests for both the CLI renderer
and the MCP formatter. Remaining, in order:

1. Post-mutation snapshot in the tool's `details` (item 5).
2. `ukb history <id>` surviving a delete, the pinned error catalogue, the
   ship-manifest test for the six published packages, and actor-isolation tests
   (items 6, 7, 8).
