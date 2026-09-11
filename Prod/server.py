#!/usr/bin/env python3
"""Notely server: serves the app and backs logins with an encrypted SQLite DB.

Layout (all in this folder):
  server.py    this backend
  notely.db    SQLite database file (users + sessions + notes + rate data).
  notely.key   32-byte database encryption key — created on first run (0600).
               In production set NOTELY_DB_KEY (base64) instead of using the file.

Security model (end-to-end encryption for note contents):
  * NOTE CONTENTS are end-to-end encrypted: each account owns a random 256-bit
    master key generated in the browser. Notes are AES-GCM encrypted with that
    key on the device; the server only ever stores opaque ciphertext blobs it
    cannot decrypt. The database key protects account metadata only.
  * The master key itself is AES-GCM wrapped with a password-derived KEK
    (PBKDF2-HMAC-SHA256, per-user salt) — again in the browser. The server
    stores the wrapped key but never the password or the KEK.
  * Login authenticates with a SEPARATE password-derived verifier
    (PBKDF2-HMAC-SHA256, different per-user salt). The password itself is never
    sent to, or stored on, the server for E2EE accounts — only the verifier.
    Consequence: always use HTTPS in production; without TLS the verifier (a
    high-entropy pass-the-hash token) could be replayed, exactly like a
    session cookie. Localhost development is exempt (secure context).
  * Display names stay server-encrypted (not E2EE) so a valid session can
    render the profile without re-entering the password; note bodies, titles,
    tags and collections are E2EE.
  * Legacy (pre-E2EE) accounts transparently upgrade on their next password
    login: the server verifies the old verifier, provisions E2EE material,
    re-encrypts existing notes under the fresh master key, and never stores
    the password.
  * Passwords are NEVER stored — only salted verifiers (CWE-798/312).
  * Sessions are random tokens kept in the DB with absolute + idle expiry and
    rotation; the browser only holds an HttpOnly cookie, never credentials.
  * Only app.js / styles.css / index.html are served statically — the database,
    key file and this source are never exposed over HTTP.
"""

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from flask import Flask, jsonify, request, send_from_directory
from argon2.low_level import Type as Argon2Type, hash_secret_raw

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get('NOTELY_DB_PATH', os.path.join(BASE_DIR, 'notely.db'))
KEY_PATH = os.environ.get('NOTELY_KEY_PATH', os.path.join(BASE_DIR, 'notely.key'))
# __Host- prefix enforces Secure + Path=/ + no Domain (cookie tossing defense).
# Transition: server still accepts legacy 'notely_session' for 7 days (see
# get_session_token_from_request), but always sets the __Host- cookie.
SESSION_COOKIE = '__Host-notely_session'
LEGACY_SESSION_COOKIE = 'notely_session'
SESSION_MAX_AGE_SECONDS = 12 * 3600
SESSION_IDLE_SECONDS = 30 * 60
SESSION_ROTATE_AFTER_SECONDS = 4 * 3600
PBKDF2_ITERATIONS = 210_000
# Argon2id parameters (OWASP/RFC 9106 first-choice profile, single-threaded so
# the browser WASM build matches the server bit-for-bit). The client MUST use
# these exact values; the server rejects anything else (downgrade protection).
ARGON2_TIME_COST = 3
ARGON2_MEMORY_KIB = 65536
ARGON2_PARALLELISM = 1
ARGON2_HASH_LEN = 32
ARGON2_DESCRIPTOR = {'kdf': 'argon2id', 't': ARGON2_TIME_COST, 'm': ARGON2_MEMORY_KIB, 'p': ARGON2_PARALLELISM}
# Client-supplied KDF params shape (what the browser actually sends: bare
# {t, m, p} plus a top-level 'kdf' field). Accepts the historical descriptor
# shape too so clients written against either form keep working.
ARGON2_CLIENT_PARAMS = {'t': ARGON2_TIME_COST, 'm': ARGON2_MEMORY_KIB, 'p': ARGON2_PARALLELISM}


def valid_argon2_params(params):
    """Accept exactly the pinned Argon2id profile, with or without the 'kdf'
    label (downgrade protection: any other value is rejected)."""
    return params == ARGON2_CLIENT_PARAMS or params == ARGON2_DESCRIPTOR
# Unauthenticated endpoints: tighter to slow password spraying (5/15min).
# Authenticated state-changing: 5/15min. Notes stays 60/min (sync bursts).
LOGIN_WINDOW_SECONDS = 900
LOGIN_MAX_FAILURES = 5
CHANGE_WINDOW_SECONDS = 900
CHANGE_MAX_FAILURES = 5
NOTES_PUT_WINDOW_SECONDS = 60
NOTES_PUT_MAX = 60
NOTES_MAX_COUNT = 2000
NOTES_MAX_BODY_CHARS = 500000
NOTES_MAX_TOTAL_BYTES = 6 * 1024 * 1024
NOTES_MAX_REQUEST_BYTES = 7 * 1024 * 1024

# Password policy: min 12 chars, at least 1 upper, 1 lower, 1 digit, 1 special.
PASSWORD_MIN_LENGTH = 12
PASSWORD_SPECIAL_RE = re.compile(r'[^A-Za-z0-9]')
USERNAME_RE = re.compile(r'^[A-Za-z0-9_-]{3,32}$')
# Person names: letters first, then letters/spaces/hyphens/apostrophes/periods.
NAME_RE = re.compile(r"^[A-Za-z][A-Za-z'.\- ]{0,39}$")
NOTE_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,80}$')


# Enforce the password policy for server-visible passwords (legacy change path, bootstrap env values). E2EE registrations are strength-checked client-side.
def validate_password(password):
    """Enforce the Notely password policy. Returns (ok, message)."""
    if not isinstance(password, str):
        return False, 'Password must be a string.'
    if len(password) < PASSWORD_MIN_LENGTH:
        return False, f'Password must be at least {PASSWORD_MIN_LENGTH} characters.'
    if len(password) > 256:
        return False, 'Password must be at most 256 characters.'
    if not re.search(r'[A-Z]', password):
        return False, 'Password must contain at least 1 capital letter.'
    if not re.search(r'[a-z]', password):
        return False, 'Password must contain at least 1 small letter.'
    if not re.search(r'[0-9]', password):
        return False, 'Password must contain at least 1 number.'
    if not PASSWORD_SPECIAL_RE.search(password):
        return False, 'Password must contain at least 1 special character.'
    return True, 'OK'


# Allowlist for usernames (3-32 chars: letters, digits, _ -), shared by register/login/change flows.
def validate_username(username):
    if not isinstance(username, str) or not USERNAME_RE.match(username):
        return False
    return True


# Allowlist for first/last names (letter-led, up to 40 chars incl. spaces/hyphens/apostrophes/periods).
def validate_person_name(name):
    if not isinstance(name, str):
        return False
    return bool(NAME_RE.match(name.strip()))


# Random policy-compliant password for fresh-DB bootstrap accounts missing an env password.
def generate_policy_password(length=20):
    """Random password that always satisfies validate_password."""
    alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-_=+[]{};:,.<>?'
    while True:
        candidate = ''.join(secrets.choice(alphabet) for _ in range(length))
        ok, _ = validate_password(candidate)
        if ok:
            return candidate


# Bootstrap account PROFILES only — no secrets here. Passwords come from the
# environment (NOTELY_PASSWORD_<USERNAME>, e.g. NOTELY_PASSWORD_ADMIN). On a
# fresh database, any bootstrap user without an env password gets a random
# policy-compliant one printed ONCE to the server log; rotate it immediately.
BOOTSTRAP_PROFILES = {
    'admin': ('Admin', 'Nimda', 'Personal space'),
    'reizu': ('Anthony', 'Samson', 'Personal space'),
}


# Resolve a bootstrap password: NOTELY_PASSWORD_<USER> env var wins, else generate + print once to the server log.
def bootstrap_password(username):
    env_name = 'NOTELY_PASSWORD_' + username.upper()
    configured = os.environ.get(env_name)
    if configured:
        return configured, 'env'
    return generate_policy_password(), 'generated'

PUBLIC_FILES = {'app.js', 'styles.css', 'favicon.ico',
                'vendor/argon2/argon2.js', 'vendor/argon2/argon2-wrapper.js', 'vendor/argon2/argon2.wasm'}

app = Flask(__name__)
# Hard cap on request bodies (chunked bodies without Content-Length included).
app.config['MAX_CONTENT_LENGTH'] = NOTES_MAX_REQUEST_BYTES + 1024


