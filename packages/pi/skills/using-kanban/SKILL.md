---
name: using-kanban
description: Use this as your todo list. A shared kanban board for tracking work across agents and humans via the ukb CLI. Load it whenever you are about to keep a todo list, task list, checklist, plan, or backlog; when work has several steps, spans sessions, or needs handing off; when the user asks what is left, what should I work on, who is working on what, or mentions the board, a card, kanban, ukb, my tasks, the review queue, tracking progress, or 看板/卡片/待办/任务/清单/认领/审查. Prefer it over an in-memory list for anything another agent or a human may need to see.
---

# using-kanban

## This is your todo list

**When you would write a todo list, use this board instead.**

A todo list kept in your own context dies with the session: nobody else can see
it, nothing survives a restart, and work you are halfway through is invisible
until you mention it. Cards on this board are the same list, except a human can
watch them, another agent can pick them up, and the state is already persisted.

So: before a multi-step task, before claiming you will "keep track" of
something, before enumerating steps in a reply — put it on the board.

```bash
ukb add "Wire the retry backoff" --project infra --body "AC: exponential, capped at 30s"
```

The rule of thumb: **if you would be annoyed to lose it when this session ends,
it belongs on the board.** A three-line edit you are about to make right now does
not. Anything you might hand off does.

## The workflow

The board is a handoff protocol, not a private checklist. The point is that
someone else can see what you are doing and pick it up.

```bash
ukb mine --as <you>     # your open cards — the call to act, start here
ukb show <id>           # ALWAYS read this before acting: body has the target
                        # files and acceptance criteria
ukb claim <id>          # todo → doing, assigned to you — do this first
# ... do the work ...
ukb review <id>         # → review, waiting for the reviewer
ukb done <id>           # → done (the reviewer normally does this)
ukb move <id> someday   # park it for later: leaves the to-do list, owner cleared
```

**Claim before you start.** An unclaimed card is invisible work; a claimed one
tells everyone else to keep out. If `ukb claim` fails with `claim_conflict`,
someone else got there first — pick a different card rather than fighting it.

**Read the body before acting.** A card with no body is a notification, not a
task: you cannot tell what to do. When you create one, put the target files and
acceptance criteria in `--body`.

## Identity

`--as <name>` sets who acts. Without it you are `agent`, which makes the board
useless for attribution. Use a stable name (`claude-code`, `codex`, `pi`, or a
human name). `UKB_AGENT` in the environment sets it too.

## Projects

Cards carry an optional project slug so one board holds several projects:

```bash
ukb add "Fix the login bug" --project web   # set at creation
ukb list                                   # every project + its card counts
ukb board --project web                     # just that project
ukb mine --project web                      # my work in one project
```

A card with no project is in **no** project — a project filter is a partition,
not an overlay. Slugs are lowercased and limited to `[a-z0-9._-]`.

## Priority

Every card has a priority: `high`, `normal` (default), or `low`.

```bash
ukb add "Fix the login bug" --priority high   # set at creation
ukb edit 7 --priority low                      # dial it down later
```

Rows sort `high → normal → low` inside each column.

"Not now" is **not** a priority — it is the `someday` column. Use it rather
than deleting an idea you may want back, and rather than leaving it at `normal`
where it competes for attention it is not asking for:

```bash
ukb move 7 someday      # park it — assignee and reviewer are cleared
ukb claim 7             # pull it back: claim works straight out of someday
```

A parked card leaves `ukb mine` and the to-do count, so a shelf never reads as
work you are behind on. It still counts as an unfinished blocker for anything
waiting on it — "later" is not "finished".

`ukb list` is how you discover a slug before filtering, and it counts `done`
so the rows add up to the whole board. The `(none)` row is the cards with no
project: they exist, and they will never match a `--project` filter.

## Relations run both ways

