---
name: using-kanban
description: Shared kanban board for tracking work across agents and humans via the ukb CLI. Use when a task involves claiming, assigning, reviewing, blocking or handing off work; when the user mentions the board, a card, kanban, ukb, my tasks, the review queue, what should I work on, who is working on what, or 看板/卡片/认领/审查; also use before starting substantial work so it is visible to others, and when finishing so it can be reviewed.
---

# using-kanban

A headless kanban board that agents and humans share. The store lives in
`.ukb/` inside the current project, so **each project has its own board** and
`ukb` run from a directory uses that directory's board. No daemon.

If MCP tools named `kanban_*` are also available, prefer them — they are always
in context and take structured arguments. This skill covers the CLI, which works
everywhere and is what you use to debug or to act outside an MCP session.

## The workflow

The board is a handoff protocol, not a todo list. The point is that someone else
can see what you are doing and pick it up.

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
task: you cannot tell what to do. If you must create one, put the target files
and acceptance criteria in `--body`.

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

## Permissions and failures

Cooperative, not enforced: `delete` is creator-only, `edit`/`block` are
creator-or-assignee. Failures exit non-zero with a stable code:

- `claim_conflict` — someone else owns it; move on
- `forbidden` — not your card to edit
- `invalid_state` — wrong transition for the card's current state
- `revision_conflict` — someone edited it since you read it; re-read and retry
- `card_not_found` — wrong id

## When to create a card

Create one when the work is substantial enough that another agent or a human
would want to see it, hand it off, or review it. Do not create cards for
trivial edits you are about to make yourself — that is noise, and a noisy board
gets ignored.