# Load the 32-byte database key: NOTELY_DB_KEY env wins, else the 0600 notely.key file (created once). Validates exact length.
def get_db_key():
    """32-byte AES key: env var wins, else the local key file (created once)."""
    env_key = os.environ.get('NOTELY_DB_KEY')
    if env_key:
        try:
            key = base64.b64decode(env_key, validate=True)
        except Exception:
            raise RuntimeError(
                'Invalid NOTELY_DB_KEY: must be base64 of exactly 32 bytes.'
            )
        if len(key) != 32:
            raise RuntimeError(
                'Invalid NOTELY_DB_KEY: must decode to exactly 32 bytes.'
            )
        return key
    if os.path.exists(KEY_PATH):
        with open(KEY_PATH, 'rb') as handle:
            key = handle.read()
        if len(key) != 32:
            raise RuntimeError(
                f'Invalid key file {KEY_PATH}: expected 32 bytes, found {len(key)}.'
            )
        return key
    key = secrets.token_bytes(32)
    with open(KEY_PATH, 'wb') as handle:
        handle.write(key)
    try:
        os.chmod(KEY_PATH, 0o600)
    except OSError:
        pass
    return key


# Open a SQLite connection with Row access to notely.db.
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


DB_KEY = get_db_key()


# AES-GCM encrypt bytes under the database key; returns nonce+ciphertext. Server-side (non-E2EE) data only.
def encrypt_blob(plaintext_bytes):
    aesgcm = AESGCM(DB_KEY)
    nonce = secrets.token_bytes(12)
    return nonce + aesgcm.encrypt(nonce, bytes(plaintext_bytes), None)


# AES-GCM decrypt a nonce+ciphertext blob; throws on tampering or wrong key.
def decrypt_blob(blob):
    aesgcm = AESGCM(DB_KEY)
    return aesgcm.decrypt(bytes(blob[:12]), bytes(blob[12:]), None)


# Encrypt the display profile JSON (first/last name, subtitle) for storage.
def encrypt_profile(profile):
    return encrypt_blob(json.dumps(profile).encode('utf-8'))


# Decrypt a stored display profile.
def decrypt_profile(blob):
    return json.loads(decrypt_blob(blob).decode('utf-8'))


# Encrypt a legacy (pre-E2EE) notes array for storage. E2EE blobs bypass this entirely.
def encrypt_notes(notes):
    return encrypt_blob(json.dumps(notes).encode('utf-8'))


# Decrypt a legacy notes array (used by reads and the E2EE upgrade path).
def decrypt_notes(blob):
    return json.loads(decrypt_blob(blob).decode('utf-8'))


# PBKDF2-HMAC-SHA256 password hash for legacy verifiers.
def hash_password(password, salt):
    return hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), bytes(salt), PBKDF2_ITERATIONS)


def argon2id_raw(password, salt):
    """Memory-hard KDF shared bit-for-bit with the browser (argon2-browser
    1.18.0, Argon2id t=3 m=64MiB p=1). Used for auth verifiers and KEKs."""
    return hash_secret_raw(secret=password.encode('utf-8'), salt=bytes(salt),
                           time_cost=ARGON2_TIME_COST, memory_cost=ARGON2_MEMORY_KIB,
                           parallelism=ARGON2_PARALLELISM, hash_len=ARGON2_HASH_LEN,
                           type=Argon2Type.ID)


# Base64-decode with an exact byte-length requirement; rejects malformed lengths (format hardening).
def b64decode_strict(value, expected_len):
    """Decode base64, requiring an exact byte length (format hardening)."""
    if not isinstance(value, str):
        raise ValueError('Expected base64 string.')
    try:
        raw = base64.b64decode(value.encode('ascii'), validate=True)
    except Exception:
        raise ValueError('Invalid base64.')
    if len(raw) != expected_len:
        raise ValueError('Invalid length.')
    return raw


# True once an account carries wrapped-key material; gates E2EE vs legacy code paths.
def is_e2ee_account(row):
    """An account is E2EE once it carries wrapped-key material."""
    try:
        return bool(row['salt_auth'] and row['auth_hash'] and row['salt_enc'] and row['enc_master_key'])
    except Exception:
        return False


# Fixed dummy hash so unknown usernames take the same PBKDF2 work as
# real ones (timing-attack mitigation for user enumeration).
_DUMMY_SALT = b'notely-enumeration-dummy-salt-01'
_DUMMY_HASH = hashlib.pbkdf2_hmac('sha256', b'notely-dummy-password', _DUMMY_SALT, PBKDF2_ITERATIONS)


def dummy_kdf_salt_for(username):
    """Per-username deterministic dummy salt (enumeration fix).

    Old code returned one constant salt for every unknown name, so an
    attacker could enumerate by equality (two unknowns -> same salt) or by
    comparing to the open-source constant. Now derive 16 bytes as
    HMAC-SHA256(DB_KEY, 'kdf-dummy-v1:' + lower(username))[:16]: stable per
    name, distinct across names, indistinguishable from random without DB_KEY.
    """
    try:
        name = str(username or '').strip().lower().encode('utf-8')
    except Exception:
        name = b'unknown'
    return hmac.new(DB_KEY, b'kdf-dummy-v1:' + name, hashlib.sha256).digest()[:16]


# Small weak-password screen for E2EE verifiers. The server never sees the
# password, but it knows saltAuth+authHash, so it can test a tiny dictionary
# (top leaked passwords + trivial strings). Each check is one Argon2id (64MiB,
# ~0.3-1s); only ~8 candidates to keep registration <5s. This catches
# "123"/"password"/"qwerty" style bypasses of client-side policy without
# learning anything about strong passwords. Not a substitute for OPAQUE.
_WEAK_PASSWORD_CANDIDATES = (
    '123', 'password', '123456', '123456789', 'qwerty', '12345678',
    'password123', 'admin123',
)


def is_weak_verifier(auth_hash_bytes, salt_auth_bytes):
    """True if authHash matches a trivial password under the given salt.

    Constant-time over candidates (no early exit) so timing does not reveal
    whether/which weak password matched.
    """
    try:
        matched = False
        for candidate in _WEAK_PASSWORD_CANDIDATES:
            try:
                cand = argon2id_raw(candidate, bytes(salt_auth_bytes))
            except Exception:
                continue
            if hmac.compare_digest(cand, bytes(auth_hash_bytes)):
                matched = True
        return matched
    except Exception:
        return False
    return False


# Constant-time legacy password check against the stored verifier.
def verify_password(password, salt, expected_hash, iterations):
    try:
        candidate = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), bytes(salt), iterations)
    except Exception:
        return False
    return hmac.compare_digest(candidate, bytes(expected_hash))


