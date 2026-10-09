# kanban

> A headless kanban engine for AI agents **and** humans.
> HTTP + SSE + MCP out of the box — bring your own UI.

This is not a kanban with an API bolted on. **The API is the product**: a small,
dependency-light engine that any front door can drive — a CLI, an MCP server,
the bundled Web UI, or your own product embedding it.

Built for the world where a human and several agents (Claude Code, Codex,
opencode, Pi, …) share one board. No team concept, no message bus, no daemon.

## Status

| Package                | Status | What it is                                                           |
| ---------------------- | ------ | -------------------------------------------------------------------- |
| `@using-kanban/core`   | ✅     | Event-sourced engine: event log, projection, transition guards       |
| `@using-kanban/server` | ✅     | REST + SSE API, token auth, OpenAPI, static UI hosting, `ukb-server` |
| `@using-kanban/mcp`    | ✅     | MCP stdio server, 14 tools — the multi-framework front door          |
| `@using-kanban/web`    | ✅     | Default Web UI: drag & drop, live over SSE, one self-contained file  |
| `@using-kanban/cli`    | ✅     | `ukb` binary + `ukb init --for <framework>` installers               |

## Why event-sourced

The event log is the only source of truth; the board is a projection you can
rebuild by replaying it. That single decision buys:

- **Live UI for free** — tail the log, push over SSE, never poll
- **Full history** — every card carries its audit trail (`history(id)`)
- **Multi-process safety** — CLI, MCP servers, and the HTTP server all append
  to the same log; SQLite (WAL) makes appends atomic across processes
- **Swappable storage** — SQLite (default), JSONL (zero deps, git-friendly),
  or memory (tests, ephemeral boards)

A card's id is the id of its `card.created` event, so ids are stable and
monotonic without a separate counter.

## No daemon

Every entry point opens the store directly — there is nothing to start, stop,
or supervise. The HTTP server exists only when someone wants the Web UI or an
external API consumer, and idles out on its own.

```
            ┌──────────┐  ┌──────────┐  ┌───────────┐
            │   CLI    │  │   MCP    │  │  Web UI   │   front doors
            └────┬─────┘  └────┬─────┘  └─────┬─────┘
                 └─────────────┼──────────────┘
                          ┌────▼────┐
                          │  core   │  validation, guards, events
                          └────┬────┘
                     ┌─────────┴──────────┐
                ┌────▼────┐          ┌────▼────┐
                │ sqlite  │          │  jsonl  │   event log (source of truth)
                └─────────┘          └─────────┘
```

## Quick start

```ts
import { openKanban } from "@using-kanban/core";

const kanban = openKanban({ dir: process.cwd() }); // <dir>/.ukb/board.db

const human = { type: "human", name: "jyxc" };
const agent = { type: "agent", name: "claude-code" };

kanban.add({ title: "Write OpenAPI spec", reviewer: "jyxc" }, human);

const { card } = kanban.add(
  { title: "Implement /api/cards", assignee: "claude-code" },
  human,
);

kanban.claim(card.id, agent); // → doing, assigned to claude-code
kanban.review(card.id, agent); // → review (notify the reviewer)
kanban.done(card.id, human); // → done

kanban.mine("claude-code"); // open cards assigned to me
kanban.board(); // { todo, doing, review, done }
kanban.history(card.id); // full event trail
```

## The model

- **States**: `todo → doing → review → done` (`reopen` goes back to `todo`)
- **Actors**: `{ type: "human" | "agent", name }` — one namespace, so a human
  can review an agent's card and vice versa
- **Dependencies**: `block(id, blockedById)` / `unblock`, multiple per card,
  cycles rejected
- **Optimistic concurrency**: every mutation accepts `expectedRevision`; a
  stale revision fails with `revision_conflict` instead of clobbering a
  concurrent update (drag-drop vs. an agent claiming the same card)
- **Permissions are cooperative, not cryptographic**: `delete` is creator-only,
  `edit`/`block` are creator-or-assignee — same trust model as a local CLI
- **Stable error codes**: `invalid_input`, `card_not_found`, `invalid_state`,
  `claim_conflict`, `forbidden`, `revision_conflict` — front doors map these to
  MCP tool errors and HTTP statuses

## HTTP API (`@using-kanban/server`)

```
GET    /api/board                     columns + cards
GET    /api/cards?state=open&assignee=me&reviewer=me&q=text
GET    /api/cards/:id                 card + event history
POST   /api/cards                     { title, body, assignee, reviewer, blockedBy }
PATCH  /api/cards/:id                 edit fields
DELETE /api/cards/:id                 creator only
GET    /api/cards/:id/history
POST   /api/cards/:id/{claim,review,done,reopen,move}
POST   /api/cards/:id/{block,unblock} { blockedBy: <id> }
GET    /api/events                    SSE: card.created / card.moved / card.updated / card.deleted
GET    /api/me                        current actor, storage info, column counts
GET    /openapi.json                  full spec
```

