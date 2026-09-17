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
import queue
import os
import re
import secrets
import ssl
import struct
import sys
import threading
import time

import psycopg2
import psycopg2.extras

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from flask import Flask, jsonify, request, send_from_directory
from argon2.low_level import Type as Argon2Type, hash_secret_raw

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PG_DSN = os.environ.get(
    'NOTELY_PG_DSN',
    'dbname=notelydb user=notely password=notely_secure_2026 host=localhost'
)
print(f'NOTELY DB: using PostgreSQL ({PG_DSN.split("dbname=")[1].split()[0] if "dbname=" in PG_DSN else PG_DSN})', flush=True)
KEY_PATH = os.environ.get('NOTELY_KEY_PATH', os.path.join(BASE_DIR, 'notely.key'))
# Automatic backups: pg_dump copies of the PostgreSQL database, taken on a daemon
# thread. Copies (not moves) — the DB itself is never touched. Env overrides:
#   NOTELY_BACKUP_INTERVAL_SECONDS  cadence (0 disables backups entirely)
#   NOTELY_BACKUP_KEEP              how many timestamped copies to retain
BACKUP_DIR = os.environ.get('NOTELY_BACKUP_DIR', os.path.join(BASE_DIR, 'dbbackup'))
BACKUP_INTERVAL_SECONDS = int(os.environ.get('NOTELY_BACKUP_INTERVAL_SECONDS', '3600'))
BACKUP_KEEP = max(1, int(os.environ.get('NOTELY_BACKUP_KEEP', '48')))
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
# Recovery-code guessing: per-account ceiling so a botnet cannot aggregate
# unlimited attempts against one account. Locks recovery-code endpoints only
# (login/notes stay usable — no login DoS). Aligned with the IP throttle (5)
# so the account message, not the generic one, is what users see.
RECOVERY_FAIL_WINDOW_SECONDS = 3600
RECOVERY_MAX_FAILURES = 5
# Lifetimes for second-factor artifacts. Short on purpose: a stolen ticket or
# emailed link is only useful inside these windows.
MFA_TICKET_TTL_SECONDS = 300
EMAIL_TOKEN_TTL_SECONDS = 900
PASSKEY_CHALLENGE_TTL_SECONDS = 300
CHANGE_WINDOW_SECONDS = 900
CHANGE_MAX_FAILURES = 5
NOTES_PUT_WINDOW_SECONDS = 60
NOTES_PUT_MAX = 60
NOTES_MAX_COUNT = 2000
NOTES_MAX_BODY_CHARS = 500000
NOTES_MAX_TOTAL_BYTES = 6 * 1024 * 1024
# Collaborative note shares/updates reuse the notes size cap (opaque blobs).
# Pentest F-15: per-section note count cap (2000 shared notes per group).
SHARE_MAX_BYTES = NOTES_MAX_TOTAL_BYTES
SHARE_MAX_NOTES = 2000
# Shared-section administration: at most SHARE_MAX_MEMBERS people (owner
# included) may share a section, and the sharing surface is throttled per user.
SHARE_MAX_MEMBERS = 4
SHARE_UPDATE_MAX_BYTES = 256 * 1024
SHARE_ADMIN_WINDOW_SECONDS = 3600
SHARE_ADMIN_MAX = 60
NOTES_MAX_REQUEST_BYTES = 7 * 1024 * 1024

# Collab SSE stream limits: bounded queue per subscriber + per-user cap.
SSE_QUEUE_MAX_EVENTS = 200
SSE_MAX_SUBSCRIBERS_PER_USER = 5

# Password policy — aligned to NIST SP 800-63B (800-63-4): length is the
# primary factor, composition rules are NOT imposed, long passwords allowed,
# and a blocklist of common/compromised values is enforced. Applies to
# server-visible passwords (legacy change path, bootstrap env values); E2EE
# registrations are checked client-side plus the server weak-screen.
PASSWORD_MIN_LENGTH = 15
PASSWORD_MAX_LENGTH = 256
USERNAME_RE = re.compile(r'^[A-Za-z0-9_-]{3,32}$')
# Person names: letters first, then letters/spaces/hyphens/apostrophes/periods.
NAME_RE = re.compile(r"^[A-Za-z][A-Za-z'.\- ]{0,39}$")
NOTE_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,80}$')

# Blocklist of commonly used / expected / compromised passwords. The embedded
# set is intentionally small; real deployments should point
# NOTELY_PASSWORD_BLOCKLIST at a large list (one password per line, e.g. a
# SecLists or Pwned Passwords export) — entries are merged at startup.
_EMBEDDED_BLOCKLIST = frozenset(word.lower() for word in (
    '123456', '123456789', '12345678', '1234567', '1234567890', '12345', '1234',
    '123', '111111', '000000', '121212', '123123', 'password', 'password1',
    'password1!', 'password123', 'password123!', 'passw0rd', 'pass1234', 'abc123',
    'qwerty', 'qwerty123', 'qwertyuiop', 'qwertyuiopas', 'qazwsx', '1q2w3e4r',
    'asdfghjkl', 'zaq12wsx', 'admin', 'admin123', 'admin123!', 'administrator',
    'root', 'toor', 'login', 'letmein', 'welcome', 'welcome1', 'monkey', 'dragon',
    'iloveyou', 'sunshine', 'princess', 'football', 'trustno1', 'whatever',
    'freedom', 'hello', 'changeme', 'secret', 'master', 'shadow', 'superman',
    'michael', 'aaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa', 'notely', 'notely123',
    'notely123!', 'notes12345', 'notes123456',
))


def _load_password_blocklist():
    words = set(_EMBEDDED_BLOCKLIST)
    path = os.environ.get('NOTELY_PASSWORD_BLOCKLIST')
    if path and os.path.exists(path):
        try:
            with open(path, 'r', errors='ignore') as handle:
                for line in handle:
                    word = line.strip().lower()
                    if word:
                        words.add(word)
        except Exception:
            pass
    return frozenset(words)


PASSWORD_BLOCKLIST = _load_password_blocklist()


# Enforce the policy for server-visible passwords. Returns (ok, message).
def validate_password(password):
    """NIST-aligned check: length only (no composition) + blocklist."""
    if not isinstance(password, str):
        return False, 'Password must be a string.'
    if len(password) < PASSWORD_MIN_LENGTH:
        return False, f'Password must be at least {PASSWORD_MIN_LENGTH} characters.'
    if len(password) > PASSWORD_MAX_LENGTH:
        return False, f'Password must be at most {PASSWORD_MAX_LENGTH} characters.'
    if password.lower() in PASSWORD_BLOCKLIST:
        return False, 'That password is too common — choose a different one.'
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


EMAIL_RE = re.compile(r"^[^@\s<>\"]+@[^@\s<>\"]+\.[^@\s<>\"]+$")


def validate_email(email):
    """Empty allowed (unset); otherwise single @, dot-suffix, max 254."""
    if not isinstance(email, str):
        return False
    email = email.strip()
    if not email:
        return True
    if len(email) > 254:
        return False
    return bool(EMAIL_RE.match(email))


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
}


# Resolve a bootstrap password: NOTELY_PASSWORD_<USER> env var wins, else generate + print once to the server log.
def bootstrap_password(username):
    env_name = 'NOTELY_PASSWORD_' + username.upper()
    configured = os.environ.get(env_name)
    if configured:
        return configured, 'env'
    return generate_policy_password(), 'generated'

PUBLIC_FILES = {'app.js', 'styles.css', 'favicon.ico',
                'vendor/argon2/argon2.js', 'vendor/argon2/argon2-wrapper.js', 'vendor/argon2/argon2.wasm',
                'vendor/qrcode/qrcode.min.js'}

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


# Open a PostgreSQL connection with dict-like row access.
class _PgResult:
    """Thin wrapper to mimic sqlite3 cursor result behaviour."""
    def __init__(self, cursor):
        self._cursor = cursor
    def fetchone(self):
        row = self._cursor.fetchone()
        return _PgRow(row, self._cursor.description) if row else None
    def fetchall(self):
        if not self._cursor.description:
            return []
        return [_PgRow(r, self._cursor.description) for r in self._cursor.fetchall()]
    def __iter__(self):
        if not self._cursor.description:
            return iter([])
        return iter(self.fetchall())
    @property
    def lastrowid(self):
        try:
            return self._cursor.fetchone()[0]
        except Exception:
            return None
    @property
    def rowcount(self):
        return self._cursor.rowcount

class _PgRow:
    """Dict-like row that supports both index and key access (like sqlite3.Row)."""
    __slots__ = ('_data', '_keys')
    def __init__(self, row, description):
        self._keys = [d[0] for d in description]
        self._data = dict(zip(self._keys, row))
    def __getitem__(self, key):
        if isinstance(key, (int, slice)):
            return list(self._data.values())[key]
        return self._data[key]
    def __contains__(self, key):
        return key in self._data
    def keys(self):
        return self._keys
    def __repr__(self):
        return repr(self._data)

class _PgConnection:
    """Thin wrapper around psycopg2 that mimics the sqlite3 connection API.

    Auto-converts ? placeholders to %s, returns _PgResult from execute(),
    and provides commit/rollback/close. This lets the rest of server.py
    keep its existing conn.execute(sql, params) pattern with minimal changes."""
    def __init__(self, dsn):
        self._conn = psycopg2.connect(dsn)
        self._conn.autocommit = False
    def execute(self, sql, params=None):
        # Pentest F-50: the placeholder swap is a blanket string replace. Never
        # write a literal '?' inside a SQL string (even inside quotes) — it
        # would be silently converted to %s and corrupt the statement. Use a
        # parameter placeholder or spell it differently. Verified: no current
        # SQL string in server.py contains a bare '?' — keep it that way.
        sql = sql.replace('?', '%s')
        cur = self._conn.cursor()
        cur.execute(sql, params or ())
        return _PgResult(cur)
    def commit(self):
        self._conn.commit()
    def rollback(self):
        self._conn.rollback()
    def close(self):
        self._conn.close()
    @property
    def in_transaction(self):
        return self._conn.status != psycopg2.extensions.STATUS_READY

def get_db(attempt=0):
    try:
        return _PgConnection(PG_DSN)
    except psycopg2.OperationalError:
        if attempt >= 2:
            raise
        time.sleep(0.3 * (attempt + 1))
        return get_db(attempt + 1)


DB_KEY = get_db_key()


def _pg_columns(conn, table):
    """Get column names for a table (replaces PRAGMA table_info)."""
    cur = conn.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_name = %s",
        (table,),
    )
    return {row['column_name'] for row in cur.fetchall()}


# AES-GCM encrypt bytes under the database key; optional AAD binds the blob
# to its account/field (cross-account swap resistance). Server-side data only.
# Returns nonce+ciphertext.
def encrypt_blob(plaintext_bytes, aad=None):
    aesgcm = AESGCM(DB_KEY)
    nonce = secrets.token_bytes(12)
    return nonce + aesgcm.encrypt(nonce, bytes(plaintext_bytes), aad)


# AES-GCM decrypt a nonce+ciphertext blob; throws on tampering or wrong key.
# Dual-read: AAD-bound (new) blobs and unbound (legacy) blobs both decrypt, so
# the rollout needs no one-shot migration; new writes always carry the AAD.
def decrypt_blob(blob, aad=None):
    aesgcm = AESGCM(DB_KEY)
    try:
        return aesgcm.decrypt(bytes(blob[:12]), bytes(blob[12:]), aad)
    except Exception:
        if aad:
            return aesgcm.decrypt(bytes(blob[:12]), bytes(blob[12:]), None)
        raise


def blob_aad(kind, username):
    return f'notely-{kind}-v1:{username or ""}'.encode('utf-8')


def encrypt_profile(profile, username=None):
    return encrypt_blob(json.dumps(profile).encode('utf-8'), blob_aad('profile', username))


def decrypt_profile(blob, username=None):
    return json.loads(decrypt_blob(blob, blob_aad('profile', username) if username else None).decode('utf-8'))


def encrypt_notes(notes, username=None):
    return encrypt_blob(json.dumps(notes).encode('utf-8'), blob_aad('notes-legacy', username))


def decrypt_notes(blob, username=None):
    return json.loads(decrypt_blob(blob, blob_aad('notes-legacy', username) if username else None).decode('utf-8'))


# PBKDF2-HMAC-SHA256 password hash for legacy verifiers.
def hash_password(password, salt):
    return hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), bytes(salt), PBKDF2_ITERATIONS)


def argon2id_raw(password, salt):
    """Memory-hard KDF shared bit-for-bit with the browser (argon2-browser,
    Argon2id t=3 m=64MiB p=1). Used for auth verifiers and KEKs."""
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
    """An account is E2EE once it carries wrapped-key material and a verifier.

    Accepts either the raw verifier (legacy, pre-pepper) or the peppered one
    (auth_hash2). Raw is dropped once a row is peppered (M-4 migration)."""
    try:
        verifier = row['auth_hash2'] or row['auth_hash']
    except Exception:
        try:
            verifier = row['auth_hash']
        except Exception:
            return False
    try:
        return bool(row['salt_auth'] and verifier and row['salt_enc'] and row['enc_master_key'])
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


# Weak-password screen for E2EE verifiers. The server never sees the password,
# only Argon2id(password, saltAuth), so it cannot measure length or character
# classes — the client policy check remains the primary gate. What the server
# CAN do is reject verifiers that match a known-weak password, plus identity-
# derived guesses. Every candidate costs one pinned Argon2id (~0.1 s at 64 MiB),
# so the search is bounded by NOTELY_WEAK_SCREEN_MAX (default 40) to keep
# registration responsive. This is a bar-raiser against scripted policy bypass,
# NOT a complete policy: a determined API client can still register a weak
# password the list misses. The definitive fix is OPAQUE/PAKE (server never
# sees the password yet can still bind policy at the protocol level).
WEAK_SCREEN_MAX = max(1, int(os.environ.get('NOTELY_WEAK_SCREEN_MAX', '40')))
IDENTITY_SCREEN_MAX = max(0, int(os.environ.get('NOTELY_IDENTITY_SCREEN_MAX', '12')))

# Top leaked / trivial passwords, including the common capitalised variants a
# naive lowercase-only dictionary misses and obvious repeated-character
# patterns. Order matters: entries past WEAK_SCREEN_MAX after identity guesses
# are not tested, so the highest-value candidates come first.
_WEAK_PASSWORD_CANDIDATES = (
    '123456', '123456789', '12345678', '12345', '1234', '123',
    '111111', '000000', '123123',
    'password', 'password1', 'Password1!', 'password123', 'Password123!',
    'passw0rd', 'pass1234', 'abc123',
    'admin', 'admin123', 'Admin123!', 'administrator', 'root', 'login',
    'qwerty', 'qwerty123', 'qwertyuiopas', 'qazwsx', '1q2w3e4r', 'asdfghjkl',
    'aaaaaaaaaaaa',
    # Pentest F-39: extended builtin blocklist (top-common leaked passwords).
    # Static cost — matched within the same bounded per-candidate budget.
    'letmein', 'welcome', 'monkey', 'dragon', 'football', 'baseball',
    'sunshine', 'princess', 'superman', 'batman', 'starwars', 'master',
    'iloveyou', 'trustno1', 'janedoe', 'johncena', 'ninja', 'hunter2',
    'passwort', 'motdepasse', 'contrasena', 'heslo', 'geheim', 'vindiesel',
    '123qwe', 'qwe123', '1qaz2wsx', 'zxcvbnm', 'abcd1234', 'abcd1234!',
    'changeme', 'ChangeMe123', 'secret', 'letmein1', 'freckle', 'patrick',
    'soccer', 'hockey', 'killer', 'george', 'charlie', 'pepper',
    'friends', 'whatever', 'lovely', 'nothing',
)

# Suffixes appended to identity bases ("reizu" -> "reizu123", "reizu!" ...).
_IDENTITY_SUFFIXES = ('', '1', '12', '123', '1234', '12345', '123456',
                      '!', '@', '1!', '!1', '2024', '2025', '2026')


def identity_password_candidates(*values):
    """Bounded weak-password guesses derived from an account's own identifiers.

    Catches the very common "username123" / "firstname!" class of weak
    passwords cheaply. Output is capped by IDENTITY_SCREEN_MAX so the total
    Argon2id budget stays predictable.
    """
    if IDENTITY_SCREEN_MAX <= 0:
        return []
    bases = []
    seen_base = set()

    def add_base(text):
        text = str(text or '').strip().lower()
        if 3 <= len(text) <= 32 and text not in seen_base:
            seen_base.add(text)
            bases.append(text)

    for value in values:
        text = str(value or '').strip().lower()
        if not text:
            continue
        add_base(text)
        if '@' in text:
            add_base(text.split('@', 1)[0])
        for part in re.split(r'[^a-z0-9]+', text):
            add_base(part)

    out = []
    for base in bases:
        for suffix in _IDENTITY_SUFFIXES:
            out.append(base + suffix)
            if len(out) >= IDENTITY_SCREEN_MAX:
                return out
    return out


def bounded_weak_candidates(extra_candidates=()):
    """Merge identity guesses (first) with the curated list, deduped and capped."""
    merged = []
    seen = set()
    for candidate in list(extra_candidates) + list(_WEAK_PASSWORD_CANDIDATES):
        text = str(candidate)
        if not text or text in seen:
            continue
        seen.add(text)
        merged.append(text)
        if len(merged) >= WEAK_SCREEN_MAX:
            break
    return merged


def verifier_matches_any(target_bytes, salt_auth_bytes, candidates):
    """Constant-time-over-candidates Argon2id match against a bounded list.

    No early exit, so timing does not reveal whether/which weak password
    matched. Returns False on any malformed input.
    """
    try:
        target = bytes(target_bytes)
        salt = bytes(salt_auth_bytes)
    except Exception:
        return False
    matched = False
    for candidate in candidates:
        try:
            if hmac.compare_digest(argon2id_raw(candidate, salt), target):
                matched = True
        except Exception:
            continue
    return matched


def is_weak_verifier(auth_hash_bytes, salt_auth_bytes, extra_candidates=()):
    """True if authHash matches a weak/identity-derived password under its salt."""
    return verifier_matches_any(auth_hash_bytes, salt_auth_bytes,
                                bounded_weak_candidates(extra_candidates))


# Same screen for VAULT verifiers. The vault password never reaches the server
# (E2EE), so the full length/complexity policy is enforced only client-side;
# this catches trivially weak vault passwords a scripted client could smuggle
# past the browser check.
def is_weak_vault_verifier(verifier_bytes, salt_auth_bytes):
    """True if the vault verifier matches a trivial password under its salt."""
    return verifier_matches_any(verifier_bytes, salt_auth_bytes,
                                bounded_weak_candidates())


# --- MFA TOTP (RFC 6238, 6-digit, SHA1, 30s) + pepper (OPAQUE interim) ---
# All stdlib, no new deps. Secrets encrypted with DB_KEY via existing
# encrypt_blob/decrypt_blob so a DB dump alone does not yield MFA secrets.