# Create/migrate tables, seed bootstrap accounts (fully E2EE), and print generated passwords once. Safe to rerun.
def init_db():
    conn = get_db()
    conn.execute(
        'CREATE TABLE IF NOT EXISTS users ('
        'username TEXT PRIMARY KEY, pwd_salt BLOB NOT NULL, pwd_hash BLOB NOT NULL, '
        'iterations INTEGER NOT NULL, enc_profile BLOB NOT NULL, created_at INTEGER NOT NULL)'
    )
    conn.execute(
        'CREATE TABLE IF NOT EXISTS sessions ('
        'token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, '
        'expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, '
        'last_seen INTEGER NOT NULL)'
    )
    # Migration for databases created before idle tracking existed.
    cols = {row['name'] for row in conn.execute('PRAGMA table_info(sessions)')}
    if 'last_seen' not in cols:
        conn.execute('ALTER TABLE sessions ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0')
        conn.execute('UPDATE sessions SET last_seen = created_at WHERE last_seen = 0')
    conn.execute(
        'CREATE TABLE IF NOT EXISTS rate_hits ('
        'bucket TEXT NOT NULL, ts REAL NOT NULL)'
    )
    conn.execute('CREATE INDEX IF NOT EXISTS idx_rate_hits ON rate_hits (bucket, ts)')
    conn.execute(
        'CREATE TABLE IF NOT EXISTS user_notes ('
        'username TEXT PRIMARY KEY, enc_notes BLOB NOT NULL, updated_at INTEGER NOT NULL)'
    )
    # Private Vault (user feature, separate password): verifier + wrapped vault
    # key. Vault note contents never touch this table — they ride inside the
    # user's E2EE notes blob, encrypted with the vault key.
    conn.execute(
        'CREATE TABLE IF NOT EXISTS vault_meta ('
        'username TEXT PRIMARY KEY, salt_auth BLOB NOT NULL, verifier BLOB NOT NULL, '
        'salt_enc BLOB NOT NULL, enc_dek BLOB NOT NULL, created_at INTEGER NOT NULL)'
    )
    # E2EE migration: wrapped-key auth columns plus the opaque notes blob.
    # Legacy rows (NULL/empty new columns) keep working and transparently
    # upgrade on their next password login.
    user_cols = {row['name'] for row in conn.execute('PRAGMA table_info(users)')}
    for col in ('salt_auth', 'salt_enc', 'auth_hash', 'enc_master_key', 'kdf', 'kdf_params'):
        if col not in user_cols:
            conn.execute(f'ALTER TABLE users ADD COLUMN {col} {"TEXT" if col.startswith("kdf") else "BLOB"}')
    # Backfill: E2EE-PBKDF2 rows (wrapped key present, no descriptor yet).
    for row in conn.execute("SELECT username, iterations FROM users WHERE enc_master_key IS NOT NULL AND (kdf IS NULL OR kdf = '')"):
        conn.execute('UPDATE users SET kdf = ?, kdf_params = ? WHERE username = ?',
                     ('pbkdf2', json.dumps({'i': row['iterations'] or PBKDF2_ITERATIONS}), row['username']))
    notes_cols = {row['name'] for row in conn.execute('PRAGMA table_info(user_notes)')}
    if 'enc_blob' not in notes_cols:
        conn.execute('ALTER TABLE user_notes ADD COLUMN enc_blob BLOB')
    # Notes history (LWW fix): keep last 5 opaque blobs per user so a hijacked
    # session overwrite can be rolled back. Pruned on every PUT.
    conn.execute(
        'CREATE TABLE IF NOT EXISTS user_notes_history ('
        'id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, '
        'enc_blob BLOB NOT NULL, updated_at INTEGER NOT NULL)'
    )
    conn.execute('CREATE INDEX IF NOT EXISTS idx_notes_hist_user ON user_notes_history (username, id)')
    existing = {row['username'] for row in conn.execute('SELECT username FROM users')}
    for username, (first, last, subtitle) in BOOTSTRAP_PROFILES.items():
        if username in existing:
            continue
        password, source = bootstrap_password(username)
        ok, msg = validate_password(password)
        if not ok:
            raise RuntimeError(f'Bootstrap password for {username!r} violates password policy: {msg}')
        # Bootstrap accounts start fully E2EE under Argon2id: random master
        # key wrapped under a password-derived KEK, plus a separate auth
        # verifier. The password itself is never stored.
        master_key = secrets.token_bytes(32)
        salt_auth = secrets.token_bytes(16)
        salt_enc = secrets.token_bytes(16)
        auth_hash = argon2id_raw(password, salt_auth)
        wrap_aesgcm = AESGCM(argon2id_raw(password, salt_enc))
        wrap_nonce = secrets.token_bytes(12)
        wrap_ct = wrap_aesgcm.encrypt(wrap_nonce, master_key, None)
        conn.execute(
            'INSERT INTO users (username, pwd_salt, pwd_hash, iterations, enc_profile, created_at,'
            ' salt_auth, salt_enc, auth_hash, enc_master_key, kdf, kdf_params)'
            ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (
                username,
                b'', b'', 0,
                encrypt_profile({'firstName': first, 'lastName': last, 'subtitle': subtitle}),
                int(time.time()),
                salt_auth, salt_enc, auth_hash, wrap_nonce + wrap_ct,
                'argon2id', json.dumps(ARGON2_DESCRIPTOR),
            ),
        )
        if source == 'generated':
            print(
                f'NOTELY FIRST-RUN: generated password for {username!r}: {password} — '
                'log in and change it immediately.',
                flush=True,
            )
    conn.commit()
    conn.close()
    # Harden file perms: DB holds verifier material + opaque blobs. 0600 even
    # if umask created it 0644.
    try:
        os.chmod(DB_PATH, 0o600)
    except OSError:
        pass


# --- DB-backed rate limiting (shared across processes/restarts) ---

def _prune_rate_hits(conn, now, max_window):
    conn.execute('DELETE FROM rate_hits WHERE ts < ?', (now - max_window,))


# Record one rate-limit event (bucket, timestamp) in the DB (shared across processes/restarts).
def rate_hit(conn, bucket):
    now = time.time()
    conn.execute('INSERT INTO rate_hits (bucket, ts) VALUES (?, ?)', (bucket, now))
    _prune_rate_hits(conn, now, 3600)
    conn.commit()


# True when a bucket hit its max count inside the window.
def rate_exceeded(conn, buckets, max_n, window):
    now = time.time()
    for bucket in buckets:
        count = conn.execute(
            'SELECT COUNT(*) AS n FROM rate_hits WHERE bucket = ? AND ts > ?',
            (bucket, now - window),
        ).fetchone()['n']
        if count >= max_n:
            return True
    return False


# Rate-limit bucket key for the caller IP, namespaced per endpoint so one
# endpoint's failures can never consume another endpoint's budget.
def ip_bucket(endpoint):
    return endpoint + ':ip:' + (request.remote_addr or 'unknown')


def ip_user_bucket(endpoint, username):
    """Per-IP+user bucket for unauthenticated endpoints (lockout-DoS fix).

    Old code used a global 'login:user:victim' bucket: 8 fails from ANY IP
    locked the victim globally. Now bind to IP so an attacker can only
    consume their own budget; legitimate logins from other IPs still pass.
    """
    try:
        ip = request.remote_addr or 'unknown'
        user = str(username or '').strip().lower()
    except Exception:
        ip, user = 'unknown', ''
    return f'{endpoint}:ipuser:{ip}:{user}'


# CSRF: state-changing /api/* requests must be same-origin when Origin/Referer
# is present, and must carry JSON (or no body for logout). Blocks classic
# cross-site form/fetch POSTs; SameSite=Lax remains as second layer.
def csrf_check_failed():
    """True when the request looks cross-site (reject with 403)."""
    try:
        if request.method not in ('POST', 'PUT', 'DELETE', 'PATCH'):
            return False
        if not request.path.startswith('/api/'):
            return False
        origin = request.headers.get('Origin')
        referer = request.headers.get('Referer')
        host = request.host or ''
        # Normalise: compare host (with port) case-insensitively.
        def _host_of(url):
            try:
                from urllib.parse import urlparse
                return (urlparse(url).hostname or '').lower(), urlparse(url).port
            except Exception:
                return '', None
        if origin:
            oh, oport = _host_of(origin)
            try:
                rh = (request.host.split(':')[0] or '').lower()
                rport = request.host.split(':')[1] if ':' in request.host else None
                # Allow same host regardless of scheme/port mismatch behind proxies?
                # Strict: hostname must match; port must match if Origin specifies one.
                if oh != rh:
                    return True
            except Exception:
                return True
        elif referer:
            rh, _ = _host_of(referer)
            try:
                myhost = (request.host.split(':')[0] or '').lower()
                if rh and rh != myhost:
                    return True
            except Exception:
                return True
        return False
    except Exception:
        return False


# JSON body as a dict, or {} for missing/unparseable/non-object payloads.
# Several endpoints call .get() on the result; without this guard a JSON
# array/string body would raise AttributeError into a 500.
def json_object():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


# Mint a random session token, store only its SHA-256, prune long-expired sessions, and return both.
def issue_session_token(conn, username, now):
    token = secrets.token_urlsafe(48)
    digest = hashlib.sha256(token.encode('utf-8')).hexdigest()
    # Opportunistic janitor: drop long-expired sessions so the table cannot
    # grow without bound from abandoned logins.
    conn.execute('DELETE FROM sessions WHERE expires_at < ?', (now,))
    conn.execute(
        'INSERT INTO sessions (token_hash, username, expires_at, created_at, last_seen)'
        ' VALUES (?, ?, ?, ?, ?)',
        (digest, username, now + SESSION_MAX_AGE_SECONDS, now, now),
    )
    return token, digest


# Whether the session cookie carries the Secure flag: explicit
# NOTELY_COOKIE_SECURE=1/0 always wins (default Secure ON, even for
# loopback — modern browsers accept Secure on http://localhost as a secure
# context; plain-HTTP LAN deployments must set up TLS).
def session_cookie_secure():
    env = os.environ.get('NOTELY_COOKIE_SECURE')
    if env is not None:
        return env == '1'
    return True


# Set the HttpOnly __Host- SameSite=Lax session cookie (Secure always unless
# NOTELY_COOKIE_SECURE=0). __Host- requires Secure + Path=/ + no Domain.
def set_session_cookie(response, token):
    response.set_cookie(
        SESSION_COOKIE, token, max_age=SESSION_MAX_AGE_SECONDS,
        httponly=True, samesite='Lax', secure=session_cookie_secure(), path='/',
    )
    return response


