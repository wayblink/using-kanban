# Sharing one board: server access and accounts

Status: implemented for the HTTP/Web door; remote CLI/MCP is the next card.
Last updated: 2026-11-16

## Goal

Use one board from several machines. A board is a store directory
(`<dir>/.ukb/`), and until now every door opened it directly: the CLI, the MCP
server, the Pi and DSH plugins, and the HTTP server behind `ukb web`. That
works because SQLite WAL tolerates concurrent local processes, not because the
board is shareable.

The split that makes sharing possible:

| Door                     | Transport                             | Who it is for                                |
| ------------------------ | ------------------------------------- | -------------------------------------------- |
| Web UI, HTTP API         | the server over HTTPS                 | browsers on any machine, scripts, dashboards |
| CLI, MCP, Pi/DSH plugins | local store (still), remote HTTP next | agents on the same machine                   |

This document covers the server door: how it is exposed safely and who may
read it. Today the CLI and MCP still open the local store; pointing them at the
remote server is a separate change.

## Why not just open the port

The existing server has one generated bearer token: mutations need it, reads on
loopback are free, and a non-loopback bind simply requires a token. That is
enough for a process on the same laptop, not for a board on a VPS:

- one shared secret cannot be revoked per person or per machine;
- a token in a URL ends up in shell history, browser history and logs;
- "reads are free on loopback" is wrong behind a reverse proxy, where every
  request arrives from 127.0.0.1.

So the server gets named accounts. Basic auth is the smallest mechanism that
browsers already implement (a native prompt, no login page, no session store,
no CSRF surface), and machine tokens keep passwords off CI and agent configs.

## The model

**Accounts** live in `<dir>/.ukb/accounts.json`, beside the board:

```json
{
  "version": 1,
  "users": [
    {
      "name": "alice",
      "role": "admin",
      "salt": "…",
      "hash": "…",
      "n": 16384,
      "r": 8,
      "p": 1,
      "createdAt": "…"
    }
  ],
  "tokens": [
    {
      "id": "…",
      "label": "laptop",
      "user": "alice",
      "role": "admin",
      "hash": "…",
      "createdAt": "…"
    }
  ]
}
```

- Passwords: scrypt (N=16384, r=8, p=1, 32-byte key, 16-byte salt), per-account
  parameters so a future cost bump can migrate lazily.
- Tokens: 32 random bytes, prefix `ukb_`; the file keeps sha256(token) only, and
  the raw value is printed once.
- The file is written atomically and 0600. One store directory is one board and
  one set of accounts.
- `role` is `admin` or `member`. It is recorded and reported, but no card
  permission depends on it yet: the board's cooperative owner rule still comes
  from the server's `owner` option.

**Enforcement** happens in the request handler before any route runs, including
static UI files:

- If the file has at least one account, every request needs either
  `Authorization: Basic …` or `Authorization: Bearer <token>`.
  `GET /healthz` stays anonymous so a probe does not need a secret.
- The server's generated `--token` keeps working as a service credential; it is
  the same value printed in the `ukb web` URL.
- Without accounts, the old rules apply: token for mutations, reads free on
  loopback.
- A non-loopback bind with no accounts refuses to start, unless
  `--allow-anonymous` says the network is trusted.

**Failure handling**:

- Wrong credentials: 401 with `WWW-Authenticate: Basic realm="ukb"` so a browser
  prompts. No account names leak from failed attempts.
- Ten failures from one address inside a minute block that address for a
  minute (429). Coarse on purpose; behind a reverse proxy every client shares
  the proxy's address, so this is a speed bump, not a per-user lockout.
- A malformed accounts file fails closed (500), never "no accounts, let them in".
- Unknown names run the same scrypt work as known ones, so timing does not
  reveal which accounts exist.

## Operating it

```bash
ukb user add alice                 # first account is an admin
ukb user add bob --role member
ukb user token add alice --label laptop   # once; copy it somewhere safe
ukb user list
ukb user token list
ukb user token revoke <id>
ukb user passwd alice
ukb user remove bob                # also revokes bob's tokens
```

Password input is muted in a terminal, or piped with `--password-stdin` for
setup scripts; it is never accepted as a command-line argument (shell history).

Bind beyond loopback only behind TLS:

```bash
ukb web --host 127.0.0.1 --port 8787 --dir /srv/ukb
# Caddy/Nginx terminates TLS and proxies to 127.0.0.1:8787
```

The server does not terminate TLS. Basic auth without TLS exposes the password
on every request. The deployment runbook (container, proxy example, backups,
upgrades) is the next card.

## What this does not do

- No per-card or per-project permissions; accounts gate the whole board.
- No sessions or single sign-on; a browser caches Basic credentials until it is
  closed or the credentials change.
- No remote CLI/MCP yet: those still open the local store.
- No audit trail for sign-ins; mutations already carry the actor name in the
  event log.
- No per-actor enforcement: a signed-in caller may still set `X-Actor-Name` to
  another name. The audit trail records what the caller claims, not a verified
  per-agent identity.

## Decisions

1. **Basic over cookie sessions** — no login page, no CSRF token, no session
   storage, and browsers/curl/scripts all speak it. The cost is a password per
   request over a connection that must be TLS.
2. **Account file, not a database table** — the CLI can add an account without a
   running server, and the file is trivial to back up with the board.
3. **Refuse the dangerous bind by default** — an operator who typed `--host
0.0.0.0` gets an error that tells them to create an account, rather than a
   board on the internet.
4. **Keep the generated bearer token** — it is how scripts and the printed
   `ukb web` URL already work; accounts add humans without breaking that.

## Open questions

- Do cards need per-account permissions, or is "one person, several machines"
  the only case? The current answer assumes the latter.
- Should the token be scoped (read-only, one project) before remote CLI lands?
- Behind a proxy, should the throttle trust `X-Forwarded-For`? It does not yet.
- Should `X-Actor-Name` be pinned to the signed-in account for writes, so audit
  rows cannot claim another person's name?