def totp_code(secret_bytes, for_time=None, step=30, digits=6):
    """Current TOTP code for secret (used by server verify; client uses app)."""
    try:
        t = int((for_time if for_time is not None else time.time()) // step)
        msg = struct.pack('>Q', t)
        mac = hmac.new(bytes(secret_bytes), msg, hashlib.sha1).digest()
        offset = mac[-1] & 0x0F
        num = struct.unpack('>I', mac[offset:offset + 4])[0] & 0x7FFFFFFF
        return str(num % (10 ** digits)).zfill(digits)
    except Exception:
        return ''


def totp_verify(secret_bytes, code, window=1, step=30):
    """Constant-time-ish TOTP check allowing ±window steps (clock skew)."""
    try:
        code = str(code or '').strip()
        if not code.isdigit():
            return False
        now = int(time.time())
        for skew in range(-window, window + 1):
            if hmac.compare_digest(totp_code(secret_bytes, now + skew * step, step), code):
                return True
        return False
    except Exception:
        return False


def pepper_auth_hash(auth_hash_bytes):
    """Server-side pepper: HMAC(DB_KEY, 'notely-auth-v1:' + authHash)."""
    return hmac.new(DB_KEY, b'notely-auth-v1:' + bytes(auth_hash_bytes), hashlib.sha256).digest()


def verify_auth_hash(candidate_bytes, row):
    """Dual-verify during the pepper migration.

    Returns ('peppered'|'raw'|None). A row with a valid peppered hash
    (auth_hash2) is verified only through the pepper; a row still holding only
    the legacy raw hash returns 'raw' and is upgraded by the caller on success.

    NOTE: this is a consistency/defence-in-depth hardening, not a complete fix
    for the DB-leak replay case. Because the server peppers the client-supplied
    candidate, a leaked raw 'auth_hash' can still authenticate through the
    peppered branch. Fully closing M-4 requires dropping/encrypting the stored
    raw verifier (a storage migration), which is intentionally NOT done here.
    """
    try:
        cand = bytes(candidate_bytes)
    except Exception:
        return None
    try:
        stored2 = bytes(row['auth_hash2']) if row['auth_hash2'] else None
    except Exception:
        stored2 = None
    if stored2 and len(stored2) == 32:
        try:
            if hmac.compare_digest(pepper_auth_hash(cand), stored2):
                return 'peppered'
        except Exception:
            pass
        # Peppered row: do not fall back to the stored raw verifier (e.g. after
        # a key change the stale peppered hash must fail closed, not downgrade).
        return None
    try:
        stored = bytes(row['auth_hash']) if row['auth_hash'] else None
    except Exception:
        stored = None
    if stored and len(stored) == 32:
        try:
            if hmac.compare_digest(cand, stored):
                return 'raw'
        except Exception:
            pass
    return None


def issue_mfa_ticket(conn, username, ttl_seconds=MFA_TICKET_TTL_SECONDS):
    """Mint single-use MFA ticket hash; returns plaintext ticket to client."""
    ticket = secrets.token_urlsafe(32)
    digest = hashlib.sha256(ticket.encode('utf-8')).hexdigest()
    now = int(time.time())
    try:
        conn.execute('DELETE FROM mfa_challenges WHERE expires_at < ?', (now,))
    except Exception:
        pass
    conn.execute(
        'INSERT INTO mfa_challenges (ticket_hash, username, expires_at, created_at)'
        ' VALUES (?, ?, ?, ?)',
        (digest, username, now + int(ttl_seconds), now),
    )
    conn.commit()
    return ticket


# --- WebAuthn passkeys (option-1: login factor, password still unlocks E2EE) ---
# Minimal stdlib+cryptography verifier: attestation 'none' on register,
# ES256 (P-256/SHA256) assertions. No new deps. RP ID = request hostname
# (works for localhost and 127.0.0.1 secure contexts); origin must match
# scheme://host exactly.

def b64url_encode(raw):
    try:
        return base64.urlsafe_b64encode(bytes(raw)).decode('ascii').rstrip('=')
    except Exception:
        return ''


def b64url_decode(value):
    try:
        s = str(value or '')
        s += '=' * (-len(s) % 4)
        return base64.urlsafe_b64decode(s.encode('ascii'))
    except Exception:
        raise ValueError('Invalid base64url.')


# WebAuthn CBOR (attestationObject/COSE keys) is shallow; a hard cap stops a
# crafted deeply-nested object from exhausting the C stack (RecursionError).
CBOR_MAX_DEPTH = 16


def cbor_decode_minimal(data, pos=0, depth=0):
    """Minimal definite-length CBOR decoder (maps/arrays/bstr/tstr/uint/negint/tags).

    Returns (value, next_pos). Byte strings -> bytes, text -> str, arrays ->
    list, maps -> dict, tags -> inner value (tag ignored). Enough for
    attestationObject and COSE keys (no indefinite lengths/floats)."""
    if depth > CBOR_MAX_DEPTH:
        raise ValueError('CBOR nested too deeply.')
    if pos >= len(data):
        raise ValueError('CBOR truncated.')
    initial = data[pos]
    pos += 1
    major = initial >> 5
    info = initial & 0x1F

    def read_length(info, pos):
        if info < 24:
            return info, pos
        if info == 24:
            return data[pos], pos + 1
        if info == 25:
            return struct.unpack('>H', bytes(data[pos:pos + 2]))[0], pos + 2
        if info == 26:
            return struct.unpack('>I', bytes(data[pos:pos + 4]))[0], pos + 4
        if info == 27:
            return struct.unpack('>Q', bytes(data[pos:pos + 8]))[0], pos + 8
        raise ValueError('Indefinite CBOR not supported.')

    if major == 0:
        n, pos = read_length(info, pos)
        return n, pos
    if major == 1:
        n, pos = read_length(info, pos)
        return -1 - n, pos
    if major == 2:
        n, pos = read_length(info, pos)
        return bytes(data[pos:pos + n]), pos + n
    if major == 3:
        n, pos = read_length(info, pos)
        return bytes(data[pos:pos + n]).decode('utf-8'), pos + n
    if major == 4:
        n, pos = read_length(info, pos)
        out = []
        for _ in range(n):
            val, pos = cbor_decode_minimal(data, pos, depth + 1)
            out.append(val)
        return out, pos
    if major == 5:
        n, pos = read_length(info, pos)
        out = {}
        for _ in range(n):
            key, pos = cbor_decode_minimal(data, pos, depth + 1)
            val, pos = cbor_decode_minimal(data, pos, depth + 1)
            out[key] = val
        return out, pos
    if major == 6:
        _tag, pos = read_length(info, pos)
        return cbor_decode_minimal(data, pos, depth + 1)
    if major == 7:
        if info == 20:
            return False, pos
        if info == 21:
            return True, pos
        if info == 22:
            return None, pos
        raise ValueError('Unsupported CBOR simple value.')
    raise ValueError('Bad CBOR.')


def webauthn_rp_id():
    try:
        return (request.host or '').split(':')[0].lower()
    except Exception:
        return ''


def webauthn_expected_origin():
    try:
        return f'{request.scheme}://{request.host}'.lower()
    except Exception:
        return ''


def parse_authenticator_data(auth_data):
    """Split authData -> dict(rpIdHash, flags, signCount, remainder)."""
    if len(auth_data) < 37:
        raise ValueError('authData too short.')
    return {
        'rpIdHash': bytes(auth_data[:32]),
        'flags': auth_data[32],
        'signCount': struct.unpack('>I', bytes(auth_data[33:37]))[0],
        'remainder': bytes(auth_data[37:]),
    }


def cose_ec_p256_pubkey(cose_bytes):
    """Extract uncompressed 65B pubkey from COSE EC2 P-256 map. Requires alg -7."""
    cose, _ = cbor_decode_minimal(bytes(cose_bytes), 0)
    if not isinstance(cose, dict):
        raise ValueError('Bad COSE key.')
    if cose.get(1) != 2 or cose.get(3) != -7 or cose.get(-1) != 1:
        raise ValueError('Only ES256 P-256 supported.')
    x, y = cose.get(-2), cose.get(-3)
    if not isinstance(x, bytes) or len(x) != 32 or not isinstance(y, bytes) or len(y) != 32:
        raise ValueError('Bad EC coordinates.')
    return b'\x04' + bytes(x) + bytes(y)


def verify_es256(uncompressed_pubkey, data, signature_der_or_raw):
    """Verify ES256. Accepts DER or raw 64B R||S signatures."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
    sig = bytes(signature_der_or_raw)
    if len(sig) == 64:
        r = int.from_bytes(sig[:32], 'big')
        s = int.from_bytes(sig[32:], 'big')
        sig = encode_dss_signature(r, s)
    pub = ec.EllipticCurvePublicNumbers(
        int.from_bytes(bytes(uncompressed_pubkey[1:33]), 'big'),
        int.from_bytes(bytes(uncompressed_pubkey[33:65]), 'big'),
        ec.SECP256R1(),
    ).public_key()
    pub.verify(sig, bytes(data), ec.ECDSA(hashes.SHA256()))
    return True



# Constant-time legacy password check against the stored verifier.
def verify_password(password, salt, expected_hash, iterations):
    try:
        # Bounded count: a DB-write attacker could inflate iterations to make
        # login CPU-bound (DoS). (Lower-bound floor enforced client-side with
        # dual-read fallback for historical rows.)
        bounded = min(max(int(iterations or 0), 1), 2_000_000)
        candidate = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), bytes(salt), bounded)
    except Exception:
        return False
    return hmac.compare_digest(candidate, bytes(expected_hash))


# Create/migrate tables, seed bootstrap accounts (fully E2EE), and print generated passwords once. Safe to rerun.
def init_db():
    conn = get_db()
    conn.execute(
        'CREATE TABLE IF NOT EXISTS users ('
        'username TEXT PRIMARY KEY, pwd_salt BYTEA NOT NULL, pwd_hash BYTEA NOT NULL, '
        'iterations INTEGER NOT NULL, enc_profile BYTEA NOT NULL, created_at INTEGER NOT NULL)'
    )
    conn.execute(
        'CREATE TABLE IF NOT EXISTS sessions ('
        'token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, '
        'expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, '
        'last_seen INTEGER NOT NULL DEFAULT 0)'
    )
    conn.execute(
        'CREATE TABLE IF NOT EXISTS rate_hits ('
        'bucket TEXT NOT NULL, ts DOUBLE PRECISION NOT NULL)'
    )
    conn.execute('CREATE INDEX IF NOT EXISTS idx_rate_hits ON rate_hits (bucket, ts)')
    conn.execute(
        'CREATE TABLE IF NOT EXISTS user_notes ('
        'username TEXT PRIMARY KEY, enc_notes BYTEA NOT NULL, updated_at INTEGER NOT NULL, '
        'enc_blob BYTEA)'
    )
    conn.execute(
        'CREATE TABLE IF NOT EXISTS vault_meta ('
        'username TEXT NOT NULL, vault_id INTEGER NOT NULL DEFAULT 1, '
        'vault_name TEXT NOT NULL DEFAULT \'Vault\', '
        'salt_auth BYTEA NOT NULL, verifier BYTEA NOT NULL, '
        'salt_enc BYTEA NOT NULL, enc_dek BYTEA NOT NULL, created_at INTEGER NOT NULL, '
        'PRIMARY KEY (username, vault_id))'
    )
    # Multi-vault migration (max 3 per user, shared password): older single-key
    # tables carry one row per user with no vault_id/vault_name.
    try:
        vm_cols = _pg_columns(conn, 'vault_meta')
        if 'vault_id' not in vm_cols:
            conn.execute('ALTER TABLE vault_meta ADD COLUMN vault_id INTEGER NOT NULL DEFAULT 1')
        if 'vault_name' not in vm_cols:
            conn.execute('ALTER TABLE vault_meta ADD COLUMN vault_name TEXT NOT NULL DEFAULT \'Vault\'')
        # Widen a legacy single-column primary key to (username, vault_id).
        pk_cols = [row['column_name'] for row in conn.execute(
            "SELECT kcu.column_name FROM information_schema.table_constraints tc"
            " JOIN information_schema.key_column_usage kcu"
            " ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema"
            " WHERE tc.table_name = 'vault_meta' AND tc.constraint_type = 'PRIMARY KEY'"
            " ORDER BY kcu.ordinal_position")]
        if pk_cols == ['username']:
            conn.execute('ALTER TABLE vault_meta DROP CONSTRAINT vault_meta_pkey')
            conn.execute('ALTER TABLE vault_meta ADD PRIMARY KEY (username, vault_id)')
    except Exception as error:
        print(f'NOTELY MIGRATION: vault multi-key skipped: {error}', flush=True)
    # E2EE migration: add columns if missing.
    user_cols = _pg_columns(conn, 'users')
    for col, coltype in (('salt_auth', 'BYTEA'), ('salt_enc', 'BYTEA'), ('auth_hash', 'BYTEA'),
                         ('enc_master_key', 'BYTEA'), ('kdf', 'TEXT'), ('kdf_params', 'TEXT'),
                         ('auth_hash2', 'BYTEA')):
        if col not in user_cols:
            conn.execute(f'ALTER TABLE users ADD COLUMN {col} {coltype}')
    # Backfill: E2EE-PBKDF2 rows (wrapped key present, no descriptor yet).
    for row in conn.execute("SELECT username, iterations FROM users WHERE enc_master_key IS NOT NULL AND (kdf IS NULL OR kdf = '')"):
        conn.execute('UPDATE users SET kdf = %s, kdf_params = %s WHERE username = %s',
                     ('pbkdf2', json.dumps({'i': row['iterations'] or PBKDF2_ITERATIONS}), row['username']))
    notes_cols = _pg_columns(conn, 'user_notes')
    if 'enc_blob' not in notes_cols:
        conn.execute('ALTER TABLE user_notes ADD COLUMN enc_blob BYTEA')
    conn.execute(
        'CREATE TABLE IF NOT EXISTS user_notes_history ('
        'id SERIAL PRIMARY KEY, username TEXT NOT NULL, '
        'enc_blob BYTEA NOT NULL, updated_at INTEGER NOT NULL)'
    )
    conn.execute('CREATE INDEX IF NOT EXISTS idx_notes_hist_user ON user_notes_history (username, id)')
    conn.execute(
        'CREATE TABLE IF NOT EXISTS mfa_totp ('
        'username TEXT PRIMARY KEY, enc_secret BYTEA NOT NULL, '
        'confirmed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, '
        'last_used INTEGER NOT NULL DEFAULT 0)'
    )
    conn.execute(
        'CREATE TABLE IF NOT EXISTS mfa_challenges ('
        'ticket_hash TEXT PRIMARY KEY, username TEXT NOT NULL, '
        'expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)'
    )
    # Clean up legacy table (replaced by email_recovery below). Safe to drop
    # on every startup — no code references this table.
    conn.execute('DROP TABLE IF EXISTS recovery_codes')
    conn.execute(
        'CREATE TABLE IF NOT EXISTS email_recovery ('
        'token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, '
        'expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, used_at INTEGER)'
    )
    conn.execute('CREATE INDEX IF NOT EXISTS idx_email_recovery_user ON email_recovery (username)')
    conn.execute(
        'CREATE TABLE IF NOT EXISTS account_recovery ('
        'code_hash TEXT PRIMARY KEY, username TEXT NOT NULL, '
        'salt BYTEA NOT NULL, wrapped_key BYTEA NOT NULL, '
        'created_at INTEGER NOT NULL, used_at INTEGER)'
    )
    conn.execute('CREATE INDEX IF NOT EXISTS idx_acct_recovery_user ON account_recovery (username)')
    conn.execute(
        'CREATE TABLE IF NOT EXISTS passkey_creds ('
        'cred_id TEXT PRIMARY KEY, username TEXT NOT NULL, '
        'pubkey BYTEA NOT NULL, sign_count INTEGER NOT NULL DEFAULT 0, '
        'transports TEXT NOT NULL DEFAULT \'\', created_at INTEGER NOT NULL, '
        'prf_wrap BYTEA)'
    )
    conn.execute('CREATE INDEX IF NOT EXISTS idx_passkey_user ON passkey_creds (username)')
    conn.execute(
        'CREATE TABLE IF NOT EXISTS passkey_prf ('
        'username TEXT PRIMARY KEY, salt BYTEA NOT NULL, created_at INTEGER NOT NULL)'
    )
    conn.execute(
        'CREATE TABLE IF NOT EXISTS passkey_challenges ('
        'chash TEXT PRIMARY KEY, username TEXT NOT NULL, kind TEXT NOT NULL, '
        'expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)'
    )
    existing = {row['username'] for row in conn.execute('SELECT username FROM users')}
    for username, (first, last, subtitle) in BOOTSTRAP_PROFILES.items():
        if username in existing:
            continue
        password, source = bootstrap_password(username)
        ok, msg = validate_password(password)
        if not ok:
            raise RuntimeError(f'Bootstrap password for {username!r} violates password policy: {msg}')
        master_key = secrets.token_bytes(32)
        salt_auth = secrets.token_bytes(16)
        salt_enc = secrets.token_bytes(16)
        auth_hash = argon2id_raw(password, salt_auth)
        wrap_aesgcm = AESGCM(argon2id_raw(password, salt_enc))
        wrap_nonce = secrets.token_bytes(12)
        wrap_ct = wrap_aesgcm.encrypt(wrap_nonce, master_key, None)
        try:
            auth_hash2 = pepper_auth_hash(bytes(auth_hash))
        except Exception:
            auth_hash2 = None
        conn.execute(
            'INSERT INTO users (username, pwd_salt, pwd_hash, iterations, enc_profile, created_at,'
            ' salt_auth, salt_enc, auth_hash, enc_master_key, kdf, kdf_params, auth_hash2)'
            ' VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)',
            (
                username,
                b'', b'', 0,
                encrypt_profile({'firstName': first, 'lastName': last, 'subtitle': subtitle, 'email': ''}, username),
                int(time.time()),
                salt_auth, salt_enc, (None if auth_hash2 else auth_hash), wrap_nonce + wrap_ct,
                'argon2id', json.dumps(ARGON2_DESCRIPTOR), auth_hash2,
            ),
        )
        if source == 'generated':
            if sys.stdout.isatty():
                print(
                    f'NOTELY FIRST-RUN: generated password for {username!r}: {password} — '
                    'log in and change it immediately.',
                    flush=True,
                )
            else:
                cred_path = os.path.join(BASE_DIR, '.bootstrap-credentials')
                fd = os.open(cred_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                os.write(fd, (f'{username} {password}\n').encode('utf-8'))
                os.close(fd)
                print(
                    f'NOTELY FIRST-RUN: credentials for {username!r} written to '
                    f'0600 file {cred_path} (stdout is redirected). Change the password on first login.',
                    flush=True,
                )
    # Collaborative notes tables.
    conn.execute(
        'CREATE TABLE IF NOT EXISTS user_keys ('
        'username TEXT PRIMARY KEY, pubkey BYTEA NOT NULL, enc_priv BYTEA NOT NULL, '
        'algo TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, '
        'sig_pubkey BYTEA, sig_enc_priv BYTEA)'
    )
    conn.execute(
        'CREATE TABLE IF NOT EXISTS collab_groups ('
        'id SERIAL PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, '
        'created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, enc_meta BYTEA, '
        'key_version INTEGER NOT NULL DEFAULT 1, rekey_needed INTEGER NOT NULL DEFAULT 0)'
    )
    conn.execute(
        'CREATE TABLE IF NOT EXISTS collab_members ('
        'group_id INTEGER NOT NULL, username TEXT NOT NULL, wrapped_key BYTEA NOT NULL, '
        'eph_pub BYTEA NOT NULL, wrap_iv BYTEA NOT NULL, added_at INTEGER NOT NULL, '
        'accepted INTEGER NOT NULL DEFAULT 0, wrap_sig BYTEA, wrap_signer TEXT, '
        'key_version INTEGER NOT NULL DEFAULT 1, '
        'PRIMARY KEY (group_id, username))'
    )
    conn.execute(
        'CREATE TABLE IF NOT EXISTS collab_notes ('
        'id SERIAL PRIMARY KEY, group_id INTEGER NOT NULL, owner TEXT NOT NULL, '
        'created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, enc_state BYTEA, '
        'enc_meta BYTEA, key_version INTEGER NOT NULL DEFAULT 1)'
    )
    conn.execute(
        'CREATE TABLE IF NOT EXISTS collab_updates ('
        'id SERIAL PRIMARY KEY, note_id INTEGER NOT NULL, '
        'payload BYTEA NOT NULL, created_at INTEGER NOT NULL, '
        'key_version INTEGER NOT NULL DEFAULT 1)'
    )
    conn.execute('CREATE INDEX IF NOT EXISTS idx_collab_updates ON collab_updates (note_id, id)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_collab_members_user ON collab_members (username)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_collab_notes_group ON collab_notes (group_id, id)')
    conn.commit()
    conn.close()


# --- Automatic DB backups (pg_dump on a daemon thread) ---

def take_db_backup():
    """Take a PostgreSQL backup using pg_dump. Returns the final path, or None on failure."""
    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = time.strftime('%Y%m%d-%H%M%S', time.localtime())
    final_path = os.path.join(BACKUP_DIR, f'notely-{stamp}.sql.gz')
    try:
        import subprocess, gzip
        proc = subprocess.run(
            ['pg_dump', '--dbname=' + PG_DSN, '--format=plain'],
            capture_output=True, timeout=60,
        )
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.decode('utf-8', errors='replace'))
        with gzip.open(final_path, 'wb') as f:
            f.write(proc.stdout)
    except Exception as error:
        print(f'NOTELY BACKUP: failed: {error}', flush=True)
        try:
            os.remove(final_path)
        except OSError:
            pass
        return None
    _prune_old_backups()
    return final_path


# Keep only the newest BACKUP_KEEP timestamped copies.
def _prune_old_backups():
    try:
        names = sorted(n for n in os.listdir(BACKUP_DIR)
                       if n.startswith('notely-') and (n.endswith('.sql.gz') or n.endswith('.db')))
    except OSError:
        return
    for name in names[:-BACKUP_KEEP] if len(names) > BACKUP_KEEP else []:
        try:
            os.remove(os.path.join(BACKUP_DIR, name))
        except OSError:
            pass


# Daemon loop: sleep first (a fresh start needs no backup of an unchanged DB),
# then take one snapshot per interval and exit cleanly with the interpreter.
# NOTELY_BACKUP_INTERVAL_SECONDS=0 disables the thread entirely.
def _backup_loop():
    while True:
        time.sleep(max(1, BACKUP_INTERVAL_SECONDS))
        take_db_backup()


def start_backup_thread():
    if BACKUP_INTERVAL_SECONDS <= 0:
        print('NOTELY BACKUP: disabled (NOTELY_BACKUP_INTERVAL_SECONDS=0).', flush=True)
        return
    threading.Thread(target=_backup_loop, name='notely-backup', daemon=True).start()
    print(f'NOTELY BACKUP: every {BACKUP_INTERVAL_SECONDS}s, keeping {BACKUP_KEEP} '
          f'copies in {BACKUP_DIR}', flush=True)


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


# Record failure hits under an exclusive write lock, re-checking the ceiling
# inside the same transaction (pentest F-4: closes the check-then-act burst
# race where N concurrent requests all pass the pre-read and then each burn
# a hit). Once the ceiling is reached the event is dropped, not appended, so
# the bounded account/IP budget stays bounded under any concurrency.
def rate_fail_bounded(conn, buckets, max_n, window):
    now = time.time()
    try:
        # Use a PostgreSQL advisory lock to serialize rate-limit writes.
        # The lock key is derived from the first bucket name (stable, deterministic).
        lock_key = int(hashlib.md5(buckets[0].encode()).hexdigest()[:8], 16) if buckets else 0
        conn.execute('SELECT pg_advisory_lock(%s)', (lock_key,))
    except Exception:
        print(f'NOTELY: advisory lock failed for {buckets!r}, proceeding without lock', flush=True)
        lock_key = None
    try:
        _prune_rate_hits(conn, now, max(window, 3600))
        if not rate_exceeded(conn, buckets, max_n, window):
            for bucket in buckets:
                conn.execute('INSERT INTO rate_hits (bucket, ts) VALUES (%s, %s)', (bucket, now))
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
    finally:
        if lock_key is not None:
            try:
                conn.execute('SELECT pg_advisory_unlock(%s)', (lock_key,))
            except Exception:
                pass


def recovery_fail_bucket(username):
    """Per-account recovery-failure bucket (brute-force ceiling)."""
    try:
        return 'recovery-fail:' + str(username or '').strip().lower()
    except Exception:
        return 'recovery-fail:unknown'


def recovery_locked_out(conn, username):
    """True once an account has burned its hourly recovery guesses."""
    if not username:
        return False
    return rate_exceeded(conn, [recovery_fail_bucket(username)],
                         RECOVERY_MAX_FAILURES, RECOVERY_FAIL_WINDOW_SECONDS)


def recovery_note_failure(conn, username):
    """Count one failed recovery guess against the account ceiling."""
    if not username:
        return
    rate_hit(conn, recovery_fail_bucket(username))


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
    """True when the request looks cross-site (reject with 403).

    Compares the FULL origin: scheme, host and effective port. Comparing only
    the hostname let any other service on the same host (different port) or
    scheme forge state-changing requests.
    """
    try:
        if request.method not in ('POST', 'PUT', 'DELETE', 'PATCH'):
            return False
        if not request.path.startswith('/api/'):
            return False
        # Body-type layer (as documented): state-changing /api requests must
        # carry JSON (or have no body at all, e.g. logout). A classic
        # cross-site <form> POST is form-encoded, and fetch()-based forgeries
        # cannot legitimately send this origin's JSON either.
        content_type = (request.content_type or '').split(';')[0].strip().lower()
        if content_type and content_type != 'application/json' and content_type != 'application/json+structured':
            return True
        from urllib.parse import urlparse

        def _parts(url):
            try:
                parsed = urlparse(url)
                scheme = (parsed.scheme or '').lower()
                host = (parsed.hostname or '').lower()
                port = parsed.port
                if port is None:
                    port = 443 if scheme == 'https' else (80 if scheme == 'http' else None)
                return scheme, host, port
            except Exception:
                return '', '', None

        req_scheme, req_host, req_port = _parts(f'{request.scheme}://{request.host}')
        if not req_host:
            return True
        origin = request.headers.get('Origin')
        referer = request.headers.get('Referer')
        if origin:
            return _parts(origin) != (req_scheme, req_host, req_port)
        if referer:
            ref_scheme, ref_host, ref_port = _parts(referer)
            if not ref_host:
                return True
            return (ref_scheme, ref_host, ref_port) != (req_scheme, req_host, req_port)
        return False
    except Exception:
        # Fail closed (OWASP A10): an unexpected error while evaluating a
        # state-changing /api request must reject, not allow.
        return True


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
    try:
        row = conn.execute(
            'SELECT username, expires_at, created_at, last_seen FROM sessions WHERE token_hash = ?',
            (digest,),
        ).fetchone()
        if row and row['expires_at'] > now and (now - (row['last_seen'] or 0)) <= SESSION_IDLE_SECONDS:
            conn.execute('UPDATE sessions SET last_seen = ? WHERE token_hash = ?', (now, digest))
            conn.commit()
            user = conn.execute('SELECT username, enc_profile FROM users WHERE username = ?', (row['username'],)).fetchone()
            if user:
                try:
                    profile = decrypt_profile(user['enc_profile'], user['username'] if user else None)
                except Exception:
                    return None
                request._notely_session_due_rotation = (
                    int(row['created_at'] or 0) + SESSION_ROTATE_AFTER_SECONDS) <= int(time.time())
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
        return None
    finally:
        conn.close()


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


# --- Security audit logging + alerting (OWASP A09) -------------------------
# Structured JSONL of security-relevant events (auth outcomes, recovery, MFA,
# CSRF rejects, rate-limit trips, unhandled errors). Written append-only; the
# optional NOTELY_ALERT_WEBHOOK receives a POST for events at or above
# NOTELY_ALERT_MIN_SEVERITY (default 'high'). Callers pass identifiers only —
# never passwords, verifiers or key material.
AUDIT_LOG_PATH = os.environ.get('NOTELY_AUDIT_LOG', '/home/r3izu/Documents/audit/audit.log')
AUDIT_ENABLED = os.environ.get('NOTELY_AUDIT', '1').lower() != '0'
ALERT_WEBHOOK = os.environ.get('NOTELY_ALERT_WEBHOOK', '').strip()
try:
    from urllib.parse import urlparse as _awparse
    _aw = _awparse(ALERT_WEBHOOK) if ALERT_WEBHOOK else None
    if _aw is not None and _aw.scheme != 'https':
        print(f'NOTELY ALERT: NOTELY_ALERT_WEBHOOK must be https:// (got {_aw.scheme or "none"!r}) — webhook disabled.', flush=True)
        ALERT_WEBHOOK = ''
except Exception:
    ALERT_WEBHOOK = ''
ALERT_MIN_SEVERITY = os.environ.get('NOTELY_ALERT_MIN_SEVERITY', 'high').lower()
_SEVERITY_RANK = {'info': 0, 'warning': 1, 'high': 2, 'critical': 3}
AUDITED_ENDPOINTS = {
    '/api/login', '/api/register', '/api/change-password', '/api/upgrade-kdf',
    '/api/mfa/setup', '/api/mfa/confirm', '/api/mfa/disable', '/api/mfa/challenge',
    '/api/passkey/register-begin', '/api/passkey/register-finish',
    '/api/passkey/login-begin', '/api/passkey/login-finish', '/api/passkey/remove',
    '/api/recovery/email/start', '/api/recovery/email/complete',
    '/api/recovery/account/generate', '/api/recovery/account/lookup',
    '/api/recovery/account/reset', '/api/account', '/api/account/email', '/api/logout',
}


def security_event(event, severity='info', **fields):
    """Append one structured security event and optionally fire an alert.

    Must never raise into request handling. Values are serialised defensively
    and callers must not pass secrets."""
    if not AUDIT_ENABLED:
        return
    try:
        record = {'ts': int(time.time()), 'event': event, 'severity': severity}
        try:
            record['ip'] = request.remote_addr
        except Exception:
            pass
        record.update({key: value for key, value in fields.items() if value is not None})
        line = json.dumps(record, separators=(',', ':'), default=str)
        try:
            if not os.path.exists(AUDIT_LOG_PATH):
                # Create 0600: the audit log holds usernames/IPs, not secrets.
                try:
                    os.close(os.open(AUDIT_LOG_PATH, os.O_CREAT | os.O_WRONLY, 0o600))
                except Exception:
                    pass
            with open(AUDIT_LOG_PATH, 'a') as handle:
                handle.write(line + '\n')
        except Exception:
            # A failed audit write must be observable somewhere.
            try:
                print(f'NOTELY AUDIT WRITE FAILED: {event} ({severity})', file=sys.stderr, flush=True)
            except Exception:
                pass
        if ALERT_WEBHOOK and _SEVERITY_RANK.get(severity, 0) >= _SEVERITY_RANK.get(ALERT_MIN_SEVERITY, 2):
            try:
                import urllib.request
                req = urllib.request.Request(
                    ALERT_WEBHOOK, data=line.encode('utf-8'),
                    headers={'Content-Type': 'application/json'})
                urllib.request.urlopen(req, timeout=3)
            except Exception:
                pass
    except Exception:
        pass


@app.route('/')
def root():
    response = send_from_directory(BASE_DIR, 'index.html')
    # Never cache the app shell: stale HTML/JS is the classic "my fix did
    # nothing" trap during development.
    response.cache_control.no_store = True
    return response


@app.route('/<path:filename>')
def public_files(filename):
    # Vendored modules (argon2, qrcode, yjs + lib0) are served from vendor/.
    # The front-end is split into ES modules under js/ (entry: js/app.js).
    if filename in PUBLIC_FILES or filename.startswith('vendor/') or filename.startswith('js/'):
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
    # HSTS always (browsers ignore over HTTP; enforced over HTTPS). Two years,
    # matching current Mozilla TLSRef guidance.
    response.headers['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains'
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
        # unsafe-inline needed: CSP blocks event handlers/dom styles from the
        # dynamically-built strip/invite rows (element.style CSP-escaped),
        # and meta CSP now matches this value.
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "img-src 'self' https: data:; "
        "font-src 'self'; "
        "connect-src 'self'; "
        "frame-ancestors 'self'; "
        "frame-src 'none'; "
        "worker-src 'self'; "
        "manifest-src 'self'; "
        "media-src 'none'; "
        "base-uri 'self'; "
        "form-action 'self'; "
        "object-src 'none'; "
        "upgrade-insecure-requests"
    )
    return response


@app.after_request
def maybe_rotate_session(response):
    # Central rotation: any authorized /api response whose session is due rotates
    # its cookie on that response (not only /api/me polls).
    due = getattr(request, '_notely_session_due_rotation', None)
    if not due or not request.path.startswith('/api/') or request.method not in ('GET', 'POST', 'PUT', 'DELETE'):
        return response
    if response.status_code >= 400:
        return response
    user = current_session_user()
    if not user:
        request._notely_session_due_rotation = None
        return response
    conn = get_db()
    try:
        token, digest = rotate_session_if_due(conn, user, int(time.time()))
    finally:
        conn.close()
    if token:
        set_session_cookie(response, token)
    request._notely_session_due_rotation = None
    return response


@app.after_request
def audit_trail(response):
    """Audit auth/security endpoint outcomes (OWASP A09). Username is read from
    the cached JSON body when present; the body is never re-parsed twice."""
    try:
        if request.path in AUDITED_ENDPOINTS:
            severity = 'info' if response.status_code < 400 else 'warning'
            event = 'auth.' + request.path[len('/api/'):].replace('/', '.')
            username = None
            try:
                payload = request.get_json(silent=True)
                if isinstance(payload, dict):
                    username = payload.get('username')
            except Exception:
                username = None
            security_event(event, severity=severity, status=response.status_code,
                           method=request.method, username=username)
        elif request.path.startswith('/api/') and response.status_code == 429:
            security_event('rate_limit.blocked', severity='warning', path=request.path)
    except Exception:
        pass
    return response


@app.before_request
def csrf_protect():
    if csrf_check_failed():
        security_event('csrf.rejected', severity='warning',
                       method=request.method, path=request.path)
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


@app.errorhandler(Exception)
def unhandled_exception(error):
    """Log unexpected exceptions (A09/A10) and never leak internals.

    HTTPExceptions (404/405/413/etc.) are re-dispatched to their own handlers;
    everything else becomes a generic 500 with an audit event."""
    from werkzeug.exceptions import HTTPException
    if isinstance(error, HTTPException):
        return error
    security_event('error.unhandled', severity='high', path=request.path,
                   method=request.method, error=type(error).__name__)
    return jsonify({'error': 'Internal server error.'}), 500


# NOTE: unknown usernames get per-name dummy salts from dummy_kdf_salt_for()
# (defined near the top with the other KDF helpers). There is deliberately no
# global dummy constant anymore: one shared value let attackers enumerate
# accounts by equality (see pentest finding #1).


@app.route('/api/kdf-params', methods=['GET'])
def api_kdf_params():
    """Public key-derivation parameters for a username (safe to expose).

    E2EE accounts get their real salts; legacy and unknown names get an
    identical shape with dummy values so callers cannot distinguish them.
    """
    # Pentest F-5: legacy (pre-E2EE) accounts are still structurally
    # distinguishable here (the legacy shape is needed so their client sends
    # the password for transparent upgrade on next login). Blunt mass
    # enumeration with a generous per-IP budget — real logins fetch this once
    # per attempt, so 120/15min is far above human need.
    conn0 = get_db()
    if rate_exceeded(conn0, [ip_bucket('kdfparams')], 120, 900):
        conn0.close()
        return jsonify({'error': 'Too many attempts — try again in a few minutes.'}), 429
    rate_hit(conn0, ip_bucket('kdfparams'))
    conn0.close()
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
    try:
        auth_hash2 = pepper_auth_hash(bytes(auth_hash))
    except Exception:
        auth_hash2 = None
    conn.execute(
        'UPDATE users SET pwd_salt = ?, pwd_hash = ?, iterations = ?,'
        ' salt_auth = ?, salt_enc = ?, auth_hash = ?, enc_master_key = ?,'
        " kdf = 'argon2id', kdf_params = ?, auth_hash2 = ?"
        ' WHERE username = ?',
        (b'', b'', 0, salt_auth, salt_enc, (None if auth_hash2 else auth_hash),
         wrap_nonce + wrap_ct, json.dumps(ARGON2_DESCRIPTOR), auth_hash2, username),
    )
    notes_row = conn.execute('SELECT enc_notes FROM user_notes WHERE username = ?', (username,)).fetchone()
    if notes_row and notes_row['enc_notes']:
        try:
            plaintext_notes = decrypt_notes(bytes(notes_row['enc_notes']), username)
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
        rate_fail_bounded(conn, [ip_bucket('login')], LOGIN_MAX_FAILURES, LOGIN_WINDOW_SECONDS)
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
            rate_fail_bounded(conn, [ip_bucket('login'), user_bucket], LOGIN_MAX_FAILURES, LOGIN_WINDOW_SECONDS)
            conn.close()
            return jsonify({'error': 'Incorrect username or password.'}), 401
        ok = verify_auth_hash(candidate, user)
        if not ok:
            # Burn equal PBKDF2 work so a wrong verifier on a real account
            # costs the same as an unknown-user attempt (timing-oracle fix).
            hashlib.pbkdf2_hmac('sha256', secrets.token_bytes(16), _DUMMY_SALT, PBKDF2_ITERATIONS)
            rate_fail_bounded(conn, [ip_bucket('login'), user_bucket], LOGIN_MAX_FAILURES, LOGIN_WINDOW_SECONDS)
            conn.close()
            return jsonify({'error': 'Incorrect username or password.'}), 401
        # Non-breaking pepper upgrade: raw -> peppered on successful login, then
        # drop the raw verifier (M-4: no replayable bearer token at rest).
        try:
            if ok == 'raw':
                conn.execute('UPDATE users SET auth_hash2 = ?, auth_hash = NULL WHERE username = ?',
                             (pepper_auth_hash(bytes(candidate)), username))
        except Exception:
            pass
        # MFA gate (non-breaking: only if user enrolled+confirmed). Returns
        # 202 + ticket instead of session; old clients for non-MFA users see
        # byte-identical 200 as before.
        try:
            mfa = conn.execute('SELECT confirmed FROM mfa_totp WHERE username = ?',
                               (username,)).fetchone()
            mfa_on = bool(mfa and mfa['confirmed'])
        except Exception:
            mfa_on = False
        if mfa_on:
            ticket = issue_mfa_ticket(conn, username)
            try:
                profile = decrypt_profile(user['enc_profile'], user['username'] if user else None)
            except Exception:
                conn.close()
                return jsonify({'error': 'Login failed.'}), 500
            conn.close()
            return jsonify({
                'mfaRequired': True,
                'mfaTicket': ticket,
                'username': username, **profile,
                'kdf': (user['kdf'] or 'pbkdf2'),
                'saltEnc': base64.b64encode(bytes(user['salt_enc'])).decode('ascii'),
                'iterations': user['iterations'] or PBKDF2_ITERATIONS,
                'encMasterKey': enc_master_key_parts(user['enc_master_key']),
            }), 202
        try:
            profile = decrypt_profile(user['enc_profile'], user['username'] if user else None)
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
        rate_fail_bounded(conn, [ip_bucket('login')], LOGIN_MAX_FAILURES, LOGIN_WINDOW_SECONDS)
        conn.close()
        return jsonify({'error': 'Incorrect username or password.'}), 401
    if user and not is_e2ee_account(user):
        ok = verify_password(password, user['pwd_salt'], user['pwd_hash'], user['iterations'])
    else:
        # Unknown user: burn the same PBKDF2 cost, then fail closed.
        # Unencodable passwords (e.g. lone surrogates) fail closed too
        # instead of escaping as a 500.
        try:
            hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), _DUMMY_SALT, PBKDF2_ITERATIONS)
        except Exception:
            pass
        ok = False
    if not ok:
        rate_fail_bounded(conn, [ip_bucket('login'), user_bucket], LOGIN_MAX_FAILURES, LOGIN_WINDOW_SECONDS)
        conn.close()
        return jsonify({'error': 'Incorrect username or password.'}), 401
    # Legacy account with a correct password: transparently upgrade to E2EE.
    bundle = upgrade_legacy_account(conn, username, password)
    try:
        profile = decrypt_profile(user['enc_profile'], user['username'] if user else None)
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
    email = str(data.get('email', '')).strip()[:254]
    first = str(data.get('firstName', '')).strip()[:40]
    last = str(data.get('lastName', '')).strip()[:40]
    if not validate_username(username):
        rate_hit(conn, ip_bucket('register'))
        conn.close()
        return jsonify({'error': 'Username must be 3-32 chars: letters, numbers, _ or -.'}), 400
    if not validate_email(email) or not email:
        rate_hit(conn, ip_bucket('register'))
        conn.close()
        return jsonify({'error': 'A valid email address is required.'}), 400
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
    # verifier against the bounded weak-password list plus guesses derived from
    # the account's own identifiers (see is_weak_verifier). Strong passwords
    # learn nothing; weak ones are rejected with the same 400 as other policy
    # failures. Client-side passwordPolicyCheck remains the primary gate.
    if is_weak_verifier(auth_hash, salt_auth, identity_password_candidates(username, email, first, last)):
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
    try:
        auth_hash2 = pepper_auth_hash(bytes(auth_hash))
    except Exception:
        auth_hash2 = None
    try:
        conn.execute(
            'INSERT INTO users (username, pwd_salt, pwd_hash, iterations, enc_profile, created_at,'
            ' salt_auth, salt_enc, auth_hash, enc_master_key, kdf, kdf_params, auth_hash2)'
            ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (username, b'', b'', 0,
             encrypt_profile({'firstName': first, 'lastName': last, 'subtitle': 'Notely User', 'email': email}, username),
             int(time.time()), salt_auth, salt_enc, (None if auth_hash2 else auth_hash), wrap_iv + wrap_ct,
             'argon2id', json.dumps(ARGON2_DESCRIPTOR), auth_hash2),
        )
        conn.commit()
    except psycopg2.IntegrityError:
        # Concurrent registration of the same username: answer exactly like the
        # pre-check path (uniform 202) instead of a 500, and never leak the
        # connection/lock.
        conn.close()
        return jsonify({
            'ok': True,
            'message': 'If the username is available, the account was created. You can now log in.',
        }), 202
    finally:
        try:
            conn.close()
        except Exception:
            pass
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
        if new_kdf != 'argon2id' or not valid_argon2_params(new_params) or not verify_auth_hash(current_auth, row):
            rate_hit(conn, ip_bucket('pwchange'))
            rate_hit(conn, 'pwchange:' + user['username'].lower())
            conn.close()
            return jsonify({'error': 'Current password is incorrect.'}), 401
        if is_weak_verifier(new_auth, new_salt_auth, identity_password_candidates(user['username'])):
            conn.close()
            return jsonify({'error': 'New password too weak: choose a longer, less common password.'}), 400
        try:
            new_hash2 = pepper_auth_hash(bytes(new_auth))
        except Exception:
            new_hash2 = None
        conn.execute(
            'UPDATE users SET salt_auth = ?, salt_enc = ?, auth_hash = ?, enc_master_key = ?,'
            " kdf = 'argon2id', kdf_params = ?, auth_hash2 = ?"
            ' WHERE username = ?',
            (new_salt_auth, new_salt_enc, (None if new_hash2 else new_auth), new_wrap_iv + new_wrap_ct,
             json.dumps(ARGON2_DESCRIPTOR), new_hash2, user['username']),
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
    if new_kdf != 'argon2id' or not valid_argon2_params(new_params) or not verify_auth_hash(old_auth, row):
        rate_hit(conn, ip_bucket('upgrade'))
        rate_hit(conn, 'upgrade:user:' + user['username'].lower())
        conn.close()
        return jsonify({'error': 'Upgrade rejected.'}), 401
    try:
        up_hash2 = pepper_auth_hash(bytes(new_auth))
    except Exception:
        up_hash2 = None
    conn.execute(
        'UPDATE users SET salt_auth = ?, salt_enc = ?, auth_hash = ?, enc_master_key = ?,'
        " kdf = 'argon2id', kdf_params = ?, auth_hash2 = ?"
        ' WHERE username = ?',
        (new_salt_auth, new_salt_enc, (None if up_hash2 else new_auth), new_wrap_iv + new_wrap_ct,
         json.dumps(ARGON2_DESCRIPTOR), up_hash2, user['username']),
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
        notes = decrypt_notes(legacy, user['username'])
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
    try:
        if int(base_version) != int(cur_version or 0):
            conn.close()
            return jsonify({'error': 'Notes changed on server — reload and retry.',
                            'updated_at': int(cur_version or 0)}), 409
    except (ValueError, TypeError):
        conn.close()
        return jsonify({'error': 'Invalid baseVersion.'}), 400
    row = conn.execute('SELECT salt_auth, auth_hash, auth_hash2, salt_enc, enc_master_key FROM users WHERE username = ?',
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
        (user['username'], encrypt_notes(cleaned, user['username']), now, b''),
    )
    rate_hit(conn, 'notes:' + user['username'].lower())
    conn.commit()
    conn.close()
    return jsonify({'ok': True, 'updated_at': now})


# Shared proof check for vault overwrite (POST) and reset (DELETE).
#
# Why it exists: the session cookie alone must never be enough to destroy the
# vault (stolen-cookie DoS). The caller proves password knowledge with EITHER:
#   * currentVaultAuth — the existing vault verifier (knows vault password), or
#   * currentAccountAuth — the login verifier (knows login password, e.g. the
#     forgot-vault-password reset path).
# Returns True only on a constant-time match. Never raises.
def vault_proof_ok(conn, username, data, vault_verifier):
    """Check vault/account password proof from a vault-meta request body."""
    try:
        cur_vault = data.get('currentVaultAuth')
        cur_acct = data.get('currentAccountAuth')
        if cur_vault is not None:
            try:
                if hmac.compare_digest(b64decode_strict(cur_vault, 32), bytes(vault_verifier)):
                    return True
            except ValueError:
                pass
        if cur_acct is not None:
            acct = conn.execute('SELECT auth_hash, auth_hash2 FROM users WHERE username = ?',
                                (username,)).fetchone()
            if acct is not None and (acct['auth_hash'] or acct['auth_hash2']):
                try:
                    if verify_auth_hash(b64decode_strict(cur_acct, 32), acct):
                        return True
                except ValueError:
                    pass
    except Exception:
        pass
    return False


VAULT_MAX_PER_USER = 3


def _vault_row_payload(row):
    return {
        'id': row['vault_id'],
        'name': row['vault_name'] or 'Vault',
        'saltAuth': base64.b64encode(bytes(row['salt_auth'])).decode('ascii'),
        'verifier': base64.b64encode(bytes(row['verifier'])).decode('ascii'),
        'saltEnc': base64.b64encode(bytes(row['salt_enc'])).decode('ascii'),
        'encDek': {
            'iv': base64.b64encode(bytes(row['enc_dek'])[:12]).decode('ascii'),
            'data': base64.b64encode(bytes(row['enc_dek'])[12:]).decode('ascii'),
        },
    }


@app.route('/api/vault-meta', methods=['GET'])
def api_vault_meta_get():
    """Return every vault's verifier material (salts + wrapped key) for unlocking.
    Verification itself happens client-side, so unlocking costs the server
    nothing and reveals nothing beyond what the session already proves.
    Rate-limited to slow offline brute-force against the vault password."""
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    # Throttle vault-meta fetches to limit offline brute-force attempts
    # against the vault verifier (unlock is client-side, unthrottled by design,
    # but repeated server fetches can be gated to raise the bar).
    if rate_exceeded(conn, [ip_bucket('vault'), 'vault:' + user['username'].lower()],
                     CHANGE_MAX_FAILURES, CHANGE_WINDOW_SECONDS):
        conn.close()
        return jsonify({'error': 'Too many attempts — try again in a few minutes.'}), 429
    rate_hit(conn, ip_bucket('vault'))
    rate_hit(conn, 'vault:' + user['username'].lower())
    rows = conn.execute('SELECT vault_id, vault_name, salt_auth, verifier, salt_enc, enc_dek'
                        ' FROM vault_meta WHERE username = ? ORDER BY vault_id',
                        (user['username'],)).fetchall()
    conn.close()
    if not rows:
        return jsonify({'exists': False, 'vaults': []})
    return jsonify({'exists': True, 'vaults': [_vault_row_payload(row) for row in rows]})


@app.route('/api/vault-meta', methods=['POST'])
def api_vault_meta_set():
    """Create vaults (up to VAULT_MAX_PER_USER sharing one password).
    First vault: full verifier material, no proof needed (weak-screened).
    Additional vaults: the client reuses the existing salts and proves the
    shared password (currentVaultAuth) or the login (currentAccountAuth);
    only a fresh wrapped DEK is stored — salts/verifier are copied from vault 1
    so the password stays single. Overwriting vault 1 keeps the old proof rule.
    Sizes are strictly validated; the password itself never arrives."""
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    if rate_exceeded(conn, [ip_bucket('vault'), 'vault:' + user['username'].lower()], CHANGE_MAX_FAILURES, CHANGE_WINDOW_SECONDS):
        conn.close()
        return jsonify({'error': 'Too many attempts — try again in a few minutes.'}), 429
    data = request.get_json(silent=True) or {}
    try:
        wrap = data.get('encDek') or {}
        wrap_iv = b64decode_strict(wrap.get('iv'), 12)
        wrap_ct = b64decode_strict(wrap.get('data'), 48)
    except (ValueError, AttributeError):
        conn.close()
        return jsonify({'error': 'Invalid vault payload.'}), 400
    existing = conn.execute('SELECT vault_id, verifier, salt_auth, salt_enc FROM vault_meta'
                            ' WHERE username = ? ORDER BY vault_id',
                            (user['username'],)).fetchall()
    now = int(time.time())
    if not existing:
        # First vault: full verifier material required.
        try:
            verifier = b64decode_strict(data.get('verifier'), 32)
            salt_auth = b64decode_strict(data.get('saltAuth'), 16)
            salt_enc = b64decode_strict(data.get('saltEnc'), 16)
        except (ValueError, AttributeError):
            conn.close()
            return jsonify({'error': 'Invalid vault payload.'}), 400
        # Server-side weak-password screen for the vault verifier. The vault
        # password never reaches the server, but a trivially weak one can be
        # rejected here (same tiny-dictionary check as account registration).
        if is_weak_vault_verifier(verifier, salt_auth):
            rate_hit(conn, ip_bucket('vault'))
            rate_hit(conn, 'vault:' + user['username'].lower())
            conn.close()
            return jsonify({'error': 'Vault password too weak: choose a longer, less common password.'}), 400
        name = str(data.get('name') or 'Vault').strip()[:40] or 'Vault'
        conn.execute(
            'INSERT INTO vault_meta (username, vault_id, vault_name, salt_auth, verifier, salt_enc, enc_dek, created_at)'
            ' VALUES (?, 1, ?, ?, ?, ?, ?, ?)',
            (user['username'], name, salt_auth, verifier, salt_enc, wrap_iv + wrap_ct, now),
        )
        conn.commit()
        conn.close()
        return jsonify({'ok': True, 'id': 1})
    # Additional vault (shared password): proof required, max enforced.
    if len(existing) >= VAULT_MAX_PER_USER:
        conn.close()
        return jsonify({'error': f'Maximum of {VAULT_MAX_PER_USER} vaults.'}), 409
    if not vault_proof_ok(conn, user['username'], data, existing[0]['verifier']):
        rate_hit(conn, ip_bucket('vault'))
        rate_hit(conn, 'vault:' + user['username'].lower())
        conn.close()
        return jsonify({'error': 'Vault creation requires current vault or account password proof.'}), 401
    # Pentest F-53: belt-and-braces — since vault-1's verifier/salts are
    # copied verbatim into additional vaults, the additional-vault password
    # IS the shared vetted one. Re-screening here would only add cost for
    # zero benefit (the verifier is the same). This comment documents the
    # design decision so future maintainers know the screen IS omitted
    # deliberately on additional vaults because the shared verifier was
    # weak-screened at vault-1 creation time.
    first = existing[0]
    new_id = max(int(row['vault_id']) for row in existing) + 1
    conn.execute(
        'INSERT INTO vault_meta (username, vault_id, vault_name, salt_auth, verifier, salt_enc, enc_dek, created_at)'
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        (user['username'], new_id, name,
         bytes(first['salt_auth']), bytes(first['verifier']), bytes(first['salt_enc']),
         wrap_iv + wrap_ct, now),
    )
    conn.commit()
    conn.close()
    return jsonify({'ok': True, 'id': new_id})


@app.route('/api/vault-meta', methods=['DELETE'])
def api_vault_meta_delete():
    """Reset vaults: full reset AND single-vault delete both require password
    proof (F-52 restores the F-33 posture: stolen cookie never wipes a vault)."""
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    if rate_exceeded(conn, [ip_bucket('vault'), 'vault:' + user['username'].lower()], CHANGE_MAX_FAILURES, CHANGE_WINDOW_SECONDS):
        conn.close()
        return jsonify({'error': 'Too many attempts — try again in a few minutes.'}), 429
    existing = conn.execute('SELECT vault_id, verifier FROM vault_meta WHERE username = ? ORDER BY vault_id',
                            (user['username'],)).fetchall()
    if not existing:
        conn.close()
        return jsonify({'ok': True})
    data = request.get_json(silent=True) or {}
    try:
        vault_id = int(data.get('vaultId')) if data.get('vaultId') is not None else None
    except (TypeError, ValueError):
        vault_id = None
    # Pentest F-52 (round-13 remediation): ALL vault deletions now require
    # password proof — the previous session-only single-vault-delete allowed
    # a stolen cookie to silently wipe one vault. Proof uses the shared
    # verifier (inherited across vaults, so any one will match).
    proof_target = None
    for row in existing:
        if vault_id is None or int(row['vault_id']) == vault_id:
            proof_target = row['verifier']
            break
    if proof_target is None:
        proof_target = existing[0]['verifier']
    if not vault_proof_ok(conn, user['username'], data, proof_target):
        rate_hit(conn, ip_bucket('vault'))
        rate_hit(conn, 'vault:' + user['username'].lower())
        conn.close()
        return jsonify({'error': 'Vault deletion requires current vault or account password proof.'}), 401
    rate_hit(conn, ip_bucket('vault'))
    rate_hit(conn, 'vault:' + user['username'].lower())
    if vault_id is not None:
        conn.execute('DELETE FROM vault_meta WHERE username = ? AND vault_id = ?',
                     (user['username'], vault_id))
    else:
        conn.execute('DELETE FROM vault_meta WHERE username = ?', (user['username'],))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/vault-meta', methods=['PATCH'])
def api_vault_meta_rename():
    """Rename a vault. Requires the vault ID and a new name (1-40 chars).
    No password proof needed — the session itself is sufficient."""
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    if rate_exceeded(conn, [ip_bucket('vault'), 'vault:' + user['username'].lower()], CHANGE_MAX_FAILURES, CHANGE_WINDOW_SECONDS):
        conn.close()
        return jsonify({'error': 'Too many attempts — try again in a few minutes.'}), 429
    data = request.get_json(silent=True) or {}
    try:
        vault_id = int(data.get('vaultId'))
    except (TypeError, ValueError):
        conn.close()
        return jsonify({'error': 'Invalid vault ID.'}), 400
    name = str(data.get('name') or '').strip()[:40]
    if not name:
        conn.close()
        return jsonify({'error': 'Vault name cannot be empty.'}), 400
    existing = conn.execute('SELECT vault_id FROM vault_meta WHERE username = ? AND vault_id = ?',
                            (user['username'], vault_id)).fetchone()
    if not existing:
        conn.close()
        return jsonify({'error': 'Vault not found.'}), 404
    rate_hit(conn, ip_bucket('vault'))
    rate_hit(conn, 'vault:' + user['username'].lower())
    conn.execute('UPDATE vault_meta SET vault_name = ? WHERE username = ? AND vault_id = ?',
                 (name, user['username'], vault_id))
    conn.commit()
    conn.close()
    return jsonify({'ok': True, 'id': vault_id, 'name': name})
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


@app.route('/api/mfa/status', methods=['GET'])
def api_mfa_status():
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    row = conn.execute('SELECT confirmed FROM mfa_totp WHERE username = ?',
                       (user['username'],)).fetchone()
    conn.close()
    return jsonify({'enabled': bool(row and row['confirmed'])})


@app.route('/api/mfa/setup', methods=['POST'])
def api_mfa_setup():
    """Start TOTP enrolment: returns otpauth URI + secret (once). Overwrites
    unconfirmed setup; confirmed MFA must be disabled first."""
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    if rate_exceeded(conn, [ip_bucket('mfa'), 'mfa:' + user['username'].lower()], CHANGE_MAX_FAILURES, CHANGE_WINDOW_SECONDS):
        conn.close()
        return jsonify({'error': 'Too many attempts — try again in a few minutes.'}), 429
    existing = conn.execute('SELECT confirmed FROM mfa_totp WHERE username = ?',
                            (user['username'],)).fetchone()
    if existing and existing['confirmed']:
        conn.close()
        return jsonify({'error': 'MFA already enabled. Disable first to re-enrol.'}), 409
    secret = secrets.token_bytes(20)
    conn.execute(
        'INSERT INTO mfa_totp (username, enc_secret, confirmed, created_at, last_used)'
        ' VALUES (?, ?, 0, ?, 0)'
        ' ON CONFLICT(username) DO UPDATE SET enc_secret = excluded.enc_secret,'
        ' confirmed = 0, created_at = excluded.created_at',
        (user['username'], encrypt_blob(secret, blob_aad('mfa-secret', user['username'])), int(time.time())),
    )
    conn.commit()
    conn.close()
    b32 = base64.b32encode(secret).decode('ascii')
    uri = f'otpauth://totp/Notely:{user["username"]}?secret={b32}&issuer=Notely&digits=6&period=30'
    return jsonify({'secret': b32, 'otpauth': uri})


@app.route('/api/mfa/confirm', methods=['POST'])
def api_mfa_confirm():
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    data = json_object()
    code = str(data.get('code', '')).strip()
    conn = get_db()
    # Brute-force gate: 6-digit codes fall fast without one, even though a
    # valid session is already required to reach here.
    if rate_exceeded(conn, [ip_bucket('mfa'), 'mfa:' + user['username'].lower()], CHANGE_MAX_FAILURES, CHANGE_WINDOW_SECONDS):
        conn.close()
        return jsonify({'error': 'Too many attempts — try again in a few minutes.'}), 429
    row = conn.execute('SELECT enc_secret, confirmed FROM mfa_totp WHERE username = ?',
                       (user['username'],)).fetchone()
    if not row:
        conn.close()
        return jsonify({'error': 'No MFA setup in progress.'}), 409
    try:
        secret = bytes(decrypt_blob(bytes(row['enc_secret']), blob_aad('mfa-secret', user['username'])))
    except Exception:
        conn.close()
        return jsonify({'error': 'MFA setup corrupted. Restart enrolment.'}), 500
    if not totp_verify(secret, code):
        rate_hit(conn, ip_bucket('mfa'))
        rate_hit(conn, 'mfa:' + user['username'].lower())
        conn.close()
        return jsonify({'error': 'Incorrect code.'}), 401
    conn.execute('UPDATE mfa_totp SET confirmed = 1 WHERE username = ?', (user['username'],))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/mfa/disable', methods=['POST'])
def api_mfa_disable():
    """Disable MFA: requires session + current TOTP code. Lost device? Use
    account recovery (email/recovery code), which clears MFA as well."""
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    data = json_object()
    conn = get_db()
    row = conn.execute('SELECT enc_secret FROM mfa_totp WHERE username = ?',
                       (user['username'],)).fetchone()
    if not row:
        conn.close()
        return jsonify({'ok': True})
    try:
        secret = bytes(decrypt_blob(bytes(row['enc_secret']), blob_aad('mfa-secret', user['username'])))
    except Exception:
        secret = None
    if not (secret and totp_verify(secret, str(data.get('code', '')))):
        rate_hit(conn, ip_bucket('mfa'))
        conn.close()
        return jsonify({'error': 'MFA proof required.'}), 401
    conn.execute('DELETE FROM mfa_totp WHERE username = ?', (user['username'],))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/mfa/challenge', methods=['POST'])
def api_mfa_challenge():
    """Complete password-first login: {ticket, code} -> session. Lost device?
    Recover the account instead (it clears MFA)."""
    data = json_object()
    ticket = str(data.get('ticket', '') or data.get('mfaTicket', ''))
    if not ticket or len(ticket) > 256:
        return jsonify({'error': 'Invalid ticket.'}), 400
    digest = hashlib.sha256(ticket.encode('utf-8')).hexdigest()
    conn = get_db()
    row = conn.execute('SELECT username, expires_at FROM mfa_challenges WHERE ticket_hash = ?',
                       (digest,)).fetchone()
    if not row or row['expires_at'] < int(time.time()):
        if row:
            conn.execute('DELETE FROM mfa_challenges WHERE ticket_hash = ?', (digest,))
            conn.commit()
        conn.close()
        return jsonify({'error': 'Ticket expired. Log in again.'}), 401
    # Per-account fail ceiling (distributed-guessing fix): the IP throttle
    # alone lets a botnet parallelize 6-digit guesses. Each wrong code for
    # this account burns one slot from the shared 5/15-min budget.
    user_mfa_bucket = 'mfa:user:' + str(row['username'] or '').strip().lower()
    if rate_exceeded(conn, [user_mfa_bucket], CHANGE_MAX_FAILURES, CHANGE_WINDOW_SECONDS):
        conn.close()
        return jsonify({'error': 'Too many attempts — try again in a few minutes.'}), 429
    username = row['username']
    mfa = conn.execute('SELECT enc_secret, confirmed FROM mfa_totp WHERE username = ?',
                       (username,)).fetchone()
    if not mfa or not mfa['confirmed']:
        conn.execute('DELETE FROM mfa_challenges WHERE ticket_hash = ?', (digest,))
        conn.commit()
        conn.close()
        return jsonify({'error': 'MFA not enabled.'}), 409
    try:
        secret = bytes(decrypt_blob(bytes(mfa['enc_secret']), blob_aad('mfa-secret', mfa['username'] if 'username' in mfa.keys() else None)))
    except Exception:
        conn.close()
        return jsonify({'error': 'MFA error.'}), 500
    ok = totp_verify(secret, str(data.get('code', '')))
    if not ok:
        rate_fail_bounded(conn, [ip_bucket('mfa'), user_mfa_bucket],
                          CHANGE_MAX_FAILURES, CHANGE_WINDOW_SECONDS)
        conn.close()
        return jsonify({'error': 'Incorrect code.'}), 401
    # Single-use, race-safe (pentest F-4): consume the ticket atomically.
    # With N concurrent requests presenting the same ticket, exactly one
    # DELETE reports rowcount 1; all others are rejected instead of each
    # minting their own session.
    consumed = conn.execute('DELETE FROM mfa_challenges WHERE ticket_hash = ?', (digest,))
    if consumed.rowcount != 1:
        conn.rollback()
        conn.close()
        return jsonify({'error': 'Ticket expired. Log in again.'}), 401
    try:
        conn.execute('UPDATE mfa_totp SET last_used = ? WHERE username = ?', (int(time.time()), username))
    except Exception:
        pass
    user = conn.execute('SELECT username, enc_profile FROM users WHERE username = ?', (username,)).fetchone()
    if not user:
        conn.commit()
        conn.close()
        return jsonify({'error': 'Login failed.'}), 500
    try:
        profile = decrypt_profile(user['enc_profile'], user['username'] if user else None)
    except Exception:
        conn.commit()
        conn.close()
        return jsonify({'error': 'Login failed.'}), 500
    now = int(time.time())
    token, _d = issue_session_token(conn, username, now)
    conn.commit()
    conn.close()
    resp = jsonify({'username': username, **profile})
    return set_session_cookie(resp, token)


@app.route('/api/passkey/register-begin', methods=['POST'])
def api_passkey_register_begin():
    """Begin passkey enrolment (authed). Returns creation options (none attested)."""
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    if rate_exceeded(conn, [ip_bucket('passkey'), 'passkey:' + user['username'].lower()], CHANGE_MAX_FAILURES, CHANGE_WINDOW_SECONDS):
        conn.close()
        return jsonify({'error': 'Too many attempts — try again in a few minutes.'}), 429
    rp_id = webauthn_rp_id()
    if not rp_id:
        conn.close()
        return jsonify({'error': 'Cannot determine RP ID.'}), 500
    challenge = secrets.token_bytes(32)
    now = int(time.time())
    conn.execute('DELETE FROM passkey_challenges WHERE expires_at < ?', (now,))
    conn.execute(
        'INSERT INTO passkey_challenges (chash, username, kind, expires_at, created_at)'
        ' VALUES (?, ?, ?, ?, ?)',
        (hashlib.sha256(challenge).hexdigest(), user['username'], 'reg', now + PASSKEY_CHALLENGE_TTL_SECONDS, now),
    )
    conn.commit()
    existing = conn.execute('SELECT cred_id, transports FROM passkey_creds WHERE username = ?',
                            (user['username'],)).fetchall()
    # PRF salt for passwordless unlock: one per user, created once. The client
    # asks the authenticator to evaluate it; the resulting secret never leaves
    # the device and wraps a copy of the master key (see register-finish).
    prf_row = conn.execute('SELECT salt FROM passkey_prf WHERE username = ?',
                           (user['username'],)).fetchone()
    if prf_row:
        prf_salt = bytes(prf_row['salt'])
    else:
        prf_salt = secrets.token_bytes(32)
        conn.execute('INSERT INTO passkey_prf (username, salt, created_at) VALUES (?, ?, ?)',
                     (user['username'], prf_salt, int(time.time())))
        conn.commit()
    conn.close()
    user_handle = b64url_encode(hashlib.sha256(b'notely-user-v1:' + user['username'].lower().encode('utf-8')).digest())
    return jsonify({
        'challenge': b64url_encode(challenge),
        'rp': {'name': 'Notely', 'id': rp_id},
        'user': {'id': user_handle, 'name': user['username'], 'displayName': user['username']},
        'pubKeyCredParams': [{'type': 'public-key', 'alg': -7}],
        'timeout': 60000,
        'attestation': 'none',
        'authenticatorSelection': {'userVerification': 'preferred'},
        'excludeCredentials': [{'type': 'public-key', 'id': row['cred_id']} for row in existing],
        'prfSalt': b64url_encode(prf_salt),
    })


@app.route('/api/passkey/register-finish', methods=['POST'])
def api_passkey_register_finish():
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    data = json_object()
    conn = get_db()
    try:
        cred_id = str(data.get('id', ''))
        client_raw = b64url_decode(data.get('response', {}).get('clientDataJSON', ''))
        att_raw = b64url_decode(data.get('response', {}).get('attestationObject', ''))
        transports = data.get('transports') or []
    except ValueError:
        conn.close()
        return jsonify({'error': 'Invalid encoding.'}), 400
    if not cred_id or len(cred_id) > 256:
        conn.close()
        return jsonify({'error': 'Invalid credential.'}), 400
    try:
        client = json.loads(client_raw.decode('utf-8'))
    except Exception:
        conn.close()
        return jsonify({'error': 'Invalid clientData.'}), 400
    if client.get('type') != 'webauthn.create':
        conn.close()
        return jsonify({'error': 'Wrong ceremony.'}), 400
    try:
        chal = b64url_decode(client.get('challenge', ''))
    except ValueError:
        conn.close()
        return jsonify({'error': 'Invalid challenge.'}), 400
    chash = hashlib.sha256(chal).hexdigest()
    row = conn.execute('SELECT username, expires_at FROM passkey_challenges WHERE chash = ? AND kind = ?',
                       (chash, 'reg')).fetchone()
    if not row or row['username'] != user['username'] or row['expires_at'] < int(time.time()):
        conn.close()
        return jsonify({'error': 'Challenge expired. Retry.'}), 400
    if str(client.get('origin', '')).lower() != webauthn_expected_origin():
        conn.close()
        return jsonify({'error': 'Origin mismatch.'}), 400
    try:
        att, _ = cbor_decode_minimal(att_raw, 0)
        fmt = att.get('fmt')
        auth_data = bytes(att.get('authData', b''))
        if fmt != 'none':
            raise ValueError('Only none attestation.')
        parsed = parse_authenticator_data(auth_data)
        if parsed['rpIdHash'] != hashlib.sha256(webauthn_rp_id().encode('utf-8')).digest():
            raise ValueError('rpIdHash mismatch.')
        if not (parsed['flags'] & 0x01):
            raise ValueError('User not present.')
        # User verification is required — the PRF passwordless chain needs a
        # positively verified user, not mere presence.
        if not (parsed['flags'] & 0x04):
            raise ValueError('User not verified.')
        if not (parsed['flags'] & 0x40):
            raise ValueError('No attested data.')
        rest = parsed['remainder']
        cred_len = struct.unpack('>H', rest[16:18])[0]
        cred_id_raw = rest[18:18 + cred_len]
        if b64url_encode(cred_id_raw) != cred_id and base64.b64encode(cred_id_raw).decode() != cred_id:
            # Accept raw-id forms: compare after normalising both sides.
            if cred_id not in (b64url_encode(cred_id_raw),):
                raise ValueError('Credential ID mismatch.')
        pubkey = cose_ec_p256_pubkey(rest[18 + cred_len:])
    except ValueError as error:
        conn.close()
        return jsonify({'error': f'Invalid attestation: {error}'}), 400
    conn.execute('DELETE FROM passkey_challenges WHERE chash = ?', (chash,))
    # Optional PRF wrap: the client wrapped its master key under a key derived
    # from the authenticator's PRF evaluation of the user's PRF salt, enabling
    # passwordless unlock later. Validated strictly; absent on authenticators
    # without PRF support (those creds keep the password-unlock fallback).
    prf_wrap = None
    try:
        prf_in = data.get('prfWrap')
        if prf_in is not None:
            prf_iv = b64decode_strict((prf_in or {}).get('iv'), 12)
            prf_ct = b64decode_strict((prf_in or {}).get('data'), 48)
            prf_wrap = bytes(prf_iv) + bytes(prf_ct)
    except (ValueError, AttributeError):
        conn.close()
        return jsonify({'error': 'Invalid PRF wrap.'}), 400
    # Credential-ID ownership check (cross-account hijack fix). cred_id values
    # are disclosed by /api/passkey/login-begin to unauthenticated callers, so
    # without this an authenticated attacker could re-register a victim's
    # credential ID and the upsert below would reassign it to the attacker,
    # locking the victim out of their own passkey. A user may still update
    # their OWN existing credential; a colliding ID owned by someone else is
    # refused (WebAuthn requires credential IDs to be globally unique).
    owner = conn.execute('SELECT username FROM passkey_creds WHERE cred_id = ?', (cred_id,)).fetchone()
    if owner and owner['username'] != user['username']:
        conn.close()
        return jsonify({'error': 'Credential already registered.'}), 409
    conn.execute(
        'INSERT INTO passkey_creds (cred_id, username, pubkey, sign_count, transports, created_at, prf_wrap)'
        ' VALUES (?, ?, ?, ?, ?, ?, ?)'
        ' ON CONFLICT(cred_id) DO UPDATE SET username = excluded.username,'
        ' pubkey = excluded.pubkey, transports = excluded.transports,'
        ' prf_wrap = COALESCE(excluded.prf_wrap, passkey_creds.prf_wrap)',
        (cred_id, user['username'], bytes(pubkey), 0,
         ','.join([str(t) for t in transports][:8]), int(time.time()), prf_wrap),
    )
    conn.commit()
    conn.close()
    return jsonify({'ok': True, 'credId': cred_id, 'prf': bool(prf_wrap)})


@app.route('/api/passkey/list', methods=['GET'])
def api_passkey_list():
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    rows = conn.execute('SELECT cred_id, created_at, transports, prf_wrap FROM passkey_creds WHERE username = ?'
                        ' ORDER BY created_at', (user['username'],)).fetchall()
    prf_row = conn.execute('SELECT salt FROM passkey_prf WHERE username = ?', (user['username'],)).fetchone()
    conn.close()
    return jsonify({
        'keys': [{'id': r['cred_id'], 'created_at': r['created_at'],
                  'transports': r['transports'],
                  'passwordless': bool(r['prf_wrap'])} for r in rows],
        'prfSalt': b64url_encode(bytes(prf_row['salt'])) if prf_row else None,
    })


@app.route('/api/passkey/prf-wrap', methods=['POST'])
def api_passkey_prf_wrap():
    """Attach a PRF wrap to an EXISTING credential so it can unlock notes with
    no password. The caller runs a PRF assertion for that credential and sends
    the master key wrapped under SHA-256(PRF); the secret never leaves the
    device. Enables passwordless without removing and re-adding the passkey."""
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    data = json_object()
    cred_id = str(data.get('id', ''))
    if not cred_id or len(cred_id) > 256:
        return jsonify({'error': 'Invalid credential.'}), 400
    prf_in = data.get('prfWrap')
    try:
        prf_iv = b64decode_strict((prf_in or {}).get('iv'), 12)
        prf_ct = b64decode_strict((prf_in or {}).get('data'), 48)
    except (ValueError, AttributeError):
        return jsonify({'error': 'Invalid wrap.'}), 400
    conn = get_db()
    cur = conn.execute('UPDATE passkey_creds SET prf_wrap = ? WHERE cred_id = ? AND username = ?',
                       (bytes(prf_iv) + bytes(prf_ct), cred_id, user['username']))
    if cur.rowcount == 0:
        conn.close()
        return jsonify({'error': 'Unknown credential.'}), 404
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/passkey/remove', methods=['POST'])
def api_passkey_remove():
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    data = json_object()
    cred_id = str(data.get('id', ''))
    conn = get_db()
    conn.execute('DELETE FROM passkey_creds WHERE cred_id = ? AND username = ?',
                 (cred_id, user['username']))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/passkey/login-begin', methods=['POST'])
def api_passkey_login_begin():
    """Issue an assertion challenge. Username is REQUIRED: the credential must
    belong to the named account (the match is enforced again at finish)."""
    data = json_object()
    username = str(data.get('username', '')).strip()
    conn = get_db()
    buckets = [ip_bucket('passkey')]
    if username and validate_username(username):
        buckets.append(ip_user_bucket('passkey', username))
    if rate_exceeded(conn, buckets, LOGIN_MAX_FAILURES, LOGIN_WINDOW_SECONDS):
        conn.close()
        return jsonify({'error': 'Too many attempts — try again in a few minutes.'}), 429
    if not validate_username(username):
        rate_hit(conn, ip_bucket('passkey'))
        conn.close()
        return jsonify({'error': 'Username is required.'}), 401
    user = conn.execute('SELECT username FROM users WHERE username = ?', (username,)).fetchone()
    creds = conn.execute('SELECT cred_id, transports FROM passkey_creds WHERE username = ?',
                         (username,)).fetchall() if user else []
    if not user or not creds:
        # Burn work + uniform error so enrolment status is not enumerable
        # beyond what kdf-params already reveals for E2EE shape.
        hashlib.pbkdf2_hmac('sha256', secrets.token_bytes(16), _DUMMY_SALT, PBKDF2_ITERATIONS)
        rate_hit(conn, ip_bucket('passkey'))
        conn.close()
        return jsonify({'error': 'No passkeys for this account.'}), 404
    prf_row = conn.execute('SELECT salt FROM passkey_prf WHERE username = ?', (username,)).fetchone()
    rp_id = webauthn_rp_id()
    challenge = secrets.token_bytes(32)
    now = int(time.time())
    conn.execute('DELETE FROM passkey_challenges WHERE expires_at < ?', (now,))
    conn.execute(
        'INSERT INTO passkey_challenges (chash, username, kind, expires_at, created_at)'
        ' VALUES (?, ?, ?, ?, ?)',
        (hashlib.sha256(challenge).hexdigest(), username, 'auth', now + PASSKEY_CHALLENGE_TTL_SECONDS, now),
    )
    conn.commit()
    conn.close()
    resp = {'challenge': b64url_encode(challenge),
            'rpId': rp_id,
            'timeout': 60000,
            'userVerification': 'preferred',
            'allowCredentials': [{'type': 'public-key', 'id': r['cred_id'],
                                  'transports': [t for t in str(r['transports'] or '').split(',') if t]}
                                 for r in creds]}
    if prf_row:
        # Salt for the PRF eval input; the secret it yields unlocks notes.
        resp['prfSalt'] = b64url_encode(bytes(prf_row['salt']))
    return jsonify(resp)


@app.route('/api/passkey/login-finish', methods=['POST'])
def api_passkey_login_finish():
    """Verify assertion -> session (or MFA ticket). Username is REQUIRED and
    the credential must belong to it: this is the username<->passkey check.
    With a PRF-capable credential the response also carries that cred's wrap,
    so the client unlocks notes with NO password (see below)."""
    data = json_object()
    username = str(data.get('username', '')).strip()
    conn = get_db()
    if not validate_username(username):
        conn.close()
        return jsonify({'error': 'Username is required.'}), 401
    user_bucket = ip_user_bucket('passkey', username)
    try:
        cred_id = str(data.get('id', ''))
        resp = data.get('response', {}) or {}
        client_raw = b64url_decode(resp.get('clientDataJSON', ''))
        auth_raw = b64url_decode(resp.get('authenticatorData', ''))
        sig = b64url_decode(resp.get('signature', ''))
    except ValueError:
        conn.close()
        return jsonify({'error': 'Invalid encoding.'}), 400
    try:
        client = json.loads(client_raw.decode('utf-8'))
    except Exception:
        conn.close()
        return jsonify({'error': 'Invalid clientData.'}), 400
    if client.get('type') != 'webauthn.get':
        conn.close()
        return jsonify({'error': 'Wrong ceremony.'}), 400
    try:
        chal = b64url_decode(client.get('challenge', ''))
    except ValueError:
        conn.close()
        return jsonify({'error': 'Invalid challenge.'}), 400
    chash = hashlib.sha256(chal).hexdigest()
    chrow = conn.execute('SELECT username, expires_at FROM passkey_challenges WHERE chash = ? AND kind = ?',
                         (chash, 'auth')).fetchone()
    if not chrow or chrow['username'] != username or chrow['expires_at'] < int(time.time()):
        conn.close()
        return jsonify({'error': 'Challenge expired. Retry.'}), 400
    if str(client.get('origin', '')).lower() != webauthn_expected_origin():
        conn.close()
        return jsonify({'error': 'Origin mismatch.'}), 400
    cred = conn.execute('SELECT pubkey, sign_count, prf_wrap FROM passkey_creds WHERE cred_id = ? AND username = ?',
                        (cred_id, username)).fetchone()
    if not cred:
        rate_hit(conn, ip_bucket('passkey'))
        rate_hit(conn, user_bucket)
        conn.close()
        return jsonify({'error': 'Unknown credential.'}), 401
    try:
        parsed = parse_authenticator_data(auth_raw)
        if parsed['rpIdHash'] != hashlib.sha256(webauthn_rp_id().encode('utf-8')).digest():
            raise ValueError('rpIdHash mismatch.')
        if not (parsed['flags'] & 0x01):
            raise ValueError('User not present.')
        # Require user verification for passwordless logins as well.
        if not (parsed['flags'] & 0x04):
            raise ValueError('User not verified.')
        signed = bytes(auth_raw) + hashlib.sha256(client_raw).digest()
        verify_es256(bytes(cred['pubkey']), signed, bytes(sig))
        new_count = parsed['signCount']
        old_count = cred['sign_count'] or 0
        if new_count and old_count and new_count <= old_count:
            raise ValueError('Possible cloned key.')
        conn.execute('UPDATE passkey_creds SET sign_count = ? WHERE cred_id = ? AND username = ?',
                     (new_count, cred_id, username))
    except ValueError as error:
        rate_hit(conn, ip_bucket('passkey'))
        rate_hit(conn, user_bucket)
        conn.close()
        return jsonify({'error': f'Invalid assertion: {error}'}), 401
    except Exception:
        rate_hit(conn, ip_bucket('passkey'))
        rate_hit(conn, user_bucket)
        conn.close()
        return jsonify({'error': 'Invalid assertion.'}), 401
    conn.execute('DELETE FROM passkey_challenges WHERE chash = ?', (chash,))
    full = conn.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
    if not full or not is_e2ee_account(full):
        conn.commit()
        conn.close()
        return jsonify({'error': 'Passkeys require an E2EE account.'}), 409
    try:
        mfa = conn.execute('SELECT confirmed FROM mfa_totp WHERE username = ?', (username,)).fetchone()
        mfa_on = bool(mfa and mfa['confirmed'])
    except Exception:
        mfa_on = False
    try:
        profile = decrypt_profile(full['enc_profile'])
    except Exception:
        conn.commit()
        conn.close()
        return jsonify({'error': 'Login failed.'}), 500
    bundle = {
        'username': username, **profile,
        'kdf': (full['kdf'] or 'pbkdf2'),
        'saltEnc': base64.b64encode(bytes(full['salt_enc'])).decode('ascii'),
        'iterations': full['iterations'] or PBKDF2_ITERATIONS,
        'encMasterKey': enc_master_key_parts(full['enc_master_key']),
    }
    if cred['prf_wrap']:
        # Passwordless unlock material for THIS credential: the client derives
        # the KEK from its PRF evaluation and unwraps locally. Opaque to us.
        raw = bytes(cred['prf_wrap'])
        bundle['prfWrap'] = {
            'iv': base64.b64encode(raw[:12]).decode('ascii'),
            'data': base64.b64encode(raw[12:]).decode('ascii'),
        }
    if mfa_on:
        ticket = issue_mfa_ticket(conn, username)
        conn.close()
        return jsonify({'mfaRequired': True, 'mfaTicket': ticket, **bundle}), 202
    now = int(time.time())
    token, _d = issue_session_token(conn, username, now)
    conn.commit()
    conn.close()
    resp_out = jsonify(bundle)
    return set_session_cookie(resp_out, token)


@app.route('/api/account/email', methods=['POST'])
def api_account_email():
    """Set account email (stored inside server-encrypted profile). Empty clears.

    Requires the current password verifier (currentAuth / currentPassword):
    the email is the recovery channel, so a stolen session alone must not be
    able to repoint it and then reset the account's credentials via the
    email-recovery flow (session -> persistent-takeover chain fix)."""
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    data = json_object()
    email = str(data.get('email', '')).strip()[:254]
    if not validate_email(email):
        return jsonify({'error': 'Invalid email address.'}), 400
    conn = get_db()
    row = conn.execute('SELECT * FROM users WHERE username = ?', (user['username'],)).fetchone()
    if not row:
        conn.close()
        return jsonify({'error': 'Not signed in.'}), 401
    proved = False
    if is_e2ee_account(row):
        try:
            cand = b64decode_strict(data.get('currentAuth'), 32)
            proved = bool(verify_auth_hash(cand, row))
        except ValueError:
            proved = False
    else:
        try:
            proved = bool(verify_password(str(data.get('currentPassword', '')), row['pwd_salt'],
                                          row['pwd_hash'], row['iterations']))
        except Exception:
            proved = False
    if not proved:
        conn.close()
        return jsonify({'error': 'Current password is incorrect.'}), 401
    try:
        profile = decrypt_profile(row['enc_profile']) if row else {}
    except Exception:
        profile = {}
    profile.update({'email': email})
    conn.execute('UPDATE users SET enc_profile = ? WHERE username = ?',
                 (encrypt_profile({
                     'firstName': profile.get('firstName', ''),
                     'lastName': profile.get('lastName', ''),
                     'subtitle': profile.get('subtitle', 'Notely User'),
                     'email': email,
                 }), user['username']))
    conn.commit()
    conn.close()
    return jsonify({'ok': True, 'email': email})


@app.route('/api/account/profile', methods=['POST'])
def api_account_profile():
    """Set the display first/last name (stored inside the server-encrypted
    profile). Session-authenticated: a display name is not credential-adjacent,
    unlike the recovery email."""
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    data = json_object()
    first = ' '.join(str(data.get('firstName', '')).split())[:60]
    last = ' '.join(str(data.get('lastName', '')).split())[:60]
    conn = get_db()
    row = conn.execute('SELECT enc_profile FROM users WHERE username = ?', (user['username'],)).fetchone()
    if not row:
        conn.close()
        return jsonify({'error': 'Not signed in.'}), 401
    try:
        profile = decrypt_profile(row['enc_profile'])
    except Exception:
        profile = {}
    conn.execute('UPDATE users SET enc_profile = ? WHERE username = ?',
                 (encrypt_profile({
                     'firstName': first,
                     'lastName': last,
                     'subtitle': profile.get('subtitle', 'Notely User'),
                     'email': profile.get('email', ''),
                 }), user['username']))
    conn.commit()
    conn.close()
    return jsonify({'ok': True, 'firstName': first, 'lastName': last})


@app.route('/api/account', methods=['DELETE'])
def api_account_delete():
    """Delete account + all data. Requires verifier proof + username confirm."""
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    data = json_object()
    conn = get_db()
    if rate_exceeded(conn, [ip_bucket('delaccount'), 'delaccount:' + user['username'].lower()], 3, 3600):
        conn.close()
        return jsonify({'error': 'Too many attempts — try again later.'}), 429
    if str(data.get('confirmUsername', '')).strip() != user['username']:
        conn.close()
        return jsonify({'error': 'Type your username to confirm.'}), 400
    row = conn.execute('SELECT * FROM users WHERE username = ?', (user['username'],)).fetchone()
    if not row:
        conn.close()
        return jsonify({'error': 'Not signed in.'}), 401
    proved = False
    if is_e2ee_account(row):
        try:
            cand = b64decode_strict(data.get('currentAuth'), 32)
            proved = bool(verify_auth_hash(cand, row))
        except ValueError:
            proved = False
    else:
        try:
            proved = bool(verify_password(str(data.get('currentPassword', '')), row['pwd_salt'],
                                          row['pwd_hash'], row['iterations']))
        except Exception:
            proved = False
    if not proved:
        rate_hit(conn, ip_bucket('delaccount'))
        conn.close()
        return jsonify({'error': 'Current password is incorrect.'}), 401
    uname = user['username']
    conn.execute('DELETE FROM users WHERE username = ?', (uname,))
    conn.execute('DELETE FROM sessions WHERE username = ?', (uname,))
    conn.execute('DELETE FROM user_notes WHERE username = ?', (uname,))
    conn.execute('DELETE FROM user_notes_history WHERE username = ?', (uname,))
    conn.execute('DELETE FROM vault_meta WHERE username = ?', (uname,))
    conn.execute('DELETE FROM mfa_totp WHERE username = ?', (uname,))
    conn.execute('DELETE FROM mfa_challenges WHERE username = ?', (uname,))
    conn.execute('DELETE FROM account_recovery WHERE username = ?', (uname,))
    conn.execute('DELETE FROM passkey_creds WHERE username = ?', (uname,))
    conn.execute('DELETE FROM passkey_challenges WHERE username = ?', (uname,))
    # Shared sections: drop the deleted user's memberships, hand off any section
    # they owned to a remaining member, and flag the rest so remaining members
    # rotate the section key on next open — the server holds no key and cannot
    # rotate by itself, and a deleted account must not keep decrypting.
    gone_note_ids = []
    for gr in conn.execute('SELECT id FROM collab_groups WHERE owner = ?', (uname,)).fetchall():
        gid = gr['id']
        successor = conn.execute(
            'SELECT username FROM collab_members WHERE group_id = ? AND username != ? AND accepted = 1'
            ' ORDER BY added_at LIMIT 1', (gid, uname)).fetchone()
        if successor:
            conn.execute('UPDATE collab_groups SET owner = ?, rekey_needed = 1 WHERE id = ?',
                         (successor['username'], gid))
        else:
            gone_note_ids += [nr['id'] for nr in conn.execute(
                'SELECT id FROM collab_notes WHERE group_id = ?', (gid,)).fetchall()]
            conn.execute('DELETE FROM collab_notes WHERE group_id = ?', (gid,))
            conn.execute('DELETE FROM collab_members WHERE group_id = ?', (gid,))
            conn.execute('DELETE FROM collab_groups WHERE id = ?', (gid,))
    for mr in conn.execute('SELECT DISTINCT group_id FROM collab_members WHERE username = ?', (uname,)).fetchall():
        conn.execute('DELETE FROM collab_members WHERE group_id = ? AND username = ?', (mr['group_id'], uname))
        conn.execute('UPDATE collab_groups SET rekey_needed = 1 WHERE id = ?', (mr['group_id'],))
    for nid in gone_note_ids:
        conn.execute('DELETE FROM collab_updates WHERE note_id = ?', (nid,))
    conn.commit()
    conn.close()
    _close_user_streams(uname)
    for nid in gone_note_ids:
        _close_streams(nid)
    resp = jsonify({'ok': True})
    resp.delete_cookie(SESSION_COOKIE, path='/', httponly=True, samesite='Lax', secure=session_cookie_secure())
    resp.delete_cookie(LEGACY_SESSION_COOKIE, path='/', httponly=True, samesite='Lax', secure=session_cookie_secure())
    return resp


# --- E2EE account keys (for wrapping collaborative-note keys) -------------
# Each account publishes an ECDH P-256 public key and its private key wrapped
# under the account master key (opaque). The server can never read either.

@app.route('/api/keys', methods=['POST'])
def api_keys_publish():
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    data = json_object()
    algo = str(data.get('algo') or 'ECDH-P256')[:32]
    if algo != 'ECDH-P256':
        return jsonify({'error': 'Invalid key payload.'}), 400
    try:
        pubkey = base64.b64decode(str(data.get('pubkey', '')).encode('ascii'), validate=True)
        enc_priv = base64.b64decode(str(data.get('encPriv', '')).encode('ascii'), validate=True)
        raw_sig_pub = str(data.get('sigPubkey', '')).strip()
        raw_sig_priv = str(data.get('sigEncPriv', '')).strip()
        sig_pubkey = base64.b64decode(raw_sig_pub.encode('ascii'), validate=True) if raw_sig_pub else None
        sig_enc_priv = base64.b64decode(raw_sig_priv.encode('ascii'), validate=True) if raw_sig_priv else None
    except (base64.binascii.Error, ValueError, AttributeError):
        return jsonify({'error': 'Invalid key payload.'}), 400
    # Raw P-256 point is 65 bytes; wrapped private keys are nonce(12)+ct(>=48).
    if len(pubkey) != 65 or not (60 <= len(enc_priv) <= 4096):
        return jsonify({'error': 'Invalid key payload.'}), 400
    if sig_pubkey is not None and len(sig_pubkey) != 65:
        return jsonify({'error': 'Invalid signing key.'}), 400
    if sig_enc_priv is not None and not (60 <= len(sig_enc_priv) <= 4096):
        return jsonify({'error': 'Invalid signing key.'}), 400
    now = int(time.time())
    conn = get_db()
    conn.execute(
        'INSERT INTO user_keys (username, pubkey, enc_priv, algo, sig_pubkey, sig_enc_priv, created_at, updated_at)'
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ' ON CONFLICT(username) DO UPDATE SET pubkey = excluded.pubkey,'
        ' enc_priv = excluded.enc_priv, algo = excluded.algo,'
        ' sig_pubkey = COALESCE(excluded.sig_pubkey, user_keys.sig_pubkey),'
        ' sig_enc_priv = COALESCE(excluded.sig_enc_priv, user_keys.sig_enc_priv),'
        ' updated_at = excluded.updated_at',
        (user['username'], pubkey, enc_priv, algo, sig_pubkey, sig_enc_priv, now, now),
    )
    conn.commit()
    conn.close()
    security_event('keys.publish', severity='info', actor=user['username'], algo=algo)
    return jsonify({'ok': True})


@app.route('/api/keys/me', methods=['GET'])
def api_keys_me():
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    row = conn.execute('SELECT pubkey, enc_priv, algo, updated_at, sig_pubkey, sig_enc_priv FROM user_keys WHERE username = ?',
                       (user['username'],)).fetchone()
    conn.close()
    if not row:
        return jsonify({'exists': False})
    return jsonify({
        'exists': True,
        'algo': row['algo'],
        'pubkey': base64.b64encode(bytes(row['pubkey'])).decode('ascii'),
        'encPriv': base64.b64encode(bytes(row['enc_priv'])).decode('ascii'),
        'sigPubkey': base64.b64encode(bytes(row['sig_pubkey'])).decode('ascii') if row['sig_pubkey'] else '',
        'sigEncPriv': base64.b64encode(bytes(row['sig_enc_priv'])).decode('ascii') if row['sig_enc_priv'] else '',
        'updated_at': row['updated_at'],
    })


@app.route('/api/keys/lookup', methods=['GET'])
def api_keys_lookup():
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    target = str(request.args.get('username', '')).strip()
    if not validate_username(target):
        return jsonify({'error': 'Invalid username.'}), 400
    conn = get_db()
    if rate_exceeded(conn, [ip_user_bucket('keylookup', user['username'])], 60, 3600):
        conn.close()
        return jsonify({'error': 'Too many lookups — slow down.'}), 429
    rate_hit(conn, ip_user_bucket('keylookup', user['username']))
    row = conn.execute('SELECT pubkey, algo, sig_pubkey FROM user_keys WHERE username = ?', (target,)).fetchone()
    conn.commit()
    conn.close()
    if not row:
        return jsonify({'error': 'That account has not set up sharing yet. Ask them to log in to Notely once, then try again.'}), 404
    return jsonify({
        'username': target,
        'algo': row['algo'],
        'pubkey': base64.b64encode(bytes(row['pubkey'])).decode('ascii'),
        'sigPubkey': base64.b64encode(bytes(row['sig_pubkey'])).decode('ascii') if row['sig_pubkey'] else '',
    })


# --- E2EE collaborative notes (live, server-blind) ------------------------
# Shared sections: a group has a random key wrapped to each member. Notes live
# under a group and inherit its key; live Yjs updates are AES-GCM encrypted
# with that key and relayed over a WebSocket. The server reads nothing.

# note_id -> list of (username, queue.Queue) SSE subscribers. The username is
# tracked so a removed member's live streams can be closed when access is revoked.
collab_streams = {}
_collab_lock = threading.Lock()


def _is_group_member(conn, group_id, username, require_accepted=True):
    sql = 'SELECT 1 FROM collab_members WHERE group_id = ? AND username = ?'
    if require_accepted:
        sql += ' AND accepted = 1'
    return conn.execute(sql, (group_id, username)).fetchone() is not None


def _note_group(conn, note_id):
    return conn.execute('SELECT id, group_id, owner, updated_at, enc_state, key_version FROM collab_notes WHERE id = ?',
                        (note_id,)).fetchone()


def _decode_wrap(data):
    wrapped_key = base64.b64decode(str(data.get('wrappedKey', '')).encode('ascii'), validate=True)
    eph_pub = base64.b64decode(str(data.get('ephPub', '')).encode('ascii'), validate=True)
    wrap_iv = base64.b64decode(str(data.get('wrapIv', '')).encode('ascii'), validate=True)
    if len(eph_pub) != 65 or len(wrap_iv) != 12 or not (48 <= len(wrapped_key) <= 80):
        raise ValueError('bad wrap')
    sig = b''
    raw_sig = str(data.get('sig', '')).strip()
    if raw_sig:
        sig = base64.b64decode(raw_sig.encode('ascii'), validate=True)
        if not (60 <= len(sig) <= 80):  # ECDSA P-256 raw r||s is 64 bytes
            raise ValueError('bad wrap sig')
    return wrapped_key, eph_pub, wrap_iv, sig


def _sse_closed_response():
    """A valid event-stream carrying only 'closed' — lets clients back off
    without pinning workers or queues (subscriber cap / overflow close)."""
    def generate():
        yield 'retry: 30000\n\n'
        yield 'data: ' + json.dumps({'type': 'closed'}) + '\n\n'
    return app.response_class(generate(), mimetype='text/event-stream',
                              headers={'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'Connection': 'keep-alive'})


def _broadcast(note_id, message_dict):
    payload = json.dumps(message_dict)
    with _collab_lock:
        subs = list(collab_streams.get(note_id, ()))
    for _username, q in subs:
        try:
            q.put_nowait(payload)
        except queue.Full:
            # A stalled subscriber must not grow without bound: close it (the
            # client reconnects and re-syncs from the persisted backlog).
            try:
                q.put_nowait(None)
            except Exception:
                pass
        except Exception:
            pass


def _close_streams(note_id):
    """End every subscriber's stream for a note (note/section deleted).

    The None sentinel wakes the generator, which emits a final 'closed' message
    and exits; the subscriber entry is then dropped."""
    with _collab_lock:
        subs = list(collab_streams.get(note_id, ()))
        collab_streams.pop(note_id, None)
    for _username, q in subs:
        try:
            q.put_nowait(None)
        except Exception:
            pass


def _close_user_streams(username, note_ids=None):
    """Close only the named user's open streams (used when access is revoked).

    note_ids limits the scope to one section's notes; None means every note.
    Other members' streams are left untouched."""
    try:
        name = str(username or '').strip()
    except Exception:
        return
    if not name:
        return
    allow = None if note_ids is None else {int(n) for n in note_ids}
    with _collab_lock:
        for note_id, subs in list(collab_streams.items()):
            if allow is not None and note_id not in allow:
                continue
            kept = []
            for sub_user, q in subs:
                if sub_user == name:
                    try:
                        q.put_nowait(None)
                    except Exception:
                        pass
                else:
                    kept.append((sub_user, q))
            if kept:
                collab_streams[note_id] = kept
            else:
                collab_streams.pop(note_id, None)


def _broadcast_group(group_id, message_dict):
    """Fan a control message (e.g. rekey) out to every note stream in a section."""
    conn = get_db()
    note_ids = [r['id'] for r in conn.execute('SELECT id FROM collab_notes WHERE group_id = ?', (group_id,))]
    conn.close()
    for note_id in note_ids:
        _broadcast(note_id, message_dict)


def _share_rate_limited(conn, username):
    """True (and records nothing) when a user has spent their sharing-action
    budget; otherwise records the hit and returns False."""
    bucket = ip_user_bucket('share', username)
    if rate_exceeded(conn, [bucket], SHARE_ADMIN_MAX, SHARE_ADMIN_WINDOW_SECONDS):
        return True
    rate_hit(conn, bucket)
    return False


@app.route('/api/collab/groups', methods=['POST'])
def api_group_create():
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    data = json_object()
    name = str(data.get('name', '')).strip()[:40] or 'Shared'
    try:
        wrapped_key, eph_pub, wrap_iv, wrap_sig = _decode_wrap(data)
    except (ValueError, AttributeError, base64.binascii.Error):
        return jsonify({'error': 'Invalid key payload.'}), 400
    conn = get_db()
    if _share_rate_limited(conn, user['username']):
        conn.close()
        security_event('collab.rate_limited', severity='warning', actor=user['username'], action='group.create')
        return jsonify({'error': 'Too many sharing actions — try again later.'}), 429
    now = int(time.time())
    cur = conn.execute('INSERT INTO collab_groups (owner, name, created_at, updated_at, key_version) VALUES (%s, %s, %s, %s, 1) RETURNING id',
                       (user['username'], name, now, now))
    group_id = cur.lastrowid
    conn.execute('INSERT INTO collab_members (group_id, username, wrapped_key, eph_pub, wrap_iv, wrap_sig, wrap_signer, added_at, accepted, key_version)'
                 ' VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 1, 1)'
                 ' ON CONFLICT(group_id, username) DO UPDATE SET wrapped_key = EXCLUDED.wrapped_key,'
                 ' eph_pub = EXCLUDED.eph_pub, wrap_iv = EXCLUDED.wrap_iv,'
                 ' wrap_sig = EXCLUDED.wrap_sig, wrap_signer = EXCLUDED.wrap_signer,'
                 ' key_version = EXCLUDED.key_version, accepted = 1',
                 (group_id, user['username'], wrapped_key, eph_pub, wrap_iv, wrap_sig or None, user['username'], now))
    conn.commit()
    conn.close()
    security_event('collab.group.create', severity='info', actor=user['username'], group=group_id)
    return jsonify({'ok': True, 'id': group_id, 'name': name, 'keyVersion': 1})


@app.route('/api/collab/groups', methods=['GET'])
def api_group_list():
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    groups = conn.execute(
        'SELECT g.id, g.owner, g.name, g.updated_at, g.enc_meta, g.key_version, g.rekey_needed,'
        ' m.key_version AS my_key_version FROM collab_groups g'
        ' JOIN collab_members m ON m.group_id = g.id'
        ' WHERE m.username = ? AND m.accepted = 1 ORDER BY g.updated_at DESC LIMIT 200',
        (user['username'],),
    ).fetchall()
    out = []
    for g in groups:
        members = [r['username'] for r in conn.execute('SELECT username FROM collab_members WHERE group_id = ? AND accepted = 1 ORDER BY added_at', (g['id'],))]
        notes = [{'id': r['id'], 'updatedAt': r['updated_at'],
                  'encMeta': base64.b64encode(bytes(r['enc_meta'])).decode('ascii') if r['enc_meta'] else ''}
                 for r in conn.execute('SELECT id, updated_at, enc_meta FROM collab_notes WHERE group_id = ? ORDER BY id', (g['id'],))]
        out.append({'id': g['id'], 'owner': g['owner'], 'name': g['name'], 'updatedAt': g['updated_at'],
                    'keyVersion': g['key_version'] or 1,
                    'myKeyVersion': g['my_key_version'] or 1,
                    'rekeyNeeded': 1 if (g['rekey_needed'] or 0) else 0,
                    'members': members, 'notes': notes,
                    'encMeta': base64.b64encode(bytes(g['enc_meta'])).decode('ascii') if g['enc_meta'] else ''})
    # Pending invitations: sections shared with me that I have not accepted yet.
    invites = [{'id': r['id'], 'owner': r['owner'], 'name': r['name'], 'createdAt': r['created_at']}
               for r in conn.execute(
                   'SELECT g.id, g.owner, g.name, g.created_at FROM collab_groups g'
                   ' JOIN collab_members m ON m.group_id = g.id'
                   ' WHERE m.username = ? AND m.accepted = 0 ORDER BY g.created_at DESC LIMIT 200',
                   (user['username'],))]
    conn.close()
    return jsonify({'groups': out, 'invites': invites})


@app.route('/api/collab/groups/<int:group_id>/accept', methods=['POST'])
def api_group_accept(group_id):
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    row = conn.execute('SELECT accepted, key_version FROM collab_members WHERE group_id = ? AND username = ?',
                       (group_id, user['username'])).fetchone()
    if not row:
        conn.close()
        return jsonify({'error': 'No invitation for this account.'}), 404
    # A section re-keyed while this invite was pending leaves our wrap on an old
    # epoch. Flag the section so a member holding the current key rotates and
    # re-wraps us — we must not rotate with the stale key ourselves.
    grow = conn.execute('SELECT key_version FROM collab_groups WHERE id = ?', (group_id,)).fetchone()
    stale = bool(grow) and (row['key_version'] or 1) < ((grow['key_version'] or 1))
    conn.execute('UPDATE collab_members SET accepted = 1 WHERE group_id = ? AND username = ?',
                 (group_id, user['username']))
    if stale:
        conn.execute('UPDATE collab_groups SET rekey_needed = 1 WHERE id = ?', (group_id,))
    conn.commit()
    conn.close()
    security_event('collab.group.accept', severity='info', actor=user['username'],
                   group=group_id, stale_key=bool(stale))
    return jsonify({'ok': True, 'rekeyNeeded': bool(stale)})


@app.route('/api/collab/groups/<int:group_id>', methods=['GET'])
def api_group_get(group_id):
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    if not _is_group_member(conn, group_id, user['username']):
        conn.close()
        return jsonify({'error': 'Not a member of this shared section.'}), 403
    g = conn.execute('SELECT id, owner, name, key_version, rekey_needed, enc_meta FROM collab_groups WHERE id = ?', (group_id,)).fetchone()
    mine = conn.execute('SELECT wrapped_key, eph_pub, wrap_iv, key_version, wrap_sig, wrap_signer FROM collab_members WHERE group_id = ? AND username = ?',
                        (group_id, user['username'])).fetchone()
    members = [r['username'] for r in conn.execute('SELECT username FROM collab_members WHERE group_id = ? AND accepted = 1 ORDER BY added_at', (group_id,))]
    # Pending invite identities are owner-only business — filtered server-side.
    is_owner = g['owner'] == user['username'] if g else False
    pending = [r['username'] for r in conn.execute('SELECT username FROM collab_members WHERE group_id = ? AND accepted = 0 ORDER BY added_at', (group_id,))] if is_owner else []
    conn.close()
    if not g or not mine:
        return jsonify({'error': 'Not found.'}), 404
    return jsonify({
        'id': g['id'], 'owner': g['owner'], 'name': g['name'], 'members': members, 'pending': pending,
        'encMeta': base64.b64encode(bytes(g['enc_meta'])).decode('ascii') if g['enc_meta'] else '',
        'keyVersion': g['key_version'] or 1,
        'rekeyNeeded': 1 if (g['rekey_needed'] or 0) else 0,
        'myKeyVersion': mine['key_version'] or 1,
        'myKey': {
            'wrappedKey': base64.b64encode(bytes(mine['wrapped_key'])).decode('ascii'),
            'ephPub': base64.b64encode(bytes(mine['eph_pub'])).decode('ascii'),
            'wrapIv': base64.b64encode(bytes(mine['wrap_iv'])).decode('ascii'),
            'sig': base64.b64encode(bytes(mine['wrap_sig'])).decode('ascii') if mine['wrap_sig'] else '',
            'signer': mine['wrap_signer'] or '',
        },
    })


@app.route('/api/collab/groups/<int:group_id>/meta', methods=['POST'])
def api_group_meta(group_id):
    # Section folder list, encrypted with the group key.
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    data = json_object()
    try:
        enc_meta = base64.b64decode(str(data.get('encMeta', '')).encode('ascii'), validate=True)
    except (ValueError, AttributeError, base64.binascii.Error):
        return jsonify({'error': 'Invalid meta.'}), 400
    if not (1 <= len(enc_meta) <= 16384):
        return jsonify({'error': 'Meta too large.'}), 413
    conn = get_db()
    if not _is_group_member(conn, group_id, user['username']):
        conn.close()
        return jsonify({'error': 'Not a member of this shared section.'}), 403
    conn.execute('UPDATE collab_groups SET enc_meta = ? WHERE id = ?', (enc_meta, group_id))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/collab/groups/<int:group_id>/members', methods=['POST'])
def api_group_add_member(group_id):
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    data = json_object()
    target = str(data.get('username', '')).strip()
    if not validate_username(target):
        return jsonify({'error': 'Invalid username.'}), 400
    try:
        wrapped_key, eph_pub, wrap_iv, wrap_sig = _decode_wrap(data)
    except (ValueError, AttributeError, base64.binascii.Error):
        return jsonify({'error': 'Invalid key payload.'}), 400
    conn = get_db()
    grow = conn.execute('SELECT owner, key_version FROM collab_groups WHERE id = ?', (group_id,)).fetchone()
    if not grow:
        conn.close()
        return jsonify({'error': 'Not found.'}), 404
    # Only the section owner may invite people.
    if grow['owner'] != user['username']:
        conn.close()
        return jsonify({'error': 'Only the owner can add members.'}), 403
    if _share_rate_limited(conn, user['username']):
        conn.close()
        security_event('collab.rate_limited', severity='warning', actor=user['username'], action='member.add')
        return jsonify({'error': 'Too many sharing actions — try again later.'}), 429
    if not conn.execute('SELECT 1 FROM users WHERE username = ?', (target,)).fetchone():
        conn.close()
        return jsonify({'error': 'No such account.'}), 404
    already = conn.execute('SELECT 1 FROM collab_members WHERE group_id = ? AND username = ?',
                           (group_id, target)).fetchone()
    if not already:
        count = conn.execute('SELECT COUNT(*) AS n FROM collab_members WHERE group_id = ?',
                             (group_id,)).fetchone()['n']
        if count >= SHARE_MAX_MEMBERS:
            conn.close()
            return jsonify({'error': f'This section is full (max {SHARE_MAX_MEMBERS} members).'}), 409
    cur_ver = (grow['key_version'] if grow else 1) or 1
    conn.execute('INSERT INTO collab_members (group_id, username, wrapped_key, eph_pub, wrap_iv, wrap_sig, wrap_signer, added_at, accepted, key_version)'
                 ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)'
                 ' ON CONFLICT(group_id, username) DO UPDATE SET wrapped_key = excluded.wrapped_key,'
                 ' eph_pub = excluded.eph_pub, wrap_iv = excluded.wrap_iv,'
                 ' wrap_sig = excluded.wrap_sig, wrap_signer = excluded.wrap_signer, key_version = excluded.key_version',
                 (group_id, target, wrapped_key, eph_pub, wrap_iv, wrap_sig or None, user['username'], int(time.time()), cur_ver))
    conn.commit()
    conn.close()
    security_event('collab.member.add', severity='info', actor=user['username'], group=group_id, target=target)
    return jsonify({'ok': True, 'keyVersion': cur_ver})