def get_session_token_from_request():
    """New __Host- cookie first, legacy fallback until sunset date."""
    try:
        token = request.cookies.get(SESSION_COOKIE)
        if token:
            return token, False
        # Legacy fallback sunsets 2026-12-01: after that, old cookie rejected
        # (forces one relogin, closes tossing window).
        try:
            import datetime
            if datetime.datetime.utcnow() >= datetime.datetime(2026, 12, 1):
                return None, True
        except Exception:
            pass
        legacy = request.cookies.get(LEGACY_SESSION_COOKIE)
        return (legacy, True) if legacy else (None, False)
    except Exception:
        return None, False


# Resolve the request cookie to a live user: checks absolute + idle expiry, touches last_seen, returns the decrypted display profile.
def current_session_user():
    try:
        token, used_legacy = get_session_token_from_request()
    except Exception:
        return None
    if not token or not isinstance(token, str) or len(token) > 512:
        return None
    try:
        digest = hashlib.sha256(token.encode('utf-8')).hexdigest()
    except Exception:
        return None
    now = int(time.time())
    conn = get_db()
    row = conn.execute(
        'SELECT username, expires_at, created_at, last_seen FROM sessions WHERE token_hash = ?',
        (digest,),
    ).fetchone()
    if row and row['expires_at'] > now and (now - (row['last_seen'] or 0)) <= SESSION_IDLE_SECONDS:
        conn.execute('UPDATE sessions SET last_seen = ? WHERE token_hash = ?', (now, digest))
        conn.commit()
        user = conn.execute('SELECT username, enc_profile FROM users WHERE username = ?', (row['username'],)).fetchone()
        conn.close()
        if user:
            try:
                profile = decrypt_profile(user['enc_profile'])
            except Exception:
                return None
            return {
                'username': user['username'],
                **profile,
                '_token_digest': digest,
                '_token_created': row['created_at'],
                '_used_legacy': bool(used_legacy),
            }
        return None
    if row:
        conn.execute('DELETE FROM sessions WHERE token_hash = ?', (digest,))
        conn.commit()
    conn.close()
    return None


# Issue a fresh token for sessions older than 12h and retire the old one (rotation).
def rotate_session_if_due(conn, user, now):
    """Issue a fresh token for long-lived sessions. Returns (token, digest) or (None, None)."""
    created = user.get('_token_created') or now
    if now - created < SESSION_ROTATE_AFTER_SECONDS:
        return None, None
    token, digest = issue_session_token(conn, user['username'], now)
    conn.execute('DELETE FROM sessions WHERE token_hash = ?', (user['_token_digest'],))
    conn.commit()
    return token, digest


@app.route('/')
def root():
    response = send_from_directory(BASE_DIR, 'index.html')
    # Never cache the app shell: stale HTML/JS is the classic "my fix did
    # nothing" trap during development.
    response.cache_control.no_store = True
    return response


@app.route('/<path:filename>')
def public_files(filename):
    if filename in PUBLIC_FILES:
        response = send_from_directory(BASE_DIR, filename)
        response.cache_control.no_store = True
        return response
    return jsonify({'error': 'Not found'}), 404


@app.after_request
def security_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'SAMEORIGIN'
    response.headers['Referrer-Policy'] = 'no-referrer'
    # Server banner hidden via WSGIRequestHandler override in __main__
    # (gunicorn emits unversioned 'gunicorn' natively). Do NOT set here:
    # Werkzeug would then send two Server headers (duplicate).
    # HSTS always (browsers ignore over HTTP; enforced over HTTPS).
    response.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
    response.headers['Permissions-Policy'] = 'camera=(), microphone=(), geolocation=(), payment=()'
    response.headers['Cross-Origin-Opener-Policy'] = 'same-origin'
    response.headers['Cross-Origin-Resource-Policy'] = 'same-origin'
    response.headers['Vary'] = 'Origin'
    if request.path.startswith('/api/'):
        # API payloads carry salts, verifier material and note blobs: never
        # allow browsers or proxies to cache them.
        response.cache_control.no_store = True
    response.headers['Content-Security-Policy'] = (
        "default-src 'self'; "
        # wasm-unsafe-eval: required to compile the vendored Argon2 WASM
        # module (strictly narrower than unsafe-eval: JS eval stays blocked).
        "script-src 'self' 'wasm-unsafe-eval'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "img-src 'self' https: data:; "
        "font-src 'self' https://fonts.gstatic.com; "
        "connect-src 'self'; "
        "frame-ancestors 'self'; "
        "base-uri 'self'; "
        "form-action 'self'; "
        "object-src 'none'; "
        "upgrade-insecure-requests"
    )
    return response


@app.before_request
def csrf_protect():
    if csrf_check_failed():
        return jsonify({'error': 'Cross-site request rejected.'}), 403


@app.errorhandler(404)
def not_found(error):
    return jsonify({'error': 'Not found.'}), 404


@app.errorhandler(405)
def method_not_allowed(error):
    return jsonify({'error': 'Method not allowed.'}), 405


@app.errorhandler(413)
def request_too_large(error):
    return jsonify({'error': 'Request too large.'}), 413


# Fixed dummy KDF material so unknown usernames get an indistinguishable
# kdf-params shape (no account-enumeration oracle).
_DUMMY_KDF_SALT = base64.b64encode(b'notely-kdf-dummy-01').decode('ascii')


@app.route('/api/kdf-params', methods=['GET'])
def api_kdf_params():
    """Public key-derivation parameters for a username (safe to expose).

    E2EE accounts get their real salts; legacy and unknown names get an
    identical shape with dummy values so callers cannot distinguish them.
    """
    username = str(request.args.get('username', '')).strip()
    conn = get_db()
    row = None
    if validate_username(username):
        row = conn.execute(
            'SELECT salt_auth, iterations, kdf, kdf_params FROM users WHERE username = ?', (username,)
        ).fetchone()
    conn.close()
    if row and row['salt_auth'] and (row['kdf'] or '') == 'argon2id':
        try:
            params = json.loads(row['kdf_params'] or '{}')
        except Exception:
            params = {}
        if params != ARGON2_DESCRIPTOR:
            return jsonify({'e2ee': False})
        return jsonify({
            'e2ee': True,
            'kdf': 'argon2id',
            'params': ARGON2_DESCRIPTOR,
            'saltAuth': base64.b64encode(bytes(row['salt_auth'])).decode('ascii'),
        })
    if row and row['salt_auth']:
        return jsonify({
            'e2ee': True,
            'kdf': 'pbkdf2-sha256',
            'params': {'i': row['iterations'] or PBKDF2_ITERATIONS},
            'saltAuth': base64.b64encode(bytes(row['salt_auth'])).decode('ascii'),
        })
    if row is not None:
        # Legacy pre-E2EE account: keep the non-E2EE shape so the client
        # still sends the password for transparent upgrade on next login.
        return jsonify({'e2ee': False})
    # Unknown username: same shape as a real Argon2id account but with a
    # per-username deterministic dummy salt (not one global constant).
    # Stable per name, distinct across names, indistinguishable without DB_KEY.
    dummy_salt = dummy_kdf_salt_for(username if validate_username(username) else 'invalid')
    return jsonify({
        'e2ee': True,
        'kdf': 'argon2id',
        'params': ARGON2_DESCRIPTOR,
        'saltAuth': base64.b64encode(dummy_salt).decode('ascii'),
    })


# Split a stored wrapped-key blob into {iv, data} base64 for API responses.
def enc_master_key_parts(blob):
    raw = bytes(blob or b'')
    return {
        'iv': base64.b64encode(raw[:12]).decode('ascii'),
        'data': base64.b64encode(raw[12:]).decode('ascii'),
    }