`ukb relate <id> --with <other> --as upstream|downstream` wires two cards
together. `--as upstream` says the other card is a **predecessor** this one waits
on; `--as downstream` says it is a **successor** waiting on this one. Both
spellings write the same single edge, so you can relate from whichever card you
are holding, and `ukb show` prints both ends — what a card waits on, and what
waits on it. `ukb unrelate <id> --with <other>` drops the edge from either side.

A card with unfinished upstream work **cannot be claimed or moved into `doing`** —
the point is that nobody picks up work that is not actually ready. The error
names the blockers and their states:

```
invalid_state: card 7 is blocked by #3 (doing) — finish or unblock it first
```

Two deliberate exceptions: a blocker that has been **deleted** counts as
satisfied, otherwise deleting a card could block another one forever; and
`done` is never gated, so an irrelevant blocker cannot become a dead end.
`review` is not gated by a dependency either — by then the work is already
finished, and refusing would only create friction. An umbrella is a separate
rule, and it _is_ gated; see the next section.

## Umbrella cards (a big goal and its parts)

A card can be an **umbrella**: a goal that several smaller cards support. Link a
child to it, and the relationship shows on both cards:

```bash
ukb parent 601 --of 38      # #601 is now a part of #38
ukb unparent 601            # ...and this makes it top-level again
ukb show 38                 # children: 4/6 (4 done · 1 review · 1 todo) + the list
```

In the Pi panel the children follow their umbrella row, indented one level,
whatever column they are in — a child in `review` sits under a `todo` umbrella,
not in the review group, and it is not repeated there. A child whose umbrella is
not on screen stays a top-level row with a `⤷#parent` marker.

Three rules, all deliberate:

- **One level deep.** An umbrella has children; a child has none. `ukb parent`
  refuses anything that would create a grandparent, so there is exactly one
  shape to reason about.
- **Composition, not blocking.** An umbrella does _not_ block its children —
  they are how it gets done, not what it waits for. Use `relate`/`block` for
  ordering; use `parent` for belonging. A card can be someone's child _and_
  blocked by a third card at the same time.
- **The two ends move together.** An umbrella is the goal and its children are
  the parts, so neither end can be ahead of the other:
  - a child cannot be `doing` or `review` unless its umbrella is `doing` —
    claim the goal first, then the parts;
  - an umbrella cannot be `review` or `done` until **every** child is `done`
    — you cannot accept the whole while a part is open;
  - an umbrella cannot be parked (`todo`/`someday`) while a child is in play;
  - a child of a `review`/`done` umbrella cannot be reopened until the umbrella
    comes back out.

  Progress (`▸4/6`) stays derived — finishing a child does not move the
  umbrella for you. A leaf card's `done` is never gated.

Deleting an umbrella orphans its children (they become top-level) rather than
deleting them.

## Notes carry the paperwork

A card's body is for the work. When there is a document behind it — the design
doc for the requirement, a runbook, a mockup — put it on the card as a note:

```bash
ukb note 4 "requirement design doc" --url docs/design.md
ukb note-edit 4 12 --url docs/design-v2.md
ukb note-remove 4 12
```

The link is either `https://…` or a path to a file on this machine. Local
markdown and HTML are rendered in the human's Web UI, so a doc that lives in the
repo does not have to be pasted anywhere. Use it rather than growing a body into
an essay: one link, one line of what it is.

## One board, not one per directory

The store is centralised at `~/.ukb/`. There is exactly one board on this
machine, so **the directory you run `ukb` from does not matter** — `ukb board`
from anywhere shows the same cards. Projects are separated by the `project`
field on cards, which is what you filter on.

## The human is watching

In Pi the board is also mounted above the editor as a live panel: your `doing`,
`todo` and `review` cards (plus `someday`), and who each one is waiting on. It
repaints after every `ukb` call, so a card you claimed and never moved is visibly
stuck, and a card left in `review` is visibly waiting on someone. Keep the board
current as you work — the panel is the difference between the human trusting the
board and ignoring it.

