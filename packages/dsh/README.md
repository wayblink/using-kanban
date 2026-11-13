# @wayblink/using-kanban-dsh

DeepSeek Harness bundle for `using-kanban`: one `ukb` tool, the `/ukb` command,
and the board guidance in the system prompt.

It holds no board logic. Every call runs the `ukb` CLI, so validation,
transitions, attribution and error codes are the CLI's.

## Install

From this checkout:

```bash
scripts/install.sh dsh     # expose the skill and print the bundle directory
```

Then install the bundle directory in DSH: **Plugins** → **Add plugin** →
`<checkout>/packages/dsh`. The directory is linked into the profile, so a
`git pull` is live after DSH reloads.

## Surfaces

- `ukb` tool — 21 verbs, typed parameters, ids positional exactly as on the CLI.
- `tool:ukb` prompt section — claim-before-work, one card in `doing`, bodies
  before action, umbrella/child rules.
- `/ukb` command — no args lists your cards; everything else passes through.

## Visualization

`client.js` ships three surfaces: a Tool view for `ukb` calls (board JSON as
columns, other verbs as a card), a right-Sidebar `Kanban` panel tab, and a
composer chip with doing/todo/review counts that opens it. The panel and chip read
the bundle's own `GET /api/ukb/board` route. Plain JS, no build step.

## Tests

```bash
node --test packages/dsh/test/*.test.js
```

The suite covers the pure argument mapping and the call summary.