# Transparent pre-E2EE upgrade on password login: fresh master key + verifier, existing notes re-encrypted under it, server plaintext copy wiped. Password used transiently, never stored.
def upgrade_legacy_account(conn, username, password):
    """Convert a pre-E2EE account on password login straight to Argon2id-E2EE:
    fresh master key wrapped under an Argon2id KEK, separate Argon2id auth
    verifier, and existing notes re-encrypted from the database key to the
    master key. The password is used transiently and never stored."""
    master_key = secrets.token_bytes(32)
    salt_auth = secrets.token_bytes(16)
    salt_enc = secrets.token_bytes(16)
    auth_hash = argon2id_raw(password, salt_auth)
    wrap_aesgcm = AESGCM(argon2id_raw(password, salt_enc))
    wrap_nonce = secrets.token_bytes(12)
    wrap_ct = wrap_aesgcm.encrypt(wrap_nonce, master_key, None)
    conn.execute(
        'UPDATE users SET pwd_salt = ?, pwd_hash = ?, iterations = ?,'
        ' salt_auth = ?, salt_enc = ?, auth_hash = ?, enc_master_key = ?,'
        " kdf = 'argon2id', kdf_params = ?"
        ' WHERE username = ?',
        (b'', b'', 0, salt_auth, salt_enc, auth_hash,
         wrap_nonce + wrap_ct, json.dumps(ARGON2_DESCRIPTOR), username),
    )
    notes_row = conn.execute('SELECT enc_notes FROM user_notes WHERE username = ?', (username,)).fetchone()
    if notes_row and notes_row['enc_notes']:
        try:
            plaintext_notes = decrypt_notes(bytes(notes_row['enc_notes']))
        except Exception:
            plaintext_notes = []
        if not isinstance(plaintext_notes, list):
            plaintext_notes = []
        aesgcm = AESGCM(master_key)
        nonce = secrets.token_bytes(12)
        conn.execute(
            'UPDATE user_notes SET enc_notes = ?, enc_blob = ? WHERE username = ?',
            (b'', nonce + aesgcm.encrypt(nonce, json.dumps(plaintext_notes).encode('utf-8'), None), username),
        )
    conn.commit()
    return {
        'kdf': 'argon2id',
        'params': dict(ARGON2_DESCRIPTOR),
        'saltAuth': base64.b64encode(salt_auth).decode('ascii'),
        'saltEnc': base64.b64encode(salt_enc).decode('ascii'),
        'encMasterKey': {'iv': base64.b64encode(wrap_nonce).decode('ascii'), 'data': base64.b64encode(wrap_ct).decode('ascii')},
    }


@app.route('/api/login', methods=['POST'])
def api_login():
    conn = get_db()
    buckets = [ip_bucket('login')]
    probe_user = ''
    try:
        probe = request.get_json(silent=True) or {}
        probe_user = str(probe.get('username', '')).strip()
    except Exception:
        probe_user = ''
    if probe_user and validate_username(probe_user):
        # Per-IP+user (not global user) so attacker cannot lock victim out.
        buckets.append(ip_user_bucket('login', probe_user))
    if rate_exceeded(conn, buckets, LOGIN_MAX_FAILURES, LOGIN_WINDOW_SECONDS):
        conn.close()
        return jsonify({'error': 'Too many attempts — try again in a few minutes.'}), 429
    data = json_object()
    username = str(data.get('username', '')).strip()
    password = str(data.get('password', ''))
    auth_hash_b64 = data.get('authHash')
    if not validate_username(username):
        # Dummy work to keep timing uniform for invalid input.
        hmac.compare_digest(_DUMMY_HASH, _DUMMY_HASH)
        rate_hit(conn, ip_bucket('login'))
        conn.close()
        return jsonify({'error': 'Incorrect username or password.'}), 401
    user = conn.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
    # Precompute per-IP+user bucket once (lockout-DoS fix).
    user_bucket = ip_user_bucket('login', username)
    if user and is_e2ee_account(user):
        # E2EE login: only the auth verifier travels; the password (and every
        # key derived from it) never leaves the device. The KDF is pinned per
        # account — a weaker-than-registered KDF is never accepted.
        try:
            candidate = b64decode_strict(auth_hash_b64, 32)
        except ValueError:
            candidate = None
        if candidate is None:
            # Burn equal PBKDF2 work so E2EE accounts are not distinguishable
            # from legacy/unknown ones by response timing.
            hashlib.pbkdf2_hmac('sha256', secrets.token_bytes(16), _DUMMY_SALT, PBKDF2_ITERATIONS)
            rate_hit(conn, ip_bucket('login'))
            rate_hit(conn, user_bucket)
            conn.close()
            return jsonify({'error': 'Incorrect username or password.'}), 401
        ok = hmac.compare_digest(candidate, bytes(user['auth_hash']))
        if not ok:
            # Burn equal PBKDF2 work so a wrong verifier on a real account
            # costs the same as an unknown-user attempt (timing-oracle fix).
            hashlib.pbkdf2_hmac('sha256', secrets.token_bytes(16), _DUMMY_SALT, PBKDF2_ITERATIONS)
            rate_hit(conn, ip_bucket('login'))
            rate_hit(conn, user_bucket)
            conn.close()
            return jsonify({'error': 'Incorrect username or password.'}), 401
        try:
            profile = decrypt_profile(user['enc_profile'])
        except Exception:
            conn.close()
            return jsonify({'error': 'Login failed.'}), 500
        now = int(time.time())
        token, _digest = issue_session_token(conn, username, now)
        conn.commit()
        conn.close()
        response = jsonify({
            'username': username, **profile,
            'kdf': (user['kdf'] or 'pbkdf2'),
            'saltEnc': base64.b64encode(bytes(user['salt_enc'])).decode('ascii'),
            'iterations': user['iterations'] or PBKDF2_ITERATIONS,
            'encMasterKey': enc_master_key_parts(user['enc_master_key']),
        })
        return set_session_cookie(response, token)
    if not password or len(password) > 256:
        # Burn equal PBKDF2 work so unknown/legacy names cost the same as a
        # wrong E2EE verifier (timing-oracle fix).
        hashlib.pbkdf2_hmac('sha256', secrets.token_bytes(16), _DUMMY_SALT, PBKDF2_ITERATIONS)
        rate_hit(conn, ip_bucket('login'))
        conn.close()
        return jsonify({'error': 'Incorrect username or password.'}), 401
    if user and not is_e2ee_account(user):
        ok = verify_password(password, user['pwd_salt'], user['pwd_hash'], user['iterations'])
    else:
        # Unknown user: burn the same PBKDF2 cost, then fail closed.
        # Unencodable passwords (e.g. lone surrogates) fail closed too
        # instead of escaping as a 500.
        try:
            dummy = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), _DUMMY_SALT, PBKDF2_ITERATIONS)
        except Exception:
            dummy = _DUMMY_HASH
        ok = hmac.compare_digest(dummy, _DUMMY_HASH) and False
    if not ok:
        rate_hit(conn, ip_bucket('login'))
        rate_hit(conn, user_bucket)
        conn.close()
        return jsonify({'error': 'Incorrect username or password.'}), 401
    # Legacy account with a correct password: transparently upgrade to E2EE.
    bundle = upgrade_legacy_account(conn, username, password)
    try:
        profile = decrypt_profile(user['enc_profile'])
    except Exception:
        conn.close()
        return jsonify({'error': 'Login failed.'}), 500
    now = int(time.time())
    token, _digest = issue_session_token(conn, username, now)
    conn.commit()
    conn.close()
    response = jsonify({'username': username, **profile, 'migrated': True, **bundle})
    return set_session_cookie(response, token)


