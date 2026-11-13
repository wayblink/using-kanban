# Kanban (ukb) for DeepSeek Harness

This bundle gives DeepSeek Harness the same board the Pi extension gives Pi — one
`ukb` tool over the CLI, the `/ukb` command, and the guidance that makes the
board the agent's todo list instead of a private in-memory list.

## What it registers

| Surface | DSH mechanism | What it does |
|---|---|---|
| `ukb` tool | `ctx.tools.register` | 21 verbs through one typed schema: `mine`, `board`, `show`, `add`, `claim`, `review`, `done`, `reopen`, `move`, `edit`, `delete`, `block`/`unblock`, `parent`/`unparent`, `relate`/`unrelate`, `note`/`note-edit`/`note-remove`, `list` |
| board guidance | `ctx.systemPrompt.section` | Claim before working, one card in `doing`, read the body first, umbrella/child rules |
| `/ukb` command | `ctx.commands.register` | No args lists your cards; anything else passes through to the CLI unchanged |

Every call runs the real `ukb` CLI with `--agent dsh --agent-type agent`, so
attribution, validation, transitions and error codes are the CLI's, not a second
implementation.

## Resolution

The CLI is resolved in this order, and the chosen source is logged at load:

1. `ukb_path` in the bundle config, or `$UKB_BIN`.
2. This checkout's `packages/cli/dist/bin.js`, run through the DSH executable
   with `ELECTRON_RUN_AS_NODE=1` — the copy that matches the checkout you edit.
3. `ukb` on `PATH`.
4. `/opt/homebrew/bin/ukb`, `/usr/local/bin/ukb`, `~/.local/bin/ukb`.

## Visualization

The bundle also ships a browser half (`client.js`, declared through `dsh.client`):

- **Tool view** — a `board --json` result renders as the five board columns with
  counts and card rows; every other verb renders as a compact command card with
  the CLI's own output. Data comes from the call's own arguments and result, so
  there is no Host round trip.
- **Right-Sidebar panel** — a `Kanban` page tab (`ukb-board`) laid out as stacked
  sections, one per state in flow order (**Todo, Doing, Review, Done, Someday**),
  so all five fit a narrow panel without a horizontal scroll. Each section has a
  colored header (dot, name, count, collapse chevron), a tinted background and a
  left accent bar; its cards flow in an `auto-fill` grid. Clicking a card expands
  it in place with the `ukb show` body and history, fetched from
  `GET /api/ukb/card?id=`.
  The header carries a filtered/total counter, "updated Ns ago", Refresh and a
  persisted Comfortable/Compact switch; the filter bar carries free-text search
  (id/title/project/assignee), a project selector and All / Mine / Agent / Review
  scope. The project selector starts on the Session workspace's project — the
  deepest segment of the session's `cwd` that names a board project — so a
  session opened in this checkout opens on `using-kanban`; a manual pick,
  All projects included, holds through the 20-second refresh, Clear returns to
  following the workspace, and a workspace that names no project keeps the whole
  board. Surfaces use the host tokens (`--dsw-alias-*`) with neutral fallbacks;
  the five state hues match the `ukb web` board (`#64748b`, `#2563eb`, `#d97706`,
  `#16a34a`, `#8b8fa3`). It is listed in the Sidebar guide too.
- **Composer chip** — `kanban doing N · todo N · review N`, hidden when all three
  are zero; clicking it opens the panel.

The panel and chip read one Host route, `GET /api/ukb/board` (optional
`?project=`), which runs `ukb board --json --brief` and caches the result for four
seconds so a polling chip does not fork a process per second.

It is plain JS on purpose: the browser module table supplies React, so a DSH
bundle needs no build step. A page refresh after installation is enough; while
`dev:web` rebuilds client bundles, the change can arrive without one.

## What differs from the Pi port

- **No overlay panel.** DSH plugins render through slots, not a TUI pane; human
  viewers use `/ukb web` (the CLI's own web UI) instead.
- **No per-turn board digest yet.** Pi injects it from `before_agent_start`; DSH
  has no pre-turn message hook guaranteed to land before the turn's first step,
  so a digest would arrive one step late. The guidance section covers the same
  ground in the meantime.
- **Output is bounded** at 24,000 characters, because a DSH tool result enters
  the context verbatim (Pi truncates only the rendering).

## Limitations

- The tool cannot see the overlay's terminal-specific scope/group settings; those
  remain `/ukb web` and `gui` concerns.
- `ukb web` is not managed by this bundle: start it yourself, or keep using the
  CLI.
- Cards are attributed to the literal agent name `dsh`; set `$UKB_AGENT` if you
  want a different actor for a machine.
