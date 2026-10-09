# Notive — agent notes

## Topology (declared 2026-10-09)

- **This PC is a development machine only.** Every Notive-local folder
  (repo at `~/Documents/Notive`, old DrafNote/Notely copies, backups,
  `~/.local/lib/notely`, Desktop notes) is treated as **development or
  artifact** — never production.
- **Production = the VPS** (`ssh notive-vps`, 87.232.225.109, `/opt/notive`,
  user `notive`, rootless podman + systemd user units, socat 443→5001).
- Deploys: push to `main` → GitHub Actions `Deploy to VPS` (rsync → build →
  restart → healthcheck 200 or fail). `.env`, `certs/`, `notive.key` on the
  VPS are server-only state — never overwritten by deploys.
- SSH access is key-only: local `~/.ssh/id_notive_vps` (alias `notive-vps`),
  GitHub Actions deploy key. The `notive` password is locked (2026-10-09);
  root path = sudoers stub `/etc/sudoers.d/notive-deploy-tmp` while install
  work continues. Recovery fallback: provider cloud console.
- Known VPS quirk (2026-10-09): **all outbound TCP is RST-ed upstream**
  (provider-side). Inbound is fine. Image pulls / apt / Let's Encrypt blocked
  until unblocked; deploys that need new base layers will fail. Firewall
  (ufw) currently disabled for debugging.

## Working agreements

- **Never push to any remote without explicit approval in the current
  request.** Commits stay local; always show the diff/summary and ask
  "push?" before `git push`. Before this rule, push-triggered CI deploys ran
  automatically — from now on they only fire when the user approves the push.
- **Never generate any image (screenshots, mockups, previews, icons, exports)
  unless the user explicitly asks for that image in the request.**
- **Never write files to the user's Desktop (~/Desktop) unless the user
  explicitly asks for it in that request.** Generated artifacts stay in
  `/tmp/opencode` by default; only copy them to the Desktop on request.

## Running / restarting the dev server

The dev server is **HTTPS-only**. It binds `0.0.0.0:5001` and loads
`certs/notive.crt` + `certs/notive.key` by default — no env vars required:

```bash
nohup python3 server.py > /home/r3izu/Documents/audit/server-dev.log 2>&1 &
```

## Production: gunicorn (verified 2026-09-24)

`gunicorn.conf.py` runs the same app on a production WSGI server:
single worker + 8 threads (`workers = 1` is load-bearing — SSE streams and
the backup loop are per-process state), same hardened TLS policy as the dev
server (verified: TLS 1.1/RC4 rejected, TLS 1.2 AEAD + 1.3 accepted).

```bash
nohup python3 -m gunicorn -c gunicorn.conf.py server:app > /home/r3izu/Documents/audit/server-dev.log 2>&1 &
```

`python server.py` stays as the dev path. Under gunicorn `__main__` never
runs, so schema init + the backup loop start in `post_fork` instead.

## Containers: Podman (verified 2026-09-25)

App and Postgres run in SEPARATE containers (`podman-compose.yml` + `Containerfile`).
Same single-worker gunicorn inside; DSN points at `host=db`.

```bash
podman-compose up -d --build   # first run
podman-compose logs -f app     # expect NOTIVE DB + BACKUP lines
podman-compose down            # stop; pgdata/appdata volumes persist
```

Rules: secrets live in `.env` (gitignored) — never in the image. `notive.key`
is seeded into `appdata` BEFORE first boot with migrated data (the app would
otherwise generate a fresh key that can't read it). Certs mount read-only.
Hourly dumps land in `appdata/dbbackup` — copy that volume off-host.

Optional overrides:
- `PORT` (default `5001`)
- `NOTIVE_BIND_HOST` (default `0.0.0.0`)
- `NOTIVE_TLS_CERT` / `NOTIVE_TLS_KEY` (default `certs/notive.crt` / `certs/notive.key`)

The server **refuses to start** without a cert/key (there is no plain-HTTP mode).

- Reachable from other PCs at: **https://192.168.22.241:5001**
- Local: https://127.0.0.1:5001
- TLS is a **local CA** setup: `certs/notive-ca.crt` (root CA) signs
  `certs/notive.crt` (server). Trust `certs/notive-ca.crt` once on each client
  and the browser stops showing "Not Secure".
- If the LAN IP changes, regenerate with the new IP:
  `./certs/generate-certs.sh 192.168.22.241` (extra IPs become SANs), then
  re-copy `certs/notive-ca.crt` to clients and restart the server.

Verify after restart:
```bash
curl -sk -o /dev/null -w "%{http_code}\n" https://192.168.22.241:5001/   # expect 200
ss -tlnp | grep 5001                                                      # expect 0.0.0.0:5001
```

## Restart ritual (DB-safety, learned 2026-09-24)

A stale `NOTIVE_PG_DSN` once pointed a live server at a dropped database
(all requests 500'd) while the boot log looked normal. Every restart must:

1. Strip DSN overrides unless intentionally migrating:
   `env -u NOTIVE_PG_DSN` prefix, or `unset` first in persistent shells.
2. Kill the old process by explicit PID from `ss -tlnp` (never `pkill -f`
   with a pattern that matches your own shell).
3. After boot, confirm the banner says `[compiled default]` (or the intended
   `[NOTIVE_PG_DSN override]`) and verify the live process env:
```bash
tr '\0' '\n' < /proc/$(ss -tlnp | grep -oP ':5001.*pid=\K\d+' | head -1)/environ | grep _PG_DSN || echo "clean"
```
4. Never DROP a database/role without first confirming no live process
   points at it (check the banner + process env above).
