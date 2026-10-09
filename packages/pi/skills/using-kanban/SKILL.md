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
ukb board --project web                     # just that project
ukb mine --project web                      # my work in one project
```

A card with no project is in **no** project — a project filter is a partition,
not an overlay. Slugs are lowercased and limited to `[a-z0-9._-]`.

## Blockers are enforced

A card with an unfinished blocker **cannot be claimed or moved into `doing`** —
the point is that nobody picks up work that is not actually ready. The error
names the blockers and their states:

```
invalid_state: card 7 is blocked by #3 (doing) — finish or unblock it first
```

Two deliberate exceptions: a blocker that has been **deleted** counts as
satisfied, otherwise deleting a card could block another one forever; and
`done` is never gated, so an irrelevant blocker cannot become a dead end.
`review` is not gated either — by then the work is already finished, and
refusing would only create friction.

## If there is no board here

Reads never create a board. In a directory with no `.ukb/`, `ukb board` /
`ukb mine` / `ukb show` fail with `board_not_found` (exit 2) instead of showing
an empty board — an empty board would read as "nothing to do" when the truth is
"you are in the wrong directory". Check `pwd` and `UKB_DIR`. Any write
(`ukb add`, `ukb claim`, …) creates the board.

## Everything else

```bash
ukb board                        # the whole board + the projects in use
ukb add "<title>" [--body B] [--assignee X] [--reviewer Y] [--project p]
ukb edit <id> [--title T] [--body B] [--assignee X] [--reviewer Y] [--project p]
ukb move <id> <todo|doing|review|done>
ukb reopen <id>                  # back to todo
ukb block <id> --by <other>      # make a card wait on another
ukb unblock <id> --by <other>
ukb delete <id>                  # creator only
ukb web                          # API + Web UI for a human to watch
```

If MCP tools named `kanban_*` are available, prefer them: they are always in
context, take structured arguments, and avoid shell quoting problems.

## Permissions and failures

Cooperative, not enforced: `delete` is creator-only, `edit`/`block` are
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