class _RotationError(Exception):
    """Invalid section-key rotation; carries the HTTP status to return."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


def _apply_group_rotation(conn, group_id, current_version, new_version, keys, exclude=(), signer=None):
    """Validate and apply a section key-epoch bump in the caller's transaction.

    The owner supplies one ECDH wrap of the new key per remaining accepted
    member; the server only ever stores them and never sees the key. Raises
    _RotationError on invalid input. Does NOT commit — the caller does, so the
    version bump and any accompanying membership change land atomically."""
    if new_version != ((current_version or 1) + 1):
        raise _RotationError('Stale key version.', 409)
    if not isinstance(keys, list) or not keys:
        raise _RotationError('Missing key wraps.')
    accepted = {r['username'] for r in conn.execute(
        'SELECT username FROM collab_members WHERE group_id = ? AND accepted = 1', (group_id,))}
    accepted -= {str(x) for x in exclude}
    parsed = {}
    try:
        for item in keys:
            name = str((item or {}).get('username', '')).strip()
            if not validate_username(name) or name in parsed:
                raise ValueError('bad member')
            parsed[name] = _decode_wrap(item or {})
    except (ValueError, AttributeError, base64.binascii.Error):
        raise _RotationError('Invalid key wraps.')
    if set(parsed) != accepted:
        raise _RotationError('Wraps must cover exactly the current members.')
    for name, (wrapped_key, eph_pub, wrap_iv, sig) in parsed.items():
        conn.execute('UPDATE collab_members SET wrapped_key = ?, eph_pub = ?, wrap_iv = ?, key_version = ?,'
                     ' wrap_sig = ?, wrap_signer = ? WHERE group_id = ? AND username = ?',
                     (wrapped_key, eph_pub, wrap_iv, new_version, sig or None, signer, group_id, name))
    conn.execute('UPDATE collab_groups SET key_version = ?, updated_at = ?, rekey_needed = 0 WHERE id = ?',
                 (new_version, int(time.time()), group_id))
    return parsed


@app.route('/api/collab/groups/<int:group_id>/rotate', methods=['POST'])
def api_group_rotate(group_id):
    """Publish a new section-key epoch.

    Any current member may rotate (needed when the owner is offline or has left):
    the caller has already re-encrypted the section's notes under the new key and
    supplies one ECDH wrap per currently-accepted member. The server stores the
    wraps, bumps key_version, clears the rekey flag and tells live collaborators
    to rekey. It never sees the key. Content written under an older epoch is
    rejected by the note endpoints, so a removed/left member (who kept the old
    key and has no wrap for the new one) cannot read the section going forward."""
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    data = json_object()
    try:
        new_version = int(data.get('keyVersion'))
    except (TypeError, ValueError):
        return jsonify({'error': 'Invalid key version.'}), 400
    conn = get_db()
    g = conn.execute('SELECT owner, key_version FROM collab_groups WHERE id = ?', (group_id,)).fetchone()
    if not g:
        conn.close()
        return jsonify({'error': 'Not found.'}), 404
    if not _is_group_member(conn, group_id, user['username']):
        conn.close()
        return jsonify({'error': 'Not a member of this shared section.'}), 403
    if _share_rate_limited(conn, user['username']):
        conn.close()
        security_event('collab.rate_limited', severity='warning', actor=user['username'], action='group.rotate')
        return jsonify({'error': 'Too many sharing actions — try again later.'}), 429
    try:
        _apply_group_rotation(conn, group_id, g['key_version'], new_version, data.get('keys'),
                              signer=user['username'])
    except _RotationError as error:
        conn.close()
        return jsonify({'error': error.message}), error.status
    conn.commit()
    conn.close()
    _broadcast_group(group_id, {'type': 'rekey', 'version': new_version})
    security_event('collab.group.rotate', severity='info', actor=user['username'],
                   group=group_id, key_version=new_version)
    return jsonify({'ok': True, 'keyVersion': new_version})


@app.route('/api/collab/groups/<int:group_id>/members/<username>', methods=['DELETE'])
def api_group_remove_member(group_id, username):
    """Remove a member.

    The owner removing an accepted peer must rotate the section key in the same
    transaction, so a removal can never leave the old key live for the person cut
    off; the owner's client supplies the new-epoch wraps. A member leaving on
    their own may also rotate (any member may), but if they don't the section is
    flagged rekey_needed so a remaining member rotates on next open — the server
    holds no key and cannot rotate by itself."""
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    data = json_object()
    conn = get_db()
    g = conn.execute('SELECT owner, key_version FROM collab_groups WHERE id = ?', (group_id,)).fetchone()
    if not g:
        conn.close()
        return jsonify({'ok': True})
    username = str(username)
    removing_self = username == user['username']
    if g['owner'] != user['username'] and not removing_self:
        conn.close()
        return jsonify({'error': 'Only the owner can remove members.'}), 403
    if _share_rate_limited(conn, user['username']):
        conn.close()
        security_event('collab.rate_limited', severity='warning', actor=user['username'], action='member.remove')
        return jsonify({'error': 'Too many sharing actions — try again later.'}), 429
    target = conn.execute('SELECT accepted FROM collab_members WHERE group_id = ? AND username = ?',
                          (group_id, username)).fetchone()
    was_accepted = bool(target and (target['accepted'] or 0))
    note_ids = [r['id'] for r in conn.execute('SELECT id FROM collab_notes WHERE group_id = ?', (group_id,))]
    rotated = False
    new_version = None
    if was_accepted:
        has_payload = data.get('keyVersion') is not None and data.get('keys') is not None
        if has_payload:
            try:
                new_version = int(data.get('keyVersion'))
            except (TypeError, ValueError):
                conn.close()
                return jsonify({'error': 'Invalid key version.'}), 400
            try:
                _apply_group_rotation(conn, group_id, g['key_version'], new_version, data.get('keys'),
                                      exclude={username}, signer=user['username'])
            except _RotationError as error:
                conn.close()
                return jsonify({'error': error.message}), error.status
            rotated = True
        elif g['owner'] == user['username'] and not removing_self:
            conn.close()
            return jsonify({'error': 'Key rotation is required to remove a member.'}), 400
        else:
            # A member left without rotating: flag the section so a remaining
            # member rotates the epoch on next open.
            conn.execute('UPDATE collab_groups SET rekey_needed = 1 WHERE id = ?', (group_id,))
    conn.execute('DELETE FROM collab_members WHERE group_id = ? AND username = ?', (group_id, username))
    conn.commit()
    conn.close()
    # Revocation is immediate: cut the removed user's open streams so they stop
    # receiving ciphertext, then tell the remaining members to adopt the new
    # epoch (the removed member has no wrap for it).
    _close_user_streams(username, note_ids)
    if rotated:
        _broadcast_group(group_id, {'type': 'rekey', 'version': new_version})
    security_event('collab.member.remove', severity='warning', actor=user['username'],
                   group=group_id, target=username, self_leave=bool(removing_self), rotated=rotated)
    return jsonify({'ok': True, 'keyVersion': new_version, 'rekeyNeeded': (not rotated and was_accepted)})


@app.route('/api/collab/groups/<int:group_id>', methods=['DELETE'])
def api_group_delete(group_id):
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    g = conn.execute('SELECT owner FROM collab_groups WHERE id = ?', (group_id,)).fetchone()
    if not g:
        conn.close()
        return jsonify({'ok': True})
    if g['owner'] != user['username']:
        conn.close()
        return jsonify({'error': 'Only the owner can delete this section.'}), 403
    if _share_rate_limited(conn, user['username']):
        conn.close()
        security_event('collab.rate_limited', severity='warning', actor=user['username'], action='group.delete')
        return jsonify({'error': 'Too many sharing actions — try again later.'}), 429
    note_ids = [r['id'] for r in conn.execute('SELECT id FROM collab_notes WHERE group_id = ?', (group_id,))]
    conn.execute('DELETE FROM collab_groups WHERE id = ?', (group_id,))
    conn.execute('DELETE FROM collab_members WHERE group_id = ?', (group_id,))
    conn.execute('DELETE FROM collab_notes WHERE group_id = ?', (group_id,))
    for nid in note_ids:
        conn.execute('DELETE FROM collab_updates WHERE note_id = ?', (nid,))
    conn.commit()
    conn.close()
    for nid in note_ids:
        _close_streams(nid)
    security_event('collab.group.delete', severity='warning', actor=user['username'], group=group_id)
    return jsonify({'ok': True})


@app.route('/api/collab/groups/<int:group_id>/notes', methods=['POST'])
def api_group_note_create(group_id):
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    data = json_object()
    enc_meta = None
    raw_meta = data.get('encMeta')
    if isinstance(raw_meta, str) and raw_meta:
        try:
            enc_meta = base64.b64decode(raw_meta.encode('ascii'), validate=True)
        except (ValueError, AttributeError, base64.binascii.Error):
            return jsonify({'error': 'Invalid meta.'}), 400
        if len(enc_meta) > 8192:
            return jsonify({'error': 'Meta too large.'}), 413
    conn = get_db()
    if not _is_group_member(conn, group_id, user['username']):
        conn.close()
        return jsonify({'error': 'Not a member of this shared section.'}), 403
    now = int(time.time())
    grow = conn.execute('SELECT key_version FROM collab_groups WHERE id = ?', (group_id,)).fetchone()
    cur_ver = (grow['key_version'] if grow else 1) or 1
    cur = conn.execute('INSERT INTO collab_notes (group_id, owner, created_at, updated_at, enc_state, enc_meta, key_version) VALUES (%s, %s, %s, %s, NULL, %s, %s) RETURNING id',
                       (group_id, user['username'], now, now, enc_meta, cur_ver))
    note_id = cur.lastrowid
    conn.execute('UPDATE collab_groups SET updated_at = ? WHERE id = ?', (now, group_id))
    conn.commit()
    conn.close()
    return jsonify({'ok': True, 'id': note_id, 'keyVersion': cur_ver})


@app.route('/api/collab/notes/<int:note_id>/meta', methods=['POST'])
def api_note_meta(note_id):
    # Title + folder for a shared note, encrypted with the group key.
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    data = json_object()
    try:
        enc_meta = base64.b64decode(str(data.get('encMeta', '')).encode('ascii'), validate=True)
    except (ValueError, AttributeError, base64.binascii.Error):
        return jsonify({'error': 'Invalid meta.'}), 400
    if not (1 <= len(enc_meta) <= 8192):
        return jsonify({'error': 'Meta too large.'}), 413
    conn = get_db()
    note = _note_group(conn, note_id)
    if not note or not _is_group_member(conn, note['group_id'], user['username']):
        conn.close()
        return jsonify({'error': 'Not found.'}), 404
    conn.execute('UPDATE collab_notes SET enc_meta = ? WHERE id = ?', (enc_meta, note_id))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/collab/notes/<int:note_id>', methods=['GET'])
def api_note_get(note_id):
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    note = _note_group(conn, note_id)
    if not note or not _is_group_member(conn, note['group_id'], user['username']):
        conn.close()
        return jsonify({'error': 'Not found.'}), 404
    mine = conn.execute('SELECT wrapped_key, eph_pub, wrap_iv, key_version, wrap_sig, wrap_signer FROM collab_members WHERE group_id = ? AND username = ?',
                        (note['group_id'], user['username'])).fetchone()
    meta = conn.execute('SELECT enc_meta FROM collab_notes WHERE id = ?', (note_id,)).fetchone()
    grow = conn.execute('SELECT key_version FROM collab_groups WHERE id = ?', (note['group_id'],)).fetchone()
    conn.close()
    return jsonify({
        'id': note_id, 'groupId': note['group_id'], 'owner': note['owner'], 'updatedAt': note['updated_at'],
        'keyVersion': (grow['key_version'] if grow else 1) or 1,
        'myKeyVersion': mine['key_version'] or 1,
        'encMeta': base64.b64encode(bytes(meta['enc_meta'])).decode('ascii') if meta and meta['enc_meta'] else '',
        'myKey': {
            'wrappedKey': base64.b64encode(bytes(mine['wrapped_key'])).decode('ascii'),
            'ephPub': base64.b64encode(bytes(mine['eph_pub'])).decode('ascii'),
            'wrapIv': base64.b64encode(bytes(mine['wrap_iv'])).decode('ascii'),
            'sig': base64.b64encode(bytes(mine['wrap_sig'])).decode('ascii') if mine['wrap_sig'] else '',
            'signer': mine['wrap_signer'] or '',
        },
    })


@app.route('/api/collab/notes/<int:note_id>/state', methods=['GET'])
def api_note_state(note_id):
    """Full ciphertext of a note (snapshot + update log) so a member can decrypt,
    re-encode and re-encrypt it under a new epoch during key rotation."""
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    note = _note_group(conn, note_id)
    if not note or not _is_group_member(conn, note['group_id'], user['username']):
        conn.close()
        return jsonify({'error': 'Not found.'}), 404
    grow = conn.execute('SELECT key_version FROM collab_groups WHERE id = ?', (note['group_id'],)).fetchone()
    updates = [{'payload': base64.b64encode(bytes(r['payload'])).decode('ascii'), 'version': r['key_version'] or 1}
               for r in conn.execute('SELECT payload, key_version FROM collab_updates WHERE note_id = ? ORDER BY id', (note_id,))]
    conn.close()
    return jsonify({
        'id': note_id, 'groupId': note['group_id'],
        # keyVersion is the epoch that encrypted encState (the snapshot);
        # groupKeyVersion is the section's current epoch for new writes.
        'keyVersion': note['key_version'] or 1,
        'groupKeyVersion': (grow['key_version'] if grow else 1) or 1,
        'encState': base64.b64encode(bytes(note['enc_state'])).decode('ascii') if note['enc_state'] else '',
        'updates': updates,
    })


@app.route('/api/collab/notes/<int:note_id>', methods=['DELETE'])
def api_note_delete(note_id):
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    note = _note_group(conn, note_id)
    if not note:
        conn.close()
        return jsonify({'ok': True})
    if not _is_group_member(conn, note['group_id'], user['username']):
        conn.close()
        return jsonify({'error': 'Not allowed.'}), 403
    grow = conn.execute('SELECT owner FROM collab_groups WHERE id = ?', (note['group_id'],)).fetchone()
    if not grow or grow['owner'] != user['username']:
        conn.close()
        return jsonify({'error': 'Only the owner can delete a shared note.'}), 403
    conn.execute('DELETE FROM collab_notes WHERE id = ?', (note_id,))
    conn.execute('DELETE FROM collab_updates WHERE note_id = ?', (note_id,))
    conn.commit()
    conn.close()
    _close_streams(note_id)
    return jsonify({'ok': True})


@app.route('/api/collab/notes/<int:note_id>/compact', methods=['POST'])
def api_note_compact(note_id):
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    data = json_object()
    try:
        payload = base64.b64decode(str(data.get('state', '')).encode('ascii'), validate=True)
        key_version = int(data.get('keyVersion'))
    except (ValueError, TypeError, AttributeError, base64.binascii.Error):
        return jsonify({'error': 'Invalid state.'}), 400
    if not (1 <= len(payload) <= SHARE_MAX_BYTES):
        return jsonify({'error': 'State too large.'}), 413
    conn = get_db()
    note = _note_group(conn, note_id)
    if not note or not _is_group_member(conn, note['group_id'], user['username']):
        conn.close()
        return jsonify({'error': 'Not found.'}), 404
    grow = conn.execute('SELECT key_version FROM collab_groups WHERE id = ?', (note['group_id'],)).fetchone()
    if key_version != ((grow['key_version'] if grow else 1) or 1):
        conn.close()
        return jsonify({'error': 'Stale key version.'}), 409
    now = int(time.time())
    conn.execute('UPDATE collab_notes SET enc_state = ?, key_version = ?, updated_at = ? WHERE id = ?',
                 (payload, key_version, now, note_id))
    conn.execute('DELETE FROM collab_updates WHERE note_id = ?', (note_id,))
    conn.execute('UPDATE collab_groups SET updated_at = ? WHERE id = ?', (now, note['group_id']))
    conn.commit()
    conn.close()
    return jsonify({'ok': True, 'keyVersion': key_version})


# Live sync transport: Server-Sent Events for receiving (works with the dev
# server over TLS), and a plain POST for sending. Same encrypted payloads.
@app.route('/api/collab/notes/<int:note_id>/stream', methods=['GET'])
def api_note_stream(note_id):
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    note = _note_group(conn, note_id)
    if not note or not _is_group_member(conn, note['group_id'], user['username']):
        conn.close()
        return jsonify({'error': 'Not found.'}), 404
    backlog = [(bytes(r['payload']), r['key_version'] or 1)
               for r in conn.execute('SELECT payload, key_version FROM collab_updates WHERE note_id = ? ORDER BY id', (note_id,))]
    state_blob = bytes(note['enc_state']) if note['enc_state'] else None
    state_version = note['key_version'] or 1
    conn.close()
    # Bounded queue + per-user subscriber cap: an authenticated member cannot
    # stack unbounded RAM/worker-bound streams.
    q = queue.Queue(maxsize=SSE_QUEUE_MAX_EVENTS)
    with _collab_lock:
        user_streams = [entry for entry in collab_streams.get(note_id, []) if entry[0] == user['username']]
        if len(user_streams) >= SSE_MAX_SUBSCRIBERS_PER_USER:
            return _sse_closed_response()
        collab_streams.setdefault(note_id, []).append((user['username'], q))

    def generate():
        try:
            yield 'retry: 2000\n\n'
            if state_blob:
                yield 'data: ' + json.dumps({'type': 'state', 'version': state_version, 'payload': base64.b64encode(state_blob).decode('ascii')}) + '\n\n'
            for u, version in backlog:
                yield 'data: ' + json.dumps({'type': 'update', 'version': version, 'payload': base64.b64encode(u).decode('ascii')}) + '\n\n'
            while True:
                try:
                    item = q.get(timeout=20)
                except queue.Empty:
                    yield ': ping\n\n'
                    continue
                if item is None:
                    # Access revoked or note/section deleted: tell the client and
                    # end the stream so no further ciphertext is delivered.
                    yield 'data: ' + json.dumps({'type': 'closed'}) + '\n\n'
                    break
                yield 'data: ' + item + '\n\n'
        finally:
            with _collab_lock:
                try:
                    collab_streams.get(note_id, []).remove((user['username'], q))
                except ValueError:
                    pass
    return app.response_class(generate(), mimetype='text/event-stream',
                              headers={'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'Connection': 'keep-alive'})


@app.route('/api/collab/notes/<int:note_id>/updates', methods=['POST'])
def api_note_updates(note_id):
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    data = json_object()
    try:
        payload = base64.b64decode(str(data.get('payload', '')).encode('ascii'), validate=True)
        key_version = int(data.get('keyVersion'))
    except (ValueError, TypeError, AttributeError, base64.binascii.Error):
        return jsonify({'error': 'Invalid update.'}), 400
    if not (1 <= len(payload) <= SHARE_MAX_BYTES):
        return jsonify({'error': 'Update too large.'}), 413
    conn = get_db()
    note = _note_group(conn, note_id)
    if not note or not _is_group_member(conn, note['group_id'], user['username']):
        conn.close()
        return jsonify({'error': 'Not allowed.'}), 403
    if _share_rate_limited(conn, user['username']):
        conn.close()
        security_event('collab.rate_limited', severity='warning', actor=user['username'], action='note.update')
        return jsonify({'error': 'Too many updates — slow down.'}), 429
    grow = conn.execute('SELECT key_version FROM collab_groups WHERE id = ?', (note['group_id'],)).fetchone()
    if key_version != ((grow['key_version'] if grow else 1) or 1):
        conn.close()
        return jsonify({'error': 'Stale key version.'}), 409
    now = int(time.time())
    conn.execute('INSERT INTO collab_updates (note_id, payload, created_at, key_version) VALUES (?, ?, ?, ?)',
                 (note_id, payload, now, key_version))
    conn.execute('UPDATE collab_notes SET updated_at = ? WHERE id = ?', (now, note_id))
    conn.execute('DELETE FROM collab_updates WHERE note_id = ? AND id NOT IN '
                 '(SELECT id FROM collab_updates WHERE note_id = ? ORDER BY id DESC LIMIT 5000)',
                 (note_id, note_id))
    conn.commit()
    conn.close()
    _broadcast(note_id, {'type': 'update', 'version': key_version, 'payload': data['payload']})
    return jsonify({'ok': True, 'keyVersion': key_version})


@app.route('/api/collab/notes/<int:note_id>/presence', methods=['POST'])
def api_note_presence(note_id):
    """Ephemeral presence relay (who is here, where their cursor is).

    Presence is never stored: the encrypted blob is fanned out to the note's
    live subscribers and forgotten. The server cannot read it (it is encrypted
    under the section key)."""
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    data = json_object()
    try:
        payload = base64.b64decode(str(data.get('payload', '')).encode('ascii'), validate=True)
        key_version = int(data.get('keyVersion'))
    except (ValueError, TypeError, AttributeError, base64.binascii.Error):
        return jsonify({'error': 'Invalid presence.'}), 400
    if not (1 <= len(payload) <= 2048):
        return jsonify({'error': 'Presence too large.'}), 413
    conn = get_db()
    note = _note_group(conn, note_id)
    if not note or not _is_group_member(conn, note['group_id'], user['username']):
        conn.close()
        return jsonify({'error': 'Not allowed.'}), 403
    # Presence is a relay — throttle per user (~2 Hz, above the 5 s heartbeat).
    pres_bucket = ip_user_bucket('presence', user['username'])
    if rate_exceeded(conn, [pres_bucket], 600, 300):
        conn.close()
        return jsonify({'error': 'Presence too chatty — slow down.'}), 429
    rate_hit(conn, pres_bucket)
    conn.close()
    _broadcast(note_id, {'type': 'presence', 'version': key_version, 'payload': data['payload']})
    return jsonify({'ok': True})


@app.route('/api/recovery/email/start', methods=['POST'])
def api_recovery_email_start():
    """Request a password-reset email. Accepts username OR email address.
    Uniform ok: never reveals whether the account exists or has an email on
    file (enumeration fix)."""
    data = json_object()
    username = str(data.get('username', '')).strip()
    email_in = str(data.get('email', '')).strip().lower()[:254]
    conn = get_db()
    buckets = [ip_bucket('recovery')]
    if username and validate_username(username):
        buckets.append(ip_user_bucket('recovery', username))
    if rate_exceeded(conn, buckets, LOGIN_MAX_FAILURES, LOGIN_WINDOW_SECONDS):
        conn.close()
        return jsonify({'ok': True})
    resolved = ''
    resolved_email = ''
    try:
        if validate_username(username):
            row = conn.execute('SELECT enc_profile FROM users WHERE username = ?', (username,)).fetchone()
            if row:
                try:
                    profile_email = str(decrypt_profile(row['enc_profile']).get('email', '') or '').strip()
                except Exception:
                    profile_email = ''
                if profile_email:
                    resolved, resolved_email = username, profile_email
        elif email_in and validate_email(email_in):
            # O(n) profile scan; fine at current scale, and rate-limited above.
            for prow in conn.execute('SELECT username, enc_profile FROM users'):
                try:
                    pem = str(decrypt_profile(prow['enc_profile']).get('email', '') or '').strip().lower()
                except Exception:
                    continue
                if pem and pem == email_in:
                    resolved, resolved_email = prow['username'], pem
                    break
    except Exception:
        resolved = ''
    if resolved:
        try:
            token = secrets.token_urlsafe(32)
            now = int(time.time())
            conn.execute('DELETE FROM email_recovery WHERE expires_at < ?', (now,))
            conn.execute('INSERT INTO email_recovery (token_hash, username, expires_at, created_at, used_at)'
                         ' VALUES (?, ?, ?, ?, NULL)',
                         (hashlib.sha256(token.encode('utf-8')).hexdigest(), resolved, now + EMAIL_TOKEN_TTL_SECONDS, now))
            conn.commit()
            try:
                send_recovery_email(resolved_email, resolved, token)
            except Exception:
                pass
        except Exception:
            pass
    rate_hit(conn, ip_bucket('recovery'))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


def trusted_app_origin():
    """Configured origin for links minted server-side (CWE-640 fix).

    The Host header is client-supplied, so deriving emailed links from it
    invites password-reset poisoning. NOTELY_PUBLIC_ORIGIN must be set to the
    app's real public origin (e.g. 'https://notes.example.com'); there is no
    Host fallback. Returns None when unset so callers fail closed rather than
    mail a link to an attacker-controlled host."""
    trusted = os.environ.get('NOTELY_PUBLIC_ORIGIN')
    if trusted:
        candidate = trusted.rstrip('/')
        # Must be an absolute http(s) origin; reject anything malformed.
        try:
            from urllib.parse import urlparse
            parsed = urlparse(candidate)
            if parsed.scheme in ('http', 'https') and parsed.hostname:
                return candidate
        except Exception:
            pass
        print('NOTELY: NOTELY_PUBLIC_ORIGIN is set but invalid; reset links disabled.', flush=True)
        return None
    print('NOTELY: NOTELY_PUBLIC_ORIGIN is not set; password-reset emails are disabled '
          '(set it to the public https origin to enable them).', flush=True)
    return None


def send_recovery_email(to_email, username, token):
    """Send the reset link via SMTP env config. Dev fallback: log the link so
    the flow stays testable without a mail server (never returned to clients).

    Fails closed when no trusted origin is configured: the link (and therefore
    the token) is never minted from the client-supplied Host header."""
    origin = trusted_app_origin()
    if not origin:
        return
    host = (request.host or '').split(':')[0]
    link = origin + f'/?emailToken={token}'
    smtp_host = os.environ.get('NOTELY_SMTP_HOST')
    if not smtp_host:
        print(f'NOTELY DEV: password-reset link for {username!r}: {link}', flush=True)
        return
    import smtplib
    from email.message import EmailMessage
    msg = EmailMessage()
    msg['Subject'] = 'Notely password reset'
    msg['From'] = os.environ.get('NOTELY_SMTP_FROM', f'notely@{host}')
    msg['To'] = to_email
    msg.set_content(
        f'Hi {username},\n\nReset your Notely password (expires in 15 minutes):\n{link}\n\n'
        'If you did not request this, ignore this email.\n')
    port = int(os.environ.get('NOTELY_SMTP_PORT', '587'))
    user = os.environ.get('NOTELY_SMTP_USER')
    password = os.environ.get('NOTELY_SMTP_PASS')
    with smtplib.SMTP(smtp_host, port, timeout=10) as smtp:
        smtp.starttls()
        if user:
            smtp.login(user, password or '')
        smtp.send_message(msg)


@app.route('/api/recovery/email/complete', methods=['POST'])
def api_recovery_email_complete():
    """Burn an unused email token to install a fresh login verifier.

    E2EE note: the wrapped master key is deliberately LEFT untouched — the
    server never sees passwords and cannot re-wrap. After reset the user logs
    in with the new password, then enters the OLD password once locally to
    re-wrap (client-driven upgrade). Notes are never destroyed by this call.
    """
    data = json_object()
    token = str(data.get('token', ''))
    conn = get_db()
    if not token or len(token) > 256:
        conn.close()
        return jsonify({'error': 'Invalid request.'}), 400
    if rate_exceeded(conn, [ip_bucket('recovery')], LOGIN_MAX_FAILURES, LOGIN_WINDOW_SECONDS):
        conn.close()
        return jsonify({'error': 'Too many attempts — try again in a few minutes.'}), 429
    thash = hashlib.sha256(token.encode('utf-8')).hexdigest()
    row = conn.execute('SELECT username, expires_at, used_at FROM email_recovery WHERE token_hash = ?',
                       (thash,)).fetchone()
    if not row or row['used_at'] or row['expires_at'] < int(time.time()):
        rate_hit(conn, ip_bucket('recovery'))
        conn.close()
        return jsonify({'error': 'Invalid or expired link.'}), 401
    username = row['username']
    try:
        new_auth = b64decode_strict(data.get('authHash'), 32)
        new_salt_auth = b64decode_strict(data.get('saltAuth'), 16)
    except (ValueError, AttributeError):
        conn.close()
        return jsonify({'error': 'Invalid request.'}), 400
    if is_weak_verifier(new_auth, new_salt_auth, identity_password_candidates(username)):
        conn.close()
        return jsonify({'error': 'New password too weak.'}), 400
    user = conn.execute('SELECT username FROM users WHERE username = ?', (username,)).fetchone()
    if not user:
        conn.close()
        return jsonify({'error': 'Invalid or expired link.'}), 401
    try:
        new_hash2 = pepper_auth_hash(bytes(new_auth))
    except Exception:
        new_hash2 = None
    conn.execute('UPDATE users SET salt_auth = ?, auth_hash = ?, auth_hash2 = ? WHERE username = ?',
                 (new_salt_auth, (None if new_hash2 else new_auth), new_hash2, username))
    conn.execute('UPDATE email_recovery SET used_at = ? WHERE token_hash = ?', (int(time.time()), thash))
    conn.execute('DELETE FROM sessions WHERE username = ?', (username,))
    # Fresh start after a lost-password reset: MFA would otherwise lock the
    # user out with the device they just lost. Passkeys stay (they need no
    # secret the user can lose the same way — each is a separate device).
    conn.execute('DELETE FROM mfa_totp WHERE username = ?', (username,))
    conn.execute('DELETE FROM mfa_challenges WHERE username = ?', (username,))
    conn.execute('DELETE FROM passkey_challenges WHERE username = ?', (username,))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/recovery/account/count', methods=['GET'])
def api_recovery_account_count():
    """How many unused password-recovery wraps exist (count only — plaintext
    codes are never re-fetchable by design)."""
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    n = conn.execute('SELECT COUNT(*) AS n FROM account_recovery'
                     ' WHERE username = ? AND used_at IS NULL',
                     (user['username'],)).fetchone()['n']
    conn.close()
    return jsonify({'count': int(n or 0)})


@app.route('/api/recovery/account/generate', methods=['POST'])
def api_recovery_account_generate():
    """Store client-wrapped master-key copies keyed by code hashes.

    Body: {wraps: [{codeHash hex64, salt b64(16), iv b64(12), data b64(48)}]}
    up to 10. Replaces previous set. Server never sees codes or keys."""
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    data = json_object()
    wraps = data.get('wraps')
    if not isinstance(wraps, list) or not 1 <= len(wraps) <= 10:
        return jsonify({'error': 'Provide 1-10 wraps.'}), 400
    conn = get_db()
    if rate_exceeded(conn, [ip_bucket('mfa'), 'mfa:' + user['username'].lower()], CHANGE_MAX_FAILURES, CHANGE_WINDOW_SECONDS):
        conn.close()
        return jsonify({'error': 'Too many attempts — try again in a few minutes.'}), 429
    parsed = []
    for item in wraps:
        try:
            ch = str((item or {}).get('codeHash', '')).strip().lower()
            if len(ch) != 64 or any(c not in '0123456789abcdef' for c in ch):
                raise ValueError('bad hash')
            salt = b64decode_strict((item or {}).get('salt'), 16)
            wrap = (item or {}).get('wrappedKey') or {}
            iv = b64decode_strict(wrap.get('iv'), 12)
            blob = base64.b64decode(str(wrap.get('data', '')).encode('ascii'), validate=True)
            if not 32 <= len(blob) <= 128:
                raise ValueError('bad blob')
            parsed.append((ch, bytes(salt), bytes(iv) + bytes(blob)))
        except (ValueError, AttributeError, base64.binascii.Error):
            conn.close()
            return jsonify({'error': 'Invalid wraps.'}), 400
    now = int(time.time())
    conn.execute('DELETE FROM account_recovery WHERE username = ?', (user['username'],))
    for ch, salt, blob in parsed:
        conn.execute('INSERT INTO account_recovery (code_hash, username, salt, wrapped_key, created_at, used_at)'
                     ' VALUES (?, ?, ?, ?, ?, NULL)', (ch, user['username'], salt, blob, now))
    conn.commit()
    conn.close()
    return jsonify({'ok': True, 'count': len(parsed)})


@app.route('/api/recovery/account/lookup', methods=['POST'])
def api_recovery_account_lookup():
    """Fetch one wrap by code hash for local decrypt (no plaintext code sent).

    Username is optional: the code hash alone (256-bit) identifies the
    account. When given it must match (backward compat)."""
    data = json_object()
    username = str(data.get('username', '')).strip()
    code_hash = str(data.get('codeHash', '')).strip().lower()
    conn = get_db()
    # Account lockout first so a locked account hears the account message
    # instead of the generic IP one.
    if username and validate_username(username) and recovery_locked_out(conn, username):
        conn.close()
        return jsonify({'error': 'This account is locked out due to too many recovery attempts — try again later.'}), 429
    buckets = [ip_bucket('recovery')]
    if username and validate_username(username):
        buckets.append(ip_user_bucket('recovery', username))
    if rate_exceeded(conn, buckets, LOGIN_MAX_FAILURES, LOGIN_WINDOW_SECONDS):
        conn.close()
        return jsonify({'error': 'Too many attempts — try again in a few minutes.'}), 429
    if len(code_hash) != 64 or (username and not validate_username(username)):
        rate_hit(conn, ip_bucket('recovery'))
        conn.close()
        return jsonify({'error': 'Not found.'}), 404
    if username:
        row = conn.execute('SELECT username, salt, wrapped_key, used_at FROM account_recovery'
                           ' WHERE code_hash = ? AND username = ?', (code_hash, username)).fetchone()
    else:
        row = conn.execute('SELECT username, salt, wrapped_key, used_at FROM account_recovery'
                           ' WHERE code_hash = ?', (code_hash,)).fetchone()
    if not row or row['used_at']:
        if username:
            recovery_note_failure(conn, username)
        rate_hit(conn, ip_bucket('recovery'))
        conn.close()
        return jsonify({'error': 'Not found.'}), 404
    if recovery_locked_out(conn, row['username']):
        conn.close()
        return jsonify({'error': 'This account is locked out due to too many recovery attempts — try again later.'}), 429
    blob = bytes(row['wrapped_key'])
    conn.close()
    return jsonify({
        'username': row['username'],
        'salt': base64.b64encode(bytes(row['salt'])).decode('ascii'),
        'wrappedKey': {
            'iv': base64.b64encode(blob[:12]).decode('ascii'),
            'data': base64.b64encode(blob[12:]).decode('ascii'),
        },
    })


@app.route('/api/recovery/account/reset', methods=['POST'])
def api_recovery_account_reset():
    """Burn one unused code to install a fresh verifier + re-wrapped master key.

    Master key itself is unchanged (client unwrapped it locally), so notes need
    no re-encryption. All sessions are revoked. Username is optional and, when
    omitted, resolved from the code itself."""
    data = json_object()
    username = str(data.get('username', '')).strip()
    code_hash = str(data.get('codeHash', '')).strip().lower()
    conn = get_db()
    if len(code_hash) != 64 or (username and not validate_username(username)):
        conn.close()
        return jsonify({'error': 'Invalid request.'}), 400
    if username and validate_username(username) and recovery_locked_out(conn, username):
        conn.close()
        return jsonify({'error': 'This account is locked out due to too many recovery attempts — try again later.'}), 429
    buckets = [ip_bucket('recovery')]
    if username:
        buckets.append(ip_user_bucket('recovery', username))
    if rate_exceeded(conn, buckets, LOGIN_MAX_FAILURES, LOGIN_WINDOW_SECONDS):
        conn.close()
        return jsonify({'error': 'Too many attempts — try again in a few minutes.'}), 429
    if username:
        row = conn.execute('SELECT username, used_at FROM account_recovery WHERE code_hash = ? AND username = ?',
                           (code_hash, username)).fetchone()
    else:
        row = conn.execute('SELECT username, used_at FROM account_recovery WHERE code_hash = ?',
                           (code_hash,)).fetchone()
    if not row or row['used_at']:
        recovery_note_failure(conn, row['username'] if row else username)
        rate_hit(conn, ip_bucket('recovery'))
        conn.close()
        return jsonify({'error': 'Invalid or used code.'}), 401
    username = row['username']
    if recovery_locked_out(conn, username):
        conn.close()
        return jsonify({'error': 'This account is locked out due to too many recovery attempts — try again later.'}), 429
    try:
        new_auth = b64decode_strict(data.get('authHash'), 32)
        new_salt_auth = b64decode_strict(data.get('saltAuth'), 16)
        new_salt_enc = b64decode_strict(data.get('saltEnc'), 16)
        new_wrap = data.get('encMasterKey') or {}
        new_iv = b64decode_strict(new_wrap.get('iv'), 12)
        new_ct = b64decode_strict(new_wrap.get('data'), 48)
        new_kdf = data.get('kdf')
        new_params = data.get('params') or {}
    except (ValueError, AttributeError):
        conn.close()
        return jsonify({'error': 'Invalid request.'}), 400
    if new_kdf != 'argon2id' or not valid_argon2_params(new_params):
        conn.close()
        return jsonify({'error': 'Invalid request.'}), 400
    if is_weak_verifier(new_auth, new_salt_auth, identity_password_candidates(username)):
        conn.close()
        return jsonify({'error': 'New password too weak.'}), 400
    user = conn.execute('SELECT username FROM users WHERE username = ?', (username,)).fetchone()
    if not user:
        conn.close()
        return jsonify({'error': 'Invalid or used code.'}), 401
    try:
        new_hash2 = pepper_auth_hash(bytes(new_auth))
    except Exception:
        new_hash2 = None
    conn.execute('UPDATE users SET salt_auth = ?, salt_enc = ?, auth_hash = ?, enc_master_key = ?,'
                 " kdf = 'argon2id', kdf_params = ?, auth_hash2 = ? WHERE username = ?",
                 (new_salt_auth, new_salt_enc, (None if new_hash2 else new_auth), new_iv + new_ct,
                  json.dumps(ARGON2_DESCRIPTOR), new_hash2, username))
    conn.execute('UPDATE account_recovery SET used_at = ? WHERE code_hash = ?', (int(time.time()), code_hash))
    conn.execute('DELETE FROM sessions WHERE username = ?', (username,))
    # Same as email reset: a recovered account must not stay MFA-locked.
    conn.execute('DELETE FROM mfa_totp WHERE username = ?', (username,))
    conn.execute('DELETE FROM mfa_challenges WHERE username = ?', (username,))
    conn.execute('DELETE FROM passkey_challenges WHERE username = ?', (username,))
    conn.commit()
    conn.close()
    return jsonify({'ok': True, 'username': username})


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


def build_tls_context(cert_path, key_path):
    """Hardened TLS server context (M-1).

    Werkzeug's default ssl_context still negotiated TLS 1.0/1.1 and anonymous
    (unauthenticated) cipher suites. This pins TLS >= 1.2, permits only AEAD
    suites with forward secrecy (AES-GCM / ChaCha20-Poly1305), and disables
    compression and anonymous/NULL/export/RC4/3DES/MD5. TLS 1.3 suites are not
    affected by set_ciphers and are secure by default."""
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    try:
        context.options |= ssl.OP_NO_COMPRESSION
        context.options |= ssl.OP_CIPHER_SERVER_PREFERENCE
    except Exception:
        pass
    try:
        context.set_ciphers(
            'ECDHE+AESGCM:ECDHE+CHACHA20:DHE+AESGCM:DHE+CHACHA20:'
            '!aNULL:!eNULL:!EXPORT:!DES:!RC4:!3DES:!MD5:!PSK:!SRP'
        )
    except ssl.SSLError:
        pass
    context.load_cert_chain(cert_path, key_path)
    return context


if __name__ == '__main__':
    init_db()
    start_backup_thread()
    # Hide Werkzeug version banner (info-disclosure fix). Must run before app.run.
    try:
        import werkzeug.serving
        werkzeug.serving.WSGIRequestHandler.server_version = 'Notely'
        werkzeug.serving.WSGIRequestHandler.sys_version = ''

        # Suppress noisy BrokenPipe/SSLError logs from client disconnects.
        _orig_log_error = werkzeug.serving.WSGIRequestHandler.log_error
        def _quiet_log_error(self, fmt, *args):
            msg = fmt % args if args else fmt
            if isinstance(msg, str) and ('BrokenPipeError' in msg or 'UNEXPECTED_EOF_WHILE_READING' in msg):
                return
            _orig_log_error(self, fmt, *args)
        werkzeug.serving.WSGIRequestHandler.log_error = _quiet_log_error
    except Exception:
        pass
    port = int(os.environ.get('PORT', '5001'))
    # HTTPS is mandatory: the app relies on Web Crypto and __Host- session
    # cookies, both of which need a secure context. There is no plain-HTTP
    # mode — bind all interfaces by default so the LAN can reach it, and
    # require a cert/key (env override, else certs/notely.{crt,key}).
    bind_host = os.environ.get('NOTELY_BIND_HOST', '0.0.0.0')
    tls_cert = os.environ.get('NOTELY_TLS_CERT') or os.path.join(BASE_DIR, 'certs', 'notely.crt')
    tls_key = os.environ.get('NOTELY_TLS_KEY') or os.path.join(BASE_DIR, 'certs', 'notely.key')
    if not os.path.exists(tls_cert) or not os.path.exists(tls_key):
        sys.exit(
            'NOTELY: HTTPS is required. Provide NOTELY_TLS_CERT and NOTELY_TLS_KEY, '
            f'or place a cert/key at {tls_cert} and {tls_key}.'
        )
    print(f'NOTELY: HTTPS enabled ({tls_cert}).', flush=True)
    print('NOTELY: production use requires HTTPS reverse proxy + NOTELY_COOKIE_SECURE=1 '
          '(default Secure ON) + gunicorn (Werkzeug dev server is single-process).', flush=True)
    app.run(host=bind_host, port=port, threaded=True,
            ssl_context=build_tls_context(tls_cert, tls_key))
