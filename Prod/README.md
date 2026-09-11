# Notely — private, end-to-end encrypted notes

Self-hosted notes app with zero build step: a Flask backend (`server.py`), a vanilla-JS SPA (`app.js` + `index.html` + `styles.css`), and SQLite for persistence. No npm, no framework, no third-party requests.

```
browser (WebCrypto + vendored Argon2) <--HTTPS/JSON--> Flask --> SQLite (notely.db)
```

## Stack

* **Backend:** Python 3 + Flask (~1.2k LOC), `cryptography` (AES-GCM), `argon2-cffi` (Argon2id). `requirements.txt` only.
* **Frontend:** Single IIFE in `app.js` (~5.1k LOC), no bundler. `index.html` app shell, `styles.css` theming (Light / Dark / Dracula).
* **Storage:** `notely.db` (users, sessions, `user_notes`, `vault_meta`, `rate_hits`) + `notely.key` (32-byte DB key, `0600`, or `NOTELY_DB_KEY` env).

## Technical core: E2EE

The server **cannot read notes**. Each account owns a random 256-bit master key generated in the browser:

1. **KDF:** Argon2id `t=3, m=64MiB, p=1, 32B` — pinned on both sides (`ARGON2_DESCRIPTOR`). Server rejects anything else.
2. **Two independent derivations:** `salt_auth -> auth verifier` (sent for login), `salt_enc -> KEK` (wraps master key via AES-GCM). Password/KEK never leave the device.
3. **Notes:** whole workspace `JSON({v, notes, vault})` encrypted with the master key (AES-GCM-256) via WebCrypto. `PUT /api/notes` stores only opaque `{iv, data}` blob.
4. **Unlock model:** master key lives in memory only. Reload with a valid session cookie still requires the password.
5. **Argon2 supply-chain:** `vendor/argon2/` (`argon2.js` + `.wasm` + wrapper) is SRI + SHA-384 verified before execution. CSP uses `wasm-unsafe-eval` only.
6. **Vault:** second password, separate `vault_meta` table (verifier + wrapped DEK). Vault notes ride inside the E2EE blob as ciphertext.
7. **Migration:** legacy PBKDF2-SHA256 (210k iter) accounts auto-upgrade to Argon2id-E2EE on next password login; UI folder names stored in an encrypted `localStorage` UI-vault.

Server-side AES-GCM under the DB key protects only metadata: display profile, legacy notes.

## Backend API

`GET /api/kdf-params` (dummy shape for unknown users) · `POST /api/login|register|change-password|upgrade-kdf` · `GET|PUT /api/notes` (size-capped: 2000 notes, 6 MiB total) · `GET|POST|DELETE /api/vault-meta` · `GET /api/me` · `POST /api/logout`. Static allowlist only: `app.js`, `styles.css`, `index.html`, vendored Argon2.

Hardening: HttpOnly `SameSite=Lax` sessions (24h absolute, 1h idle, 12h rotation, SHA-256 stored), DB-backed rate limits, constant-time compares + dummy PBKDF2 work against enumeration (CWE-203), strict allowlist validation, `escapeHtml()/sanitizeUrl()` rendering, frame-busting + `frame-ancestors 'self'`, `nosniff`, HSTS, no-store app shell.

## Frontend

Sidebar sections with nesting (all sections share the same implementation/value: folders, colors, Bin, drag-drop, filtering), note-list tree, Markdown editor with live preview + toolbar, Standard/Recipe/To-Do templates, `.md/.txt` import/export, Favorites / Archive / 3-day Bin, right-click menus, search + filters, offline fallback.

## Run

```bash
pip install -r requirements.txt
python server.py  # http://127.0.0.1:5000
```

Set `NOTELY_PASSWORD_ADMIN` / `NOTELY_PASSWORD_REIZU`, `NOTELY_DB_KEY`, `NOTELY_COOKIE_SECURE=1` + HTTPS reverse proxy in production.