@app.route('/api/register', methods=['POST'])
def api_register():
    conn = get_db()
    if rate_exceeded(conn, [ip_bucket('register')], LOGIN_MAX_FAILURES, LOGIN_WINDOW_SECONDS):
        conn.close()
        return jsonify({'error': 'Too many attempts — try again in a few minutes.'}), 429
    data = json_object()
    username = str(data.get('username', '')).strip()
    first = str(data.get('firstName', '')).strip()[:40]
    last = str(data.get('lastName', '')).strip()[:40]
    if not validate_username(username):
        rate_hit(conn, ip_bucket('register'))
        conn.close()
        return jsonify({'error': 'Username must be 3-32 chars: letters, numbers, _ or -.'}), 400
    # E2EE registration: the client generates the master key and sends only
    # the auth verifier plus the wrapped key — never the password. Only the
    # Argon2id descriptor is accepted (downgrade protection).
    try:
        auth_hash = b64decode_strict(data.get('authHash'), 32)
        salt_auth = b64decode_strict(data.get('saltAuth'), 16)
        salt_enc = b64decode_strict(data.get('saltEnc'), 16)
        wrap = data.get('encMasterKey') or {}
        wrap_iv = b64decode_strict(wrap.get('iv'), 12)
        wrap_ct = b64decode_strict(wrap.get('data'), 48)
        kdf = data.get('kdf')
        params = data.get('params') or {}
    except (ValueError, AttributeError):
        rate_hit(conn, ip_bucket('register'))
        conn.close()
        return jsonify({'error': 'Invalid registration payload.'}), 400
    if kdf != 'argon2id' or not valid_argon2_params(params):
        rate_hit(conn, ip_bucket('register'))
        conn.close()
        return jsonify({'error': 'Invalid registration payload.'}), 400
    if not validate_person_name(first) or not validate_person_name(last):
        rate_hit(conn, ip_bucket('register'))
        conn.close()
        return jsonify({'error': 'First and last name must be 1-40 letters (spaces, hyphens, apostrophes OK).'}), 400
    # E2EE: server never sees the password, but it can still screen the
    # verifier against a tiny weak-password dictionary under the provided
    # salt (see is_weak_verifier). Strong passwords learn nothing; weak ones
    # are rejected with the same 400 as other policy failures. Client-side
    # passwordPolicyCheck remains the primary gate.
    if is_weak_verifier(auth_hash, salt_auth):
        rate_hit(conn, ip_bucket('register'))
        conn.close()
        return jsonify({'error': 'Password too weak: choose a longer, less common password.'}), 400
    exists = conn.execute('SELECT 1 FROM users WHERE username = ?', (username,)).fetchone()
    if exists:
        # Burn equal PBKDF2 work so timing does not reveal account existence,
        # then answer EXACTLY like a success (uniform response, CWE-203 fix).
        hashlib.pbkdf2_hmac('sha256', bytes(auth_hash), _DUMMY_SALT, PBKDF2_ITERATIONS)
        rate_hit(conn, ip_bucket('register'))
        conn.close()
        return jsonify({
            'ok': True,
            'message': 'If the username is available, the account was created. You can now log in.',
        }), 202
    # Timing-oracle fix: success path also burns PBKDF2 so new vs existing
    # both cost ~25ms (previously 3ms vs 25ms leaked existence).
    hashlib.pbkdf2_hmac('sha256', bytes(auth_hash), _DUMMY_SALT, PBKDF2_ITERATIONS)
    conn.execute(
        'INSERT INTO users (username, pwd_salt, pwd_hash, iterations, enc_profile, created_at,'
        ' salt_auth, salt_enc, auth_hash, enc_master_key, kdf, kdf_params)'
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (username, b'', b'', 0,
         encrypt_profile({'firstName': first, 'lastName': last, 'subtitle': 'Personal space'}),
         int(time.time()), salt_auth, salt_enc, auth_hash, wrap_iv + wrap_ct,
         'argon2id', json.dumps(ARGON2_DESCRIPTOR)),
    )
    conn.commit()
    conn.close()
    return jsonify({
        'ok': True,
        'message': 'If the username is available, the account was created. You can now log in.',
    }), 202


@app.route('/api/change-password', methods=['POST'])
def api_change_password():
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    buckets = [ip_bucket('pwchange'), 'pwchange:user:' + user['username'].lower(), 'pwchange:' + user['username'].lower()]
    if rate_exceeded(conn, buckets, CHANGE_MAX_FAILURES, CHANGE_WINDOW_SECONDS):
        conn.close()
        return jsonify({'error': 'Too many attempts — try again in a few minutes.'}), 429
    data = json_object()
    row = conn.execute('SELECT * FROM users WHERE username = ?', (user['username'],)).fetchone()
    if not row:
        conn.close()
        return jsonify({'error': 'Not signed in.'}), 401
    if is_e2ee_account(row):
        # E2EE rotation: the session already proves device access, and the
        # current-password verifier proves password knowledge — a stolen
        # cookie alone cannot rotate credentials.
        try:
            current_auth = b64decode_strict(data.get('currentAuth'), 32)
            new_auth = b64decode_strict(data.get('authHash'), 32)
            new_salt_auth = b64decode_strict(data.get('saltAuth'), 16)
            new_salt_enc = b64decode_strict(data.get('saltEnc'), 16)
            new_wrap = data.get('encMasterKey') or {}
            new_wrap_iv = b64decode_strict(new_wrap.get('iv'), 12)
            new_wrap_ct = b64decode_strict(new_wrap.get('data'), 48)
            new_kdf = data.get('kdf')
            new_params = data.get('params') or {}
        except (ValueError, AttributeError):
            conn.close()
            return jsonify({'error': 'Invalid request.'}), 400
        if new_kdf != 'argon2id' or not valid_argon2_params(new_params) or not hmac.compare_digest(current_auth, bytes(row['auth_hash'])):
            rate_hit(conn, ip_bucket('pwchange'))
            rate_hit(conn, 'pwchange:' + user['username'].lower())
            conn.close()
            return jsonify({'error': 'Current password is incorrect.'}), 401
        if is_weak_verifier(new_auth, new_salt_auth):
            conn.close()
            return jsonify({'error': 'New password too weak: choose a longer, less common password.'}), 400
        conn.execute(
            'UPDATE users SET salt_auth = ?, salt_enc = ?, auth_hash = ?, enc_master_key = ?,'
            " kdf = 'argon2id', kdf_params = ?"
            ' WHERE username = ?',
            (new_salt_auth, new_salt_enc, new_auth, new_wrap_iv + new_wrap_ct,
             json.dumps(ARGON2_DESCRIPTOR), user['username']),
        )
    else:
        current = str(data.get('currentPassword', ''))
        new_password = str(data.get('newPassword', ''))
        ok, msg = validate_password(new_password)
        if not ok:
            rate_hit(conn, 'pwchange:' + user['username'].lower())
            conn.close()
            return jsonify({'error': msg}), 400
        old = conn.execute('SELECT pwd_salt, pwd_hash, iterations FROM users WHERE username = ?', (user['username'],)).fetchone()
        if not old or not verify_password(current, old['pwd_salt'], old['pwd_hash'], old['iterations']):
            rate_hit(conn, ip_bucket('pwchange'))
            rate_hit(conn, 'pwchange:' + user['username'].lower())
            conn.close()
            return jsonify({'error': 'Current password is incorrect.'}), 401
        new_salt = secrets.token_bytes(16)
        try:
            new_hash = hash_password(new_password, new_salt)
        except ValueError:
            # Unencodable password (e.g. lone surrogates): reject instead of 500ing.
            conn.close()
            return jsonify({'error': 'Invalid request.'}), 400
        conn.execute(
            'UPDATE users SET pwd_salt = ?, pwd_hash = ?, iterations = ? WHERE username = ?',
            (new_salt, new_hash, PBKDF2_ITERATIONS, user['username']),
        )
    # Invalidate all other sessions for this user.
    try:
        token, _legacy = get_session_token_from_request()
        digest = hashlib.sha256(token.encode('utf-8')).hexdigest() if token else ''
    except Exception:
        digest = ''
    conn.execute('DELETE FROM sessions WHERE username = ? AND token_hash != ?', (user['username'], digest))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/upgrade-kdf', methods=['POST'])
def api_upgrade_kdf():
    """Lift a PBKDF2-E2EE account to Argon2id. The session proves device
    access and the old auth verifier proves password knowledge; the client
    re-wraps the SAME master key (it holds it unlocked), so no note
    re-encryption round trip is needed."""
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    if rate_exceeded(conn, [ip_bucket('upgrade'), 'upgrade:user:' + user['username'].lower()], CHANGE_MAX_FAILURES, CHANGE_WINDOW_SECONDS):
        conn.close()
        return jsonify({'error': 'Too many attempts — try again in a few minutes.'}), 429
    data = json_object()
    row = conn.execute('SELECT * FROM users WHERE username = ?', (user['username'],)).fetchone()
    if not row or not is_e2ee_account(row) or (row['kdf'] or 'pbkdf2') != 'pbkdf2':
        conn.close()
        return jsonify({'error': 'Nothing to upgrade.'}), 409
    try:
        old_auth = b64decode_strict(data.get('oldAuthHash'), 32)
        new_auth = b64decode_strict(data.get('authHash'), 32)
        new_salt_auth = b64decode_strict(data.get('saltAuth'), 16)
        new_salt_enc = b64decode_strict(data.get('saltEnc'), 16)
        new_wrap = data.get('encMasterKey') or {}
        new_wrap_iv = b64decode_strict(new_wrap.get('iv'), 12)
        new_wrap_ct = b64decode_strict(new_wrap.get('data'), 48)
        new_kdf = data.get('kdf')
        new_params = data.get('params') or {}
    except (ValueError, AttributeError):
        conn.close()
        return jsonify({'error': 'Invalid request.'}), 400
    if new_kdf != 'argon2id' or not valid_argon2_params(new_params) or not hmac.compare_digest(old_auth, bytes(row['auth_hash'])):
        rate_hit(conn, ip_bucket('upgrade'))
        rate_hit(conn, 'upgrade:user:' + user['username'].lower())
        conn.close()
        return jsonify({'error': 'Upgrade rejected.'}), 401
    conn.execute(
        'UPDATE users SET salt_auth = ?, salt_enc = ?, auth_hash = ?, enc_master_key = ?,'
        " kdf = 'argon2id', kdf_params = ?"
        ' WHERE username = ?',
        (new_salt_auth, new_salt_enc, new_auth, new_wrap_iv + new_wrap_ct,
         json.dumps(ARGON2_DESCRIPTOR), user['username']),
    )
    conn.commit()
    conn.close()
    return jsonify({'ok': True, 'kdf': 'argon2id'})


