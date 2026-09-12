# Notely Dev — agent notes

## Working agreements

- **Never generate any image (screenshots, mockups, previews, icons, exports)
  unless the user explicitly asks for that image in the request.**
- **Never write files to the user's Desktop (~/Desktop) unless the user
  explicitly asks for it in that request.** Generated artifacts stay in
  `/tmp/opencode` by default; only copy them to the Desktop on request.

## Running / restarting the dev server

The dev server is **HTTPS-only**. It binds `0.0.0.0:5001` and loads
`certs/notely.crt` + `certs/notely.key` by default — no env vars required:

```bash
nohup python3 server.py > server-dev.log 2>&1 &
```

Optional overrides:
- `PORT` (default `5001`)
- `NOTELY_BIND_HOST` (default `0.0.0.0`)
- `NOTELY_TLS_CERT` / `NOTELY_TLS_KEY` (default `certs/notely.crt` / `certs/notely.key`)

The server **refuses to start** without a cert/key (there is no plain-HTTP mode).

- Reachable from other PCs at: **https://192.168.22.241:5001**
- Local: https://127.0.0.1:5001
- TLS is a **local CA** setup: `certs/notely-ca.crt` (root CA) signs
  `certs/notely.crt` (server). Trust `certs/notely-ca.crt` once on each client
  and the browser stops showing "Not Secure".
- If the LAN IP changes, regenerate with the new IP:
  `./certs/generate-certs.sh 192.168.22.241` (extra IPs become SANs), then
  re-copy `certs/notely-ca.crt` to clients and restart the server.

Verify after restart:
```bash
curl -sk -o /dev/null -w "%{http_code}\n" https://192.168.22.241:5001/   # expect 200
ss -tlnp | grep 5001                                                      # expect 0.0.0.0:5001
```