## If there is no board yet

Reads never create a board. With no `~/.ukb/`, `ukb board` / `ukb mine` /
`ukb show` fail with `board_not_found` (exit 2) instead of showing an empty
board — an empty board would read as "nothing to do" when the truth is "nothing
has been created yet". Any write (`ukb add`, `ukb claim`, …) creates it. There is
no setup step and no per-project initialisation.

## Everything else

```bash
ukb board                        # the whole board + the projects in use
ukb list                         # every project with its card counts
ukb board --project <slug>       # one project's slice
/ukb gui show                   # the panel, scoped to this Git project
/ukb gui more                   # +10 rows when the summary says more are hidden
/ukb gui hide
ukb board --json                 # the same board as JSON, for scripts
ukb board --json --brief         # list fields only; skips bodies/notes/audit metadata
ukb add "<title>" [--body B] [--assignee X] [--reviewer Y] [--project p]
                        [--priority high|normal|low]
ukb edit <id> [--title T] [--body B] [--assignee X] [--reviewer Y] [--project p]
ukb done <id> [<id> …]  # several cards in one call; it stops at the first
                        # card the board refuses, so what it printed is what
                        # was applied
ukb move <id> <someday|todo|doing|review|done>
ukb reopen <id>                  # back to todo
ukb block <id> --by <other>      # make a card wait on another
ukb unblock <id> --by <other>
ukb parent <id> --of <parent>    # make a card a part of an umbrella (one level)
ukb unparent <id>                # make it a top-level card again
ukb relate <id> --with <other> --as upstream    # or downstream
ukb unrelate <id> --with <other>
ukb note <id> "design doc" --url docs/design.md # a remark + document link
ukb note-edit <id> <noteId> [--url …]
ukb note-remove <id> <noteId>
ukb delete <id>                  # creator only
ukb web                          # API + Web UI for a human to watch; it serves
                                 # until it is stopped, so background it
                                 # (`ukb web --no-open >/dev/null 2>&1 & disown`)
                                 # or let the human run `/ukb web` in Pi
```

A `ukb` tool is registered in your context (and a `/ukb` slash command for the human).
Prefer the tool over shelling out yourself: it takes structured arguments, avoids
quoting problems, and draws each result as a colour-coded block — green on
success, red on error. It maps one-to-one onto the commands above — `ukb add
"…"` is `{ action: "add", title: "…" }`, `ukb claim 3` is `{ action: "claim",
id: 3 }`, `ukb move 3 doing` is `{ action: "move", id: 3, column: "doing" }`,
`ukb relate 2 --with 1 --as upstream` is `{ action: "relate", id: 2, other: 1,
direction: "upstream" }`, and `ukb note 4 "design doc" --url docs/design.md` is
`{ action: "note", id: 4, text: "design doc", url: "docs/design.md" }`.

`done`, `review`, `reopen` and `delete` take several cards at once —
`ukb done 1 2 3` is `{ action: "done", ids: [1, 2, 3] }`. Use it to clear a review
queue in one call rather than one call per card. `claim` deliberately does not:
the board allows exactly one card in `doing`, so batch-claiming is refused with
that reason rather than quietly claimed.

## Permissions and failures

Cooperative, not enforced: `delete` is creator-only, `edit`/`block`/`note` are
creator-or-assignee. Failures exit non-zero with a stable code:

- `claim_conflict` — someone else owns it; move on
- `forbidden` — not your card to edit
- `invalid_state` — wrong transition, or a blocker is unfinished
- `revision_conflict` — someone edited it since you read it; re-read and retry
- `card_not_found` — wrong id
- `board_not_found` — no board in this directory

## When _not_ to use it

Do not create cards for trivial edits you are about to make yourself — that is
noise, and a noisy board gets ignored. Do not use it as a substitute for
reading the code: the board tells you _what_ and _who_, never _how_.
