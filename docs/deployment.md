# Deploying a shared board

Status: the container stack is in this repository (`Dockerfile`, `docker-compose.yml`,
`docker/Caddyfile`, `docker/backup-pg.sh`). Last updated: 2026-11-16.

This runbook puts one board and its Web UI behind HTTPS on a server, with
Postgres as the store and accounts as the only way in. It is the operational
counterpart of [`shared-board-accounts.md`](shared-board-accounts.md): that
document explains the auth model, this one is the steps from a fresh server to a
board your machines can point at.

## What the stack is

| Piece                | Role                                                                   |
| -------------------- | ---------------------------------------------------------------------- |
| `postgres` container | the board's event log: durable, standard backups, not published        |
| `ukb` container      | the server + Web UI, one replica, reads/writes Postgres                |
| `caddy` container    | TLS termination (automatic certificates) and reverse proxy             |
| `pg-data` volume     | Postgres data                                                          |
| `ukb-data` volume    | `/data`: accounts (`accounts.json`) and backups made inside the volume |

Constraints worth knowing before you start:

- **One `ukb` replica.** The engine still assumes a single server process per
  board; Postgres gives durability and standard backups, not multi-writer
  coordination yet.
- **HTTPS only.** The board uses HTTP Basic auth, which sends the password on
  every request. Caddy terminates TLS; never publish plain HTTP.
- **The first account must exist before the container starts.** The server
  refuses a non-loopback bind with no accounts. That refusal is the safety net,
  and it is a setup step rather than a crash: the process exits 78 (EX_CONFIG)
  and prints the board path and the command that creates the account. Create it
  with `docker compose run` (below).
- **Postgres is internal.** It has no published port; only the compose network
  reaches it. Keep `POSTGRES_PASSWORD` URL-safe (letters/digits) or set
  `UKB_PG_URL` explicitly with a properly encoded password.

## 1. Prerequisites

- A Linux server with Docker Engine and the Compose plugin.
- A DNS `A`/`AAAA` record for the board hostname pointing at the server.
- Ports 80 and 443 reachable from the internet.
- 2 GB RAM and a few GB of disk is plenty for a personal board.

## 2. Get the code

```bash
git clone https://github.com/wayblink/using-kanban.git
cd using-kanban
git checkout main
```

Deploy a tag or a pinned commit rather than a moving branch if you plan to
upgrade infrequently.

## 3. Configure

```bash
cp .env.example .env
editor .env      # BOARD_DOMAIN=board.example.com and POSTGRES_PASSWORD=…
```

`BOARD_DOMAIN` is the hostname Caddy serves; `POSTGRES_PASSWORD` is the database
password. Both are required. `POSTGRES_USER`/`POSTGRES_DB` default to `ukb`.

For a personal, single-user board you may also set `UKB_AUTH=off`: that turns
off the login challenge and the per-card creator/assignee guard, and allows
anonymous writes. It is for a trusted/personal host only; leave `auth` on
(default) for a board shared by several people.

## 4. Build

```bash
docker compose build
```

The build stage compiles the workspace and produces a production-only runtime
tree; the runtime image is the slim Node image. Behind a restricted network,
point the build at mirrors without editing the Dockerfile:

```bash
NPM_REGISTRY=https://registry.npmmirror.com \
NODE_IMAGE=registry.example.com/library/node:22-bookworm \
NODE_RUNTIME_IMAGE=registry.example.com/library/node:22-bookworm-slim \
docker compose build
```

The same values can live in `.env`. The builder needs a full Node image (the
CLI still ships SQLite for local use); the server runtime does not need a
compiler.

### Pulling the published image

A `v*` tag (or a manual **Release** workflow run) publishes
`ghcr.io/wayblink/using-kanban:<tag>` and `:latest`. If the package is private,
sign in once with a GHCR token that can read packages:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
UKB_IMAGE=ghcr.io/wayblink/using-kanban:latest docker compose pull ukb
UKB_IMAGE=ghcr.io/wayblink/using-kanban:latest docker compose up -d
```

`docker compose build` still works and tags the local build with the same
image name, so a server without registry access is unaffected.

## 5. Create the first account (before starting the board)

Start the database, not the board:

```bash
docker compose up -d postgres
printf 'a long password\n' | docker compose run --rm -T ukb ukb user add alice --password-stdin
```

The first account becomes `admin`. Add people the same way, and machine tokens
for laptops, CI and agents (the token is printed once):

```bash
printf 'another password\n' | docker compose run --rm -T ukb ukb user add bob --password-stdin
docker compose run --rm -T ukb ukb user token add alice --label laptop
```

`docker compose run` uses the same image and the `/data` volume as the server,
so the accounts land where the server will read them.

## 6. Start

```bash
docker compose up -d
docker compose ps          # postgres healthy, ukb healthy, caddy running
docker compose logs -f caddy
```

First run: Caddy obtains a certificate for `BOARD_DOMAIN`. Until DNS and ports
are right this is the step that fails.

## 7. Smoke test

```bash
# anonymous health is the only unauthenticated route
curl -fsS https://board.example.com/healthz

# the board asks for credentials
curl -s -o /dev/null -w '%{http_code}\n' https://board.example.com/api/board   # 401

# with the account's password
curl -s -u alice https://board.example.com/api/board >/dev/null && echo ok    # 200

# with a machine token
curl -s -H "Authorization: Bearer ukb_…" https://board.example.com/api/board >/dev/null && echo ok
```

Open `https://board.example.com/` in a browser: it prompts once, remembers the
credentials, and shows the board.

