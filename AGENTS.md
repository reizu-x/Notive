# Notive Dev — agent notes

## Working agreements

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
