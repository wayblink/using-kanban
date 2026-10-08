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
| `@using-kanban/mcp`    | ⬜     | MCP stdio server — the multi-framework front door                    |
| `@using-kanban/web`    | ⬜     | Default single-file Web UI (drag & drop, live updates)               |
| `@using-kanban/cli`    | ⬜     | Thin client, binary `ukb` + `init --for <framework>` installers      |

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

## MCP (planned, `@using-kanban/mcp`)

One stdio server, tools mapped 1:1 onto core actions: `board`, `my_cards`,
`card_show`, `card_add`, `card_edit`, `card_claim`, `card_review`, `card_done`,
`card_reopen`, `card_move`, `card_delete`, `card_block`.

The workflow lives in the tool descriptions — `my_cards` says _"call at turn
start; claim todo cards before working them; move to review when ready"_ — so
even a naive agent behaves correctly. `init --for claude-code|cursor|opencode|…`
writes the MCP config plus an `AGENTS.md` snippet for each framework.

## CLI (planned, `@using-kanban/cli`)

The `ukb` binary is a thin client over the same core — same board, same events:

```bash
ukb                                       # my open cards (a call to act, not a status dump)
ukb board                                 # full board
ukb add "fix flaky test" --assignee claude-code --reviewer jyxc
ukb claim 3                               # todo → doing, assigned to me
ukb review 3                              # → review, notifies the reviewer
ukb done 3
ukb web                                   # start the local Web UI and open it
```

Run it from the project you want to board — the store lives at `<project>/.ukb/`.

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
