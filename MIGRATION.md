# Migration checklist: PC → VPS (Ubuntu 24.04 LTS, Podman)

Stack moves byte-identical: `podman-compose.yml` + `Containerfile` are the
production artifact. App and Postgres run in SEPARATE containers; one VPS is
plenty (personal/small-team load is trivial).

## Phase 0 — Prep on this PC

- [ ] `git status` clean; commit and `git push origin Dev` everything.
- [ ] Fresh safety dump (ciphertext-only, safe to handle):
  `podman exec -e PGPASSWORD="$(grep POSTGRES_PASSWORD .env | cut -d= -f2)" \
    notive_db_1 pg_dump -U notive -d notivedb --clean --if-exists > /tmp/opencode/mig-$(date +%F).sql`
- [ ] DNS: `A <domain> → <VPS-IP>` resolving (needed for Let's Encrypt).
- [ ] Decide: migrate data (copy key + restore dump) or start clean
  (fresh key auto-creates; old data unreadable without the old key).

## Phase 1 — VPS base

```bash
apt update && apt upgrade -y
adduser deploy && usermod -aG sudo deploy
# /etc/ssh/sshd_config: PasswordAuthentication no, PermitRootLogin no
ufw allow 22,80,443/tcp && ufw enable
apt install -y podman podman-compose git
```

## Phase 2 — Code and secrets (secrets NEVER via git)

```bash
git clone -b Dev git@github.com:reizu-x/Notive.git /opt/notive
cd /opt/notive
# .env — GENERATE FRESH, do not reuse the dev password:
printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)" > .env && chmod 600 .env
# DB key — SAME file only if migrating data, else skip (auto-creates):
scp notive.key deploy@<VPS>:/opt/notive/notive.key
```

## Phase 3 — TLS (Let's Encrypt, needs port 80 open)

```bash
apt install -y certbot
certbot certonly --standalone -d <domain>
cp /etc/letsencrypt/live/<domain>/fullchain.pem certs/notive.crt
cp /etc/letsencrypt/live/<domain>/privkey.pem certs/notive.key
# Renewal hook (SSL context binds at listener creation: restart, not reload):
echo '--deploy-hook "systemctl restart notive"' >> /etc/letsencrypt/renewal/<domain>.conf
```
(Certs mount read-only into the app container; nothing secret is baked
into the image — see `.containerignore`.)

## Phase 4 — First boot

```bash
podman-compose up -d db          # wait healthy: podman ps shows (healthy)
# If migrating data (else skip to app start — schema self-creates):
cat /tmp/opencode/mig-<date>.sql | podman exec -i \
  -e PGPASSWORD="$(grep POSTGRES_PASSWORD .env | cut -d= -f2)" \
  notive_db_1 psql -U notive -d notivedb
# Seed key BEFORE app boot, only when migrating (else the app generates a
# fresh key that cannot read migrated ciphertext):
podman volume create notive_appdata
podman run --rm -v notive_appdata:/data -v ./:/src:ro \
  docker.io/library/alpine cp -p /src/notive.key /data/
podman-compose up -d app
podman-compose logs -f app      # expect NOTIVE DB + BACKUP lines
```

## Phase 5 — Survive reboot (compose alone doesn't)

`/etc/systemd/system/notive.service`:
```ini
[Unit]
Description=Notive (podman-compose)
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/notive
ExecStart=/usr/bin/podman-compose up -d
ExecStop=/usr/bin/podman-compose down
[Install]
WantedBy=multi-user.target
```
```bash
systemctl enable --now notive
# Then reboot-test once: reboot, confirm :5001 answers after boot.
```
(This exact gap once left the app down for two weeks after a reboot —
do not skip the reboot test.)

Port 443 note: rootless Podman can't bind it. Pick one: run rootful
Podman, map `5001:5001` + firewall REDIRECT 443→5001, or Caddy in front
(Caddy also automates Phase 3 renewals).

## Phase 6 — Verify on the VPS

```bash
curl -o /dev/null -w "%{http_code}\n" https://<domain>:5001/   # 200, NO -k flag
echo | openssl s_client -connect <domain>:5001 -tls1_1 2>&1 | grep -i alert  # must fail
```
In browser: log in (migrated data) or register fresh; create + sync a note,
logout/login. Key integrity spot-check:
`sha256sum notive.key` vs the copy inside `notive_appdata` — must match.

## Phase 7 — Backups (day one, not later)

- Hourly dumps already land in `appdata/dbbackup` — pull them off the VPS
  (cron + scp/rsync to home PC or B2).
- Store one copy of `notive.key` OFFLINE. Without it every backup is a brick.

## Phase 8 — Cutover

- Only stop the PC instance after Phase 6 passes. Never run both live with
  data — two databases = split-brain.
- PC becomes staging/dev (run dev on `PORT=5002` if both must coexist).

## Rollback

`podman-compose down` on VPS + restart the PC server — DNS flip back if
already pointed. Nothing on the PC is touched by this migration until
Phase 8, so rollback is always one command away.