Errors are a stable envelope: `{ "error": { "code", "message" } }` with codes
`invalid_input` (400), `card_not_found` (404), `claim_conflict` / `invalid_state` /
`revision_conflict` (409), `forbidden` (403), `unauthorized` (401).

**Auth** — bound to `127.0.0.1` by default with a generated token. Mutations
always need it (`Authorization: Bearer <token>` or `?token=`, which is how a
browser `EventSource` passes it); reads are free on loopback and need the token
once you bind elsewhere. `--host` + `--token` is the embedding configuration.

**Identity** — every mutation carries an actor: `X-Actor-Name` +
`X-Actor-Type: human|agent` headers (or `?actor=&actor-type=`), falling back to
the configured default. `X-Source: web|api|cli|mcp` tags where the event came
from, so history shows who did what.

**Concurrency** — send `If-Match: <revision>` (or `expectedRevision` in the
body); a stale revision gets `409 revision_conflict` instead of clobbering a
concurrent edit.

### Run it

```bash
ukb-server --dir . --port 4173 --ui ./packages/web/dist
# → http://127.0.0.1:4173/?token=<generated>
```

### Embed it

The handler is a plain `(req, res) => void` function — drop it into any host:

```ts
import { createServer } from "node:http";
import { createKanbanHandler } from "@using-kanban/server";

const handler = createKanbanHandler({
  dir: ".",
  token: "my-fixed-token",
  corsOrigin: "*",
});
createServer(handler).listen(8080);
// or: app.use(handler) inside Express / Fastify
```

`GET /api/events` is an SSE stream of the shared log, so a custom UI (or another
product) gets live updates — including changes made by the CLI or an MCP server.

## MCP (`@using-kanban/mcp`)

One stdio server, `ukb-mcp`, exposing the board as tools to any MCP-capable
agent. It talks to the core in-process — no daemon, no HTTP hop.

| Tool                              | Purpose                                    |
| --------------------------------- | ------------------------------------------ |
| `kanban_my_cards`                 | **Your open cards** — the call to act      |
| `kanban_review_queue`             | Cards waiting for your review              |
| `kanban_board`                    | Full board (todo/doing/review/done)        |
| `kanban_show`                     | Card detail: body, blockers, event history |
| `kanban_add`                      | Create a card (todo)                       |
| `kanban_claim`                    | todo → doing, assigned to you              |
| `kanban_review`                   | → review                                   |
| `kanban_done`                     | → done (idempotent)                        |
| `kanban_reopen`                   | → todo                                     |
| `kanban_move`                     | → any column                               |
| `kanban_edit`                     | Edit fields (creator or assignee)          |
| `kanban_delete`                   | Delete (creator only)                      |
| `kanban_block` / `kanban_unblock` | Dependencies                               |

Plus the `kanban://board` resource (the board as JSON).

Domain failures come back as tool errors with the stable code prefix —
`claim_conflict: card 3 is already being worked by codex` — so the agent knows
exactly what happened and can recover.

### Install into a framework

The server takes its identity from `--agent`, which is what makes cards
attributable per framework:

```jsonc
// Claude Code — .mcp.json or `claude mcp add`
{
  "mcpServers": {
    "using-kanban": {
      "command": "npx",
      "args": ["-y", "@using-kanban/mcp", "--agent", "claude-code"],
    },
  },
}
```

```toml
# Codex — ~/.codex/config.toml
[mcp_servers.using-kanban]
command = "npx"
args = ["-y", "@using-kanban/mcp", "--agent", "codex"]
```

```jsonc
// opencode — opencode.json
{
  "mcp": {
    "using-kanban": {
      "type": "local",
      "command": ["npx", "-y", "@using-kanban/mcp", "--agent", "opencode"],
    },
  },
}
```

(Config shapes vary by harness version — `ukb init --for <framework>` will write
them for you once the CLI lands.)

Other flags/env: `--dir` / `UKB_DIR` (board directory, defaults to the project
the agent runs in), `--storage` / `UKB_STORAGE`, `--agent-type` / `UKB_AGENT_TYPE`.

**Why the workflow is in the descriptions:** `kanban_my_cards` reads as a call
to act — _claim todo cards before starting work, move to review when ready_ — so
even an agent that never sees your docs behaves correctly. That inheritance from
agkanban is deliberate.

## Web UI (`@using-kanban/web`)

The default UI is dependency-free — no framework, no build step, no
`node_modules` in the browser. `ukb-server --ui ./packages/web/src` serves it,
or drop the single inlined file anywhere:

```bash
node packages/web/scripts/inline.mjs   # → dist/index.html (one self-contained file, ~36 KB)
ukb-server --dir . --ui ./packages/web/dist
```

