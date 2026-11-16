# Deploying a shared board

Status: the container stack is in this repository (`Dockerfile`, `docker-compose.yml`,
`docker/Caddyfile`, `docker/backup.mjs`). Last updated: 2026-11-16.

This runbook puts one board and its Web UI behind HTTPS on a server, with
accounts as the only way in. It is the operational counterpart of
[`shared-board-accounts.md`](shared-board-accounts.md): that document explains
the auth model, this one is the ten steps from a fresh server to a board your
machines can point at.

## What the stack is

| Piece             | Role                                                               |
| ----------------- | ------------------------------------------------------------------ |
| `ukb` container   | the board server + Web UI, one replica, SQLite on a volume         |
| `caddy` container | TLS termination (automatic certificates) and reverse proxy         |
| `ukb-data` volume | `/data`, holding `.ukb/board.db`, `.ukb/accounts.json`, `backups/` |

Constraints worth knowing before you start:

- **Single writer.** SQLite is single-writer; run one `ukb` replica. Scaling out
  means a different store, not more containers.
- **HTTPS only.** The board uses HTTP Basic auth, which sends the password on
  every request. Caddy terminates TLS; never publish plain HTTP.
- **The first account must exist before the container starts.** The server
  refuses a non-loopback bind with no accounts. That refusal is the safety net;
  create the account with `docker compose run` (below).

## 1. Prerequisites

- A Linux server with Docker Engine and the Compose plugin.
- A DNS `A`/`AAAA` record for the board hostname pointing at the server.
- Ports 80 and 443 reachable from the internet (Caddy uses 80 for the ACME
  challenge and redirects, 443 for the board).
- 1 GB RAM and a few GB of disk is plenty for a personal board.

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
editor .env      # BOARD_DOMAIN=board.example.com
```

`BOARD_DOMAIN` is the only required value. Caddy reads it from `.env` through
the compose environment.

## 4. Build

```bash
docker compose build
```

The build stage compiles the workspace and produces a production-only runtime
tree; the runtime image is the slim Node image, and backups use the bundled
`better-sqlite3` (no extra package manager at runtime).

Behind a restricted network, point the build at mirrors instead of editing the
Dockerfile:

```bash
NPM_REGISTRY=https://registry.npmmirror.com \
NODE_IMAGE=registry.example.com/library/node:22-bookworm \
NODE_RUNTIME_IMAGE=registry.example.com/library/node:22-bookworm-slim \
docker compose build
```

The same three values can live in `.env` (see `.env.example`). The builder
needs a full Node image because `better-sqlite3` is a native addon; the runtime
does not. The image runs as the
unprivileged `node` user.

## 5. Create the first account (before starting)

```bash
printf 'a long password\n' | docker compose run --rm -T ukb ukb user add alice --password-stdin
```

The first account becomes `admin`. Add more people the same way:

```bash
printf 'another password\n' | docker compose run --rm -T ukb ukb user add bob --password-stdin
```

Create machine tokens for laptops, CI and agents — the token is printed once:

```bash
docker compose run --rm -T ukb ukb user token add alice --label laptop
```

`docker compose run` uses the same image and data volume as the server, so the
accounts land in the volume the server will read.

## 6. Start

```bash
docker compose up -d
docker compose ps          # ukb healthy, caddy running
docker compose logs -f caddy
```

First run: Caddy obtains a certificate for `BOARD_DOMAIN`. Until DNS and ports
are right this is the step that fails.

## 7. Smoke test

```bash
# anonymous health is the only unauthenticated route
curl -fsS https://board.example.com/healthz

# the board asks for credentials
curl -s -o /dev/null -w '%{http_code}\n' https://board.example.com/api/board          # 401

# with the account's password
curl -s -u alice https://board.example.com/api/board >/dev/null && echo ok            # 200

# with a machine token
curl -s -H "Authorization: Bearer ukb_…" https://board.example.com/api/board >/dev/null && echo ok
```

Open `https://board.example.com/` in a browser: it prompts once, remembers the
credentials, and shows the board.

## 8. Point machines at it

```bash
ukb login --server https://board.example.com --token ukb_…   # or pipe the token
UKB_SERVER=https://board.example.com ukb board
```

Or put `"server": "https://board.example.com"` in `~/.config/ukb/config.json`.
The MCP server and the Pi/DSH plugins inherit the same settings. Setup verbs
(`web`, `init`, `doctor`, `user`) stay on the store's machine — on a client they
refuse with an explanation.

## 9. Backups

The backup is an online snapshot: better-sqlite3's `backup()` reads a consistent
database without stopping the server, and the accounts file is copied beside it.

```bash
docker compose exec -T ukb node /app/backup.mjs
docker compose exec -T ukb ls -lh /data/backups
```

The snapshot uses better-sqlite3's backup API, so it is safe while the server
runs. Files are named `board-<UTC stamp>.db` and `accounts-<UTC stamp>.json` under
`/data/backups`, pruned after 14 days (`UKB_BACKUP_KEEP_DAYS` overrides). Because
`backups/` is inside the data volume, a volume snapshot or bind mount carries
them too.

### Restore (verify this on a throwaway volume once)

```bash
docker compose stop ukb
docker compose run --rm -T ukb sh -c '
  cp /data/backups/board-20260101T000000Z.db /data/.ukb/board.db &&
  cp /data/backups/accounts-20260101T000000Z.json /data/.ukb/accounts.json &&
  rm -f /data/.ukb/board.db-wal /data/.ukb/board.db-shm'
docker compose start ukb
curl -fsS https://board.example.com/healthz
```

Restoring the accounts file too matters: a board without accounts looks open
until the server tries to bind and refuses.

## 10. Upgrade

```bash
git fetch --tags && git checkout <new tag or main>
docker compose build
docker compose up -d
docker compose ps
curl -fsS https://board.example.com/healthz
```

The data volume survives rebuilds. Take a backup before upgrading; the schema
is event-sourced and additive, but a restore is cheaper than a rollback.

## Operations

```bash
docker compose logs -f ukb        # server log (accounts, requests, errors)
docker compose logs -f caddy      # TLS / proxy problems
docker compose restart ukb
docker compose run --rm ukb ukb user list
docker compose run --rm ukb ukb user token revoke <id>
```

## Security checklist

- [ ] `.env` is not committed (only `.env.example` is).
- [ ] Port 8787 is **not** published — only Caddy listens publicly.
- [ ] At least one account exists; no `--allow-anonymous` on a public host.
- [ ] HTTPS works; `http://` redirects to `https://`.
- [ ] Data volume is not world-readable; backups copied off the box periodically.
- [ ] Tokens can be revoked per machine (`ukb user token revoke`).
- [ ] One replica: no second `ukb` service against the same SQLite file.

## Troubleshooting

| Symptom                                                      | Cause                                              | Fix                                                      |
| ------------------------------------------------------------ | -------------------------------------------------- | -------------------------------------------------------- |
| container exits: `refusing to bind 0.0.0.0 without accounts` | no account yet                                     | step 5, then `docker compose up -d`                      |
| browser keeps prompting                                      | wrong password, or a proxy in front not forwarding | check `docker compose logs ukb`; test with `curl -u`     |
| `401` with a token                                           | token revoked or from another server               | mint a new one, `ukb login` again                        |
| Caddy cannot get a certificate                               | DNS not pointing here, or 80/443 blocked           | `docker compose logs caddy`; check A record and firewall |
| `EACCES` on `/data`                                          | bind mount ownership                               | `chown -R 1000:1000 <dir>` (the image runs as `node`)    |
| writes slow or `database is locked`                          | second replica on the same volume                  | keep exactly one `ukb`                                   |