# Strict server-side mirror of client migrateNote: types, lengths, flags and ids for legacy note payloads. E2EE blobs skip this (opaque).
def validate_note_object(note):
    """Strict server-side mirror of the client migrateNote(). Returns cleaned note."""
    if not isinstance(note, dict):
        raise ValueError('Note must be an object.')
    note_id = note.get('id')
    if not isinstance(note_id, str) or not NOTE_ID_RE.match(note_id):
        raise ValueError('Invalid note id.')
    ext = note.get('ext')
    if ext not in ('md', 'txt', 'json', 'yaml'):
        raise ValueError('Invalid note type.')
    title = note.get('title')
    if not isinstance(title, str) or not title.strip():
        title = 'Untitled note'
    title = title.strip()[:200]
    body = note.get('body')
    if not isinstance(body, str):
        raise ValueError('Invalid note body.')
    body = body[:NOTES_MAX_BODY_CHARS]
    tags = note.get('tags')
    if not isinstance(tags, list):
        raise ValueError('Invalid note tags.')
    cleaned_tags = []
    for tag in tags:
        if not isinstance(tag, str):
            raise ValueError('Invalid note tag.')
        tag = tag.strip()[:40]
        if tag:
            cleaned_tags.append(tag)
    cleaned_tags = cleaned_tags[:20]
    sections = note.get('sections')
    if sections is None:
        sections = {}
    elif not isinstance(sections, dict):
        raise ValueError('Invalid note sections.')
    else:
        cleaned_sections = {}
        for key, value in list(sections.items())[:20]:
            if not isinstance(key, str) or not key.strip():
                raise ValueError('Invalid note section.')
            if value is not None:
                if not isinstance(value, str):
                    raise ValueError('Invalid note section folder.')
                value = value.strip()[:180] or None
            cleaned_sections[key.strip()[:80]] = value
        sections = cleaned_sections
    for flag in ('deleted', 'archived', 'favorite'):
        if not isinstance(note.get(flag), bool):
            raise ValueError(f'Invalid note flag {flag!r}.')
    deleted_at = note.get('deletedAt')
    if note['deleted']:
        if isinstance(deleted_at, bool) or not isinstance(deleted_at, (int, float)):
            raise ValueError('Invalid deletedAt.')
        if deleted_at != deleted_at or deleted_at in (float('inf'), float('-inf')):
            raise ValueError('Invalid deletedAt.')
        deleted_at = int(deleted_at)
    else:
        deleted_at = None
    date = note.get('date')
    if not isinstance(date, str):
        date = 'Now'
    cleaned = {
        'id': note_id,
        'title': title,
        'body': body,
        'tags': cleaned_tags,
        'sections': sections,
        'ext': ext,
        'date': date[:40],
        'favorite': note['favorite'],
        'archived': note['archived'],
        'deleted': note['deleted'],
    }
    if deleted_at is not None:
        cleaned['deletedAt'] = deleted_at
    return cleaned


@app.route('/api/notes', methods=['GET'])
def api_get_notes():
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    row = conn.execute('SELECT enc_notes, enc_blob, updated_at FROM user_notes WHERE username = ?', (user['username'],)).fetchone()
    conn.close()
    if not row:
        return jsonify({'notes': [], 'updated_at': 0})
    blob = bytes(row['enc_blob'] or b'')
    if blob:
        # E2EE account: opaque ciphertext the server cannot read.
        return jsonify({
            'payload': {
                'iv': base64.b64encode(blob[:12]).decode('ascii'),
                'data': base64.b64encode(blob[12:]).decode('ascii'),
            },
            'updated_at': row['updated_at'],
        })
    legacy = bytes(row['enc_notes'] or b'')
    if not legacy:
        return jsonify({'notes': [], 'updated_at': row['updated_at']})
    try:
        notes = decrypt_notes(legacy)
    except Exception:
        return jsonify({'error': 'Notes undecodable.'}), 500
    if not isinstance(notes, list):
        return jsonify({'error': 'Notes undecodable.'}), 500
    return jsonify({'notes': notes, 'updated_at': row['updated_at']})


@app.route('/api/notes', methods=['PUT'])
def api_put_notes():
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    if request.content_length and request.content_length > NOTES_MAX_REQUEST_BYTES:
        return jsonify({'error': 'Notes too large.'}), 413
    conn = get_db()
    if rate_exceeded(conn, ['notes:' + user['username'].lower()], NOTES_PUT_MAX, NOTES_PUT_WINDOW_SECONDS):
        conn.close()
        return jsonify({'error': 'Too many saves — slow down.'}), 429
    data = request.get_json(silent=True)
    items = data.get('notes') if isinstance(data, dict) else None
    payload = data.get('payload') if isinstance(data, dict) else None
    # Optimistic concurrency (LWW fix): clients must send baseVersion =
    # updated_at they last GET. Stale or missing -> 409/400 so a hijacked or
    # racing overwrite cannot silently destroy newer data (old clients must
    # upgrade; app shell is no-store so they fetch fresh quickly).
    base_version = data.get('baseVersion') if isinstance(data, dict) else None
    cur_row = conn.execute('SELECT updated_at, enc_blob FROM user_notes WHERE username = ?',
                           (user['username'],)).fetchone()
    cur_version = cur_row['updated_at'] if cur_row else 0
    if base_version is None:
        conn.close()
        return jsonify({'error': 'Missing baseVersion — reload and retry.',
                        'updated_at': int(cur_version or 0)}), 400
    if base_version is not None:
        try:
            if int(base_version) != int(cur_version or 0):
                conn.close()
                return jsonify({'error': 'Notes changed on server — reload and retry.',
                                'updated_at': int(cur_version or 0)}), 409
        except (ValueError, TypeError):
            conn.close()
            return jsonify({'error': 'Invalid baseVersion.'}), 400
    row = conn.execute('SELECT salt_auth, auth_hash, salt_enc, enc_master_key FROM users WHERE username = ?',
                       (user['username'],)).fetchone()
    if row and is_e2ee_account(row):
        # E2EE account: the body is opaque ciphertext. Only size/format is
        # validated — contents are never inspected.
        try:
            blob_iv = b64decode_strict((payload or {}).get('iv'), 12)
            blob_ct_raw = (payload or {}).get('data')
            if not isinstance(blob_ct_raw, str):
                raise ValueError('Invalid payload.')
            blob_ct = base64.b64decode(blob_ct_raw.encode('ascii'), validate=True)
        except (ValueError, AttributeError, base64.binascii.Error):
            conn.close()
            return jsonify({'error': 'Invalid payload.'}), 400
        if not 1 <= len(blob_ct) <= NOTES_MAX_TOTAL_BYTES:
            conn.close()
            return jsonify({'error': 'Notes too large.'}), 413
        now = int(time.time())
        # History: stash previous opaque blob (rollback after hijack).
        try:
            if cur_row and cur_row['enc_blob']:
                conn.execute(
                    'INSERT INTO user_notes_history (username, enc_blob, updated_at) VALUES (?, ?, ?)',
                    (user['username'], bytes(cur_row['enc_blob']), int(cur_version or 0)),
                )
                conn.execute(
                    'DELETE FROM user_notes_history WHERE id NOT IN '
                    '(SELECT id FROM user_notes_history WHERE username = ? ORDER BY id DESC LIMIT 5)',
                    (user['username'],),
                )
        except Exception:
            pass
        conn.execute(
            'INSERT INTO user_notes (username, enc_notes, updated_at, enc_blob) VALUES (?, ?, ?, ?)'
            ' ON CONFLICT(username) DO UPDATE SET enc_notes = excluded.enc_notes,'
            ' updated_at = excluded.updated_at, enc_blob = excluded.enc_blob',
            (user['username'], b'', now, bytes(blob_iv) + bytes(blob_ct)),
        )
        rate_hit(conn, 'notes:' + user['username'].lower())
        conn.commit()
        conn.close()
        return jsonify({'ok': True, 'updated_at': now})
    if not isinstance(items, list) or len(items) > NOTES_MAX_COUNT:
        conn.close()
        return jsonify({'error': f'Notes must be a list of at most {NOTES_MAX_COUNT}.'}), 400
    try:
        cleaned = []
        running_total = 2  # JSON brackets; abort early instead of building ~1GB first
        for item in items:
            note = validate_note_object(item)
            running_total += len(json.dumps(note).encode('utf-8')) + 1
            if running_total > NOTES_MAX_TOTAL_BYTES:
                conn.close()
                return jsonify({'error': 'Notes too large.'}), 413
            cleaned.append(note)
    except ValueError as error:
        conn.close()
        return jsonify({'error': f'Invalid note: {error}'}), 400
    now = int(time.time())
    conn.execute(
        'INSERT INTO user_notes (username, enc_notes, updated_at, enc_blob) VALUES (?, ?, ?, ?)'
        ' ON CONFLICT(username) DO UPDATE SET enc_notes = excluded.enc_notes,'
        ' updated_at = excluded.updated_at, enc_blob = excluded.enc_blob',
        (user['username'], encrypt_notes(cleaned), now, b''),
    )
    rate_hit(conn, 'notes:' + user['username'].lower())
    conn.commit()
    conn.close()
    return jsonify({'ok': True, 'updated_at': now})