- **Four columns**, drag & drop between them. A drop maps to the matching intent
  verb — onto _Doing_ runs `claim` (and assigns the card to you), onto _Review_
  runs `review`, onto _Done_ runs `done`, back onto _Todo_ reopens. A failed
  claim (someone else got there first) surfaces the server's error and the board
  snaps back to server state.
- **Live**: `EventSource` on `/api/events`, so cards moved by an agent — or by
  the CLI, or another browser tab — appear without a refresh.
- **Identity**: the top bar is _who this browser acts as_ (persisted in
  `localStorage`, sent as `X-Actor-Name`/`X-Actor-Type`). The human and the
  agents share one board and one namespace.
- **Card drawer**: edit title/body/assignee/reviewer, run transitions, add or
  remove blockers, read the event history, delete (creator only).
- **Filters** by text, assignee, and reviewer; **new card** modal with body
  field for target files and acceptance criteria.
- **Built-in docs at `/`** — the home page explains the workflow, the CLI, the
  MCP tools, and the HTTP API, with a live board count and an _Open the board_
  button. The board lives at `#/board`; the docs at `#/docs`. It is the first
  thing a new user (or a new agent) sees, and it is just another consumer of
  the API — so it doubles as a living example of building your own UI.
- **Formal top navigation** — a tall sticky bar with the brand on the left,
  _Docs / Board_ centred, and a version chip. The board's controls (identity,
  filters, live indicator, new card) are a separate sticky strip that renders
  only on the board route, so the docs read like a documentation site rather
  than an app with a board bolted on.
- Light and dark via `prefers-color-scheme`; single-column snap layout on
  narrow screens; keyboard-openable cards; `Esc` closes panels.

The UI is a _consumer_ like any other: `GET /api/board` + `POST
/api/cards/:id/<verb>` + SSE. Build your own against the same API, or embed the
handler in your product and point your own frontend at it.

### Verifying the UI in a real browser

Two harnesses, both runnable with zero setup:

```bash
pnpm --filter @using-kanban/web browser-check   # zero-dependency CDP driver
pnpm --filter @using-kanban/web drag-check      # Playwright: real drag & drop
```

`browser-check` drives headless Chrome over the DevTools Protocol using Node's
built-in WebSocket — no Playwright, no Puppeteer. It starts its own throwaway
board, asserts the layout (hidden panels stay hidden, the board fills the
viewport, four columns), clicks a card, presses Escape, opens and closes the
modal, and fails on any console error.

`drag-check` adds what synthetic mouse events cannot: HTML5 drag-and-drop. It
drags a card onto **Doing** and asserts the card was _claimed_ and attributed to
the identity shown in the top bar, then drags it back and asserts it reopened.

## CLI (`@using-kanban/cli`)

The `ukb` binary talks to the core in-process — same board, same events, no
daemon and no server needed:

```bash
ukb                                # your open cards — a call to act, not a list
ukb board                          # the whole board
ukb show 3                         # detail + event history
ukb add "fix the flaky test" --body "AC: green on CI" --assignee codex --reviewer jyxc
ukb claim 3                        # todo → doing, assigned to you
ukb review 3                       # → review
ukb done 3                         # → done
ukb reopen 3                       # → todo
ukb move 3 doing
ukb edit 3 --body "…"              # empty string clears a field
ukb block 4 --by 3                 # dependencies
ukb web                            # start the API + Web UI and open a browser
ukb doctor                         # is this project wired up?
```

Agents pass `--agent <name> --agent-type agent` so cards are attributable
(`UKB_AGENT` / `UKB_AGENT_TYPE` work too); `--dir` / `--storage` select the
board. Domain failures exit non-zero with the stable code:
`claim_conflict: card 3 is already being worked by codex`.

### Onboarding a framework in one command

```bash
ukb init --for claude-code           # writes .mcp.json + CLAUDE.md
ukb init --for codex                 # marker block in ~/.codex/config.toml + AGENTS.md
ukb init --for opencode              # merges opencode.json + AGENTS.md
ukb init --for pi                    # prints the config to paste, writes AGENTS.md
ukb init --for claude-code --browser # …plus the Playwright MCP server
```

`--browser` adds a second MCP server (`@playwright/mcp`) to the same config, so
the agents you onboard can also drive a browser — handy for letting them verify
their own work against the running Web UI.

Every installer is idempotent — re-running produces byte-identical files — and
preserves whatever was already there. The `AGENTS.md` / `CLAUDE.md` snippet is
the part that teaches the workflow (claim before working, review when ready),
which is why it lands even for harnesses with no dedicated installer.

`ukb doctor` reports node, store, sqlite, MCP server, default UI, wired
frameworks, and your resolved identity — and exits non-zero when something needs
attention.

## Development

```bash
pnpm install
pnpm test        # vitest, per package
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint
pnpm format      # prettier
pnpm build       # tsup
```

## License

MIT
