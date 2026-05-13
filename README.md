# qcontrol — VPS control panel

Manage every docker-compose project under `/opt` and the shared reverse-proxy
from a single web UI. No more SSH-ing in to edit `.env`, restart containers,
or reload Caddy.

## What it does today (MVP)

1. **Projects view** — lists every project under `/opt`, shows running /
   stopped, current git branch + last commit, and an action panel per project
   (Restart, Up, Rebuild, Pull + Rebuild, Down, tail logs).
2. **Reverse-proxy editor** — edit `/opt/reverse-proxy/.env` and `Caddyfile`
   in the browser, validate, then validate-and-reload Caddy in place.
   Validation runs first — if it fails the reload is skipped, so a typo
   can't blank out every site.
3. **Single shared bearer token auth** — set `QCONTROL_TOKEN`, type it once
   in the browser, cookie carries it for 30 days. No user accounts to
   manage; the operator (you) is the only user.

## Architecture (briefly)

- **Express + React SPA** in a single Node container.
- Mounts `/var/run/docker.sock` (lets us shell out to `docker ps`,
  `docker compose up`, etc.) and `/opt` (so we can list projects and write
  the reverse-proxy files).
- Stateless — restart the container any time, no data to migrate.

## Deploy on the VPS

Drop into `/opt/qcontrol`, follow the shared-reverse-proxy convention:

```bash
cd /opt
git clone <your-qcontrol-repo>.git qcontrol
cd qcontrol
cp .env.vps.example .env
# Generate a strong token:
openssl rand -hex 32        # paste into QCONTROL_TOKEN= in .env
nano .env
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --build
```

Then in `/opt/reverse-proxy`:

1. Append to `.env`:
   ```
   QCONTROL_DOMAIN=qcontrol.<your-domain>
   QCONTROL_UPSTREAM=127.0.0.1:8089
   ```
2. Append to `Caddyfile`:
   ```
   {$QCONTROL_DOMAIN} {
     reverse_proxy {$QCONTROL_UPSTREAM}
   }
   ```
3. `./deploy-vps.sh`

Hit `https://qcontrol.<your-domain>`, paste the token, you're in.

## Why a separate project, not part of reverse-proxy?

- Can't safely manage reverse-proxy from inside reverse-proxy (UI would
  vanish mid-reload if anything went wrong).
- Needs broader access than reverse-proxy itself (docker socket, /opt
  read-write) — those should not be granted to the TLS terminator.
- Survives reverse-proxy outages — you can still hit qcontrol on its
  127.0.0.1:8089 port directly to debug.

## Roadmap (not in MVP yet)

- **Clone-to-staging wizard** — pick a project, fork it as `<name>-staging`,
  auto-allocate next free port, generate `.env`, append reverse-proxy entry,
  bring it up. Half-day of work, deferred from the MVP because of port
  allocation + env templating complexity.
- **Live log streaming** (websocket) — current `Tail logs` is one-shot.
- **In-container shell** (xterm.js + websocket) — handy but not blocking.

## Security notes

- The bearer token is effectively root on this VPS. Use a long random
  string (`openssl rand -hex 32`), never share it, rotate it if leaked.
- Consider adding an IP allow-list in `/opt/reverse-proxy/Caddyfile` for
  the qcontrol domain block:
  ```
  {$QCONTROL_DOMAIN} {
    @allowed remote_ip 1.2.3.4 5.6.7.8
    handle @allowed { reverse_proxy {$QCONTROL_UPSTREAM} }
    respond 403
  }
  ```
- The container has docker socket + /opt write — if it's compromised, so
  is the host. Single-tenant only, do not multi-user this.