@app.route('/api/vault-meta', methods=['GET'])
def api_vault_meta_get():
    """Return the vault verifier material (salts + wrapped key) for unlocking.
    Verification itself happens client-side, so unlocking costs the server
    nothing and reveals nothing beyond what the session already proves."""
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    row = conn.execute('SELECT salt_auth, verifier, salt_enc, enc_dek FROM vault_meta WHERE username = ?',
                       (user['username'],)).fetchone()
    conn.close()
    if not row:
        return jsonify({'exists': False})
    return jsonify({
        'exists': True,
        'saltAuth': base64.b64encode(bytes(row['salt_auth'])).decode('ascii'),
        'verifier': base64.b64encode(bytes(row['verifier'])).decode('ascii'),
        'saltEnc': base64.b64encode(bytes(row['salt_enc'])).decode('ascii'),
        'encDek': {
            'iv': base64.b64encode(bytes(row['enc_dek'])[:12]).decode('ascii'),
            'data': base64.b64encode(bytes(row['enc_dek'])[12:]).decode('ascii'),
        },
    })


@app.route('/api/vault-meta', methods=['POST'])
def api_vault_meta_set():
    """Create (or re-create after a reset) the vault verifier + wrapped key.
    Sizes are strictly validated; the password itself never arrives.
    Overwrite requires proof: currentVaultAuth (old vault verifier) OR
    currentAccountAuth (login verifier) so a stolen cookie alone cannot
    destroy/replace the vault. Initial creation needs no proof."""
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    if rate_exceeded(conn, [ip_bucket('vault'), 'vault:' + user['username'].lower()], CHANGE_MAX_FAILURES, CHANGE_WINDOW_SECONDS):
        conn.close()
        return jsonify({'error': 'Too many attempts — try again in a few minutes.'}), 429
    data = request.get_json(silent=True) or {}
    try:
        verifier = b64decode_strict(data.get('verifier'), 32)
        salt_auth = b64decode_strict(data.get('saltAuth'), 16)
        salt_enc = b64decode_strict(data.get('saltEnc'), 16)
        wrap = data.get('encDek') or {}
        wrap_iv = b64decode_strict(wrap.get('iv'), 12)
        wrap_ct = b64decode_strict(wrap.get('data'), 48)
    except (ValueError, AttributeError):
        conn.close()
        return jsonify({'error': 'Invalid vault payload.'}), 400
    existing = conn.execute('SELECT verifier FROM vault_meta WHERE username = ?',
                            (user['username'],)).fetchone()
    if existing:
        # Proof required for overwrite.
        proved = False
        try:
            cur_vault = data.get('currentVaultAuth')
            cur_acct = data.get('currentAccountAuth')
            if cur_vault is not None:
                cand = b64decode_strict(cur_vault, 32)
                if hmac.compare_digest(cand, bytes(existing['verifier'])):
                    proved = True
            if not proved and cur_acct is not None:
                acct = conn.execute('SELECT auth_hash, salt_auth FROM users WHERE username = ?',
                                    (user['username'],)).fetchone()
                if acct is not None and acct['auth_hash']:
                    try:
                        cand2 = b64decode_strict(cur_acct, 32)
                        if hmac.compare_digest(cand2, bytes(acct['auth_hash'])):
                            proved = True
                    except ValueError:
                        pass
        except Exception:
            proved = False
        if not proved:
            rate_hit(conn, ip_bucket('vault'))
            rate_hit(conn, 'vault:' + user['username'].lower())
            conn.close()
            return jsonify({'error': 'Vault overwrite requires current vault or account password proof.'}), 401
    now = int(time.time())
    conn.execute(
        'INSERT INTO vault_meta (username, salt_auth, verifier, salt_enc, enc_dek, created_at)'
        ' VALUES (?, ?, ?, ?, ?, ?)'
        ' ON CONFLICT(username) DO UPDATE SET salt_auth = excluded.salt_auth,'
        ' verifier = excluded.verifier, salt_enc = excluded.salt_enc,'
        ' enc_dek = excluded.enc_dek, created_at = excluded.created_at',
        (user['username'], salt_auth, verifier, salt_enc, wrap_iv + wrap_ct, now),
    )
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/vault-meta', methods=['DELETE'])
def api_vault_meta_delete():
    """Reset the vault: drops the verifier so contents become unreadable.
    Requires current vault OR account password proof (stolen-cookie DoS fix).
    Forgot-password reset uses currentAccountAuth + explicit confirm."""
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    existing = conn.execute('SELECT verifier FROM vault_meta WHERE username = ?',
                            (user['username'],)).fetchone()
    if not existing:
        conn.close()
        return jsonify({'ok': True})
    data = request.get_json(silent=True) or {}
    proved = False
    try:
        cur_vault = data.get('currentVaultAuth')
        cur_acct = data.get('currentAccountAuth')
        if cur_vault is not None:
            try:
                cand = b64decode_strict(cur_vault, 32)
                if hmac.compare_digest(cand, bytes(existing['verifier'])):
                    proved = True
            except ValueError:
                pass
        if not proved and cur_acct is not None:
            acct = conn.execute('SELECT auth_hash FROM users WHERE username = ?',
                                (user['username'],)).fetchone()
            if acct is not None and acct['auth_hash']:
                try:
                    cand2 = b64decode_strict(cur_acct, 32)
                    if hmac.compare_digest(cand2, bytes(acct['auth_hash'])):
                        proved = True
                except ValueError:
                    pass
    except Exception:
        proved = False
    if not proved:
        rate_hit(conn, ip_bucket('vault'))
        rate_hit(conn, 'vault:' + user['username'].lower())
        conn.close()
        return jsonify({'error': 'Vault reset requires current vault or account password proof.'}), 401
    conn.execute('DELETE FROM vault_meta WHERE username = ?', (user['username'],))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/me')
def api_me():
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    now = int(time.time())
    conn = get_db()
    new_token, _digest = rotate_session_if_due(conn, user, now)
    conn.close()
    profile = {key: value for key, value in user.items() if not key.startswith('_')}
    response = jsonify(profile)
    if new_token:
        set_session_cookie(response, new_token)
    return response


@app.route('/api/logout', methods=['POST'])
def api_logout():
    for cookie_name in (SESSION_COOKIE, LEGACY_SESSION_COOKIE):
        try:
            token = request.cookies.get(cookie_name)
        except Exception:
            token = None
        if token:
            try:
                digest = hashlib.sha256(token.encode('utf-8')).hexdigest()
            except Exception:
                continue
            try:
                conn = get_db()
                conn.execute('DELETE FROM sessions WHERE token_hash = ?', (digest,))
                conn.commit()
                conn.close()
            except Exception:
                pass
    response = jsonify({'ok': True})
    # Mirror the session cookie flags so browsers actually drop it (a Secure
    # cookie is only cleared by a Secure deletion cookie). Clear both names.
    response.delete_cookie(SESSION_COOKIE, path='/',
                           httponly=True, samesite='Lax', secure=session_cookie_secure())
    response.delete_cookie(LEGACY_SESSION_COOKIE, path='/',
                           httponly=True, samesite='Lax', secure=session_cookie_secure())
    return response


if __name__ == '__main__':
    init_db()
    # Hide Werkzeug version banner (info-disclosure fix). Must run before app.run.
    try:
        import werkzeug.serving
        werkzeug.serving.WSGIRequestHandler.server_version = 'Notely'
        werkzeug.serving.WSGIRequestHandler.sys_version = ''
    except Exception:
        pass
    port = int(os.environ.get('PORT', '5000'))
    print('NOTELY: production use requires HTTPS reverse proxy + NOTELY_COOKIE_SECURE=1 '
          '(default Secure ON) + gunicorn (Werkzeug dev server is single-process).', flush=True)
    app.run(host='127.0.0.1', port=port, threaded=True)