## 8. Point machines at it

```bash
ukb login --server https://board.example.com --token ukb_…
UKB_SERVER=https://board.example.com ukb board
```

Or put `"server": "https://board.example.com"` in `~/.config/ukb/config.json`.
The MCP server and the Pi/DSH plugins inherit the same settings. Setup verbs
(`web`, `init`, `doctor`, `user`, `migrate`) stay on the store's machine — on a
client they refuse with an explanation.

## 9. Migrating an existing SQLite board

If you already ran the SQLite version of this stack (the `ukb-data` volume has
`.ukb/board.db`), copy it in once. Event ids and card handles are preserved.

```bash
docker compose up -d postgres
docker compose run --rm -T ukb \
  ukb migrate --to postgres --from /data/.ukb/board.db --pg-url "$UKB_PG_URL"
docker compose up -d
```

`UKB_PG_URL` is already in the compose environment; the command refuses a
non-empty target unless `--force`, and `--dry-run` reports the event count
first. Keep the SQLite file until the Postgres board has been verified.

## 9b. Migrating another machine's board over HTTP

The server can accept a one-shot event-log upload, which is the way to move a
board from a laptop without copying files or opening SSH. It is off by default
and admin-only.

On the server, enable it for the migration window and restart the board:

```bash
echo 'UKB_ALLOW_IMPORT=1' >> .env
docker compose up -d ukb
docker compose run --rm -T ukb ukb user token add alice --label migration
```

The token is printed once. On the machine that owns the old board:

```bash
ukb migrate --to https://board.example.com --token ukb_… --dry-run
ukb migrate --to https://board.example.com --token ukb_…
```

The upload keeps event ids, card ids, timestamps, actors and the history of
deleted cards; it refuses a non-empty target unless `--force`. When it is done,
remove `UKB_ALLOW_IMPORT=1` from `.env` and `docker compose up -d ukb` again —
the endpoint answers 404 while disabled.

## 10. Backups

The database and the accounts file are separate, and both are needed.

```bash
./docker/backup-pg.sh
ls -lh backups
```

`pg_dump` runs inside the database container, so the password never appears on
the host command line; it writes `backups/board-<UTC>.dump` and
`backups/accounts-<UTC>.json` (0600), pruned after 14 days
(`BACKUP_KEEP_DAYS` overrides). Copy these off the box periodically.

### Restore (verify this on a throwaway stack once)

```bash
docker compose stop ukb
docker compose exec -T postgres sh -c \
  'pg_restore --clean --if-exists -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < backups/board-20260101T000000Z.dump
docker compose run --rm -T --no-deps ukb sh -c \
  'cat > /data/.ukb/accounts.json && chmod 600 /data/.ukb/accounts.json' \
  < backups/accounts-20260101T000000Z.json
docker compose start ukb
curl -fsS https://board.example.com/healthz
```

Restoring the accounts file too matters: a board without accounts looks open
until the server tries to bind and refuses.

## 11. Upgrade

```bash
git fetch --tags && git checkout <new tag or main>
docker compose build
docker compose up -d
docker compose ps
curl -fsS https://board.example.com/healthz
```

The `pg-data` and `ukb-data` volumes survive rebuilds. Take a backup before
upgrading; a restore is cheaper than a rollback.

## Operations

```bash
docker compose logs -f ukb        # server log
docker compose logs -f postgres   # database log
docker compose logs -f caddy      # TLS / proxy problems
docker compose restart ukb
docker compose exec -T postgres psql -U ukb -d ukb -c '\dt'
docker compose run --rm ukb ukb user list
docker compose run --rm ukb ukb user token revoke <id>
```

## Security checklist

- [ ] `.env` is not committed (only `.env.example` is).
- [ ] Postgres has no published port; only the compose network reaches it.
- [ ] Port 8787 is not published — only Caddy listens publicly.
- [ ] At least one account exists; no `--allow-anonymous` on a public host
      (the flag leaves reads open to the LAN; writes still need the token).
- [ ] HTTPS works; `http://` redirects to `https://`.
- [ ] Backups are copied off the server periodically.
- [ ] Tokens can be revoked per machine (`ukb user token revoke`).
- [ ] One `ukb` replica per board.
- [ ] `UKB_AUTH` is only off for a personal/trusted board; shared boards keep
      login and the creator/assignee guard.

## Troubleshooting

| Symptom                                                               | Cause                                     | Fix                                                             |
| --------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------- |
| `ukb` restarts (exit 78): `refusing to bind 0.0.0.0 without accounts` | no account yet                            | step 5, then `docker compose up -d`                             |
| `ukb` restarts: Postgres connection refused                           | database not healthy                      | `docker compose logs postgres`; `docker compose up -d postgres` |
| `password authentication failed`                                      | password changed in `.env`, old volume    | keep the old password in `UKB_PG_URL`, or reset it in Postgres  |
| browser keeps prompting                                               | wrong password, or a proxy not forwarding | `docker compose logs ukb`; test with `curl -u`                  |
| `401` with a token                                                    | token revoked or from another server      | mint a new one, `ukb login` again                               |
| Caddy cannot get a certificate                                        | DNS not pointing here, or 80/443 blocked  | `docker compose logs caddy`; check A record and firewall        |
| `EACCES` on `/data`                                                   | bind mount ownership                      | `chown -R 1000:1000 <dir>` (the image runs as `node`)           |
| writes slow or `database is locked` (SQLite mode)                     | second replica on the same file           | keep exactly one `ukb`                                          |
