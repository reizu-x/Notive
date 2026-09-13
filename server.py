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
import ssl
import struct
import sys
import threading
import time

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from flask import Flask, jsonify, request, send_from_directory
from flask_sock import Sock
from argon2.low_level import Type as Argon2Type, hash_secret_raw

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get('NOTELY_DB_PATH', os.path.join(BASE_DIR, 'notely.db'))
KEY_PATH = os.environ.get('NOTELY_KEY_PATH', os.path.join(BASE_DIR, 'notely.key'))
# Automatic backups: SQLite online-backup copies of DB_PATH, taken on a daemon
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
SHARE_MAX_BYTES = NOTES_MAX_TOTAL_BYTES
NOTES_MAX_REQUEST_BYTES = 7 * 1024 * 1024

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
                'vendor/argon2/argon2.js', 'vendor/argon2/argon2-wrapper.js', 'vendor/argon2/argon2.wasm',
                'vendor/qrcode/qrcode.min.js'}

app = Flask(__name__)
# Hard cap on request bodies (chunked bodies without Content-Length included).
app.config['MAX_CONTENT_LENGTH'] = NOTES_MAX_REQUEST_BYTES + 1024
# WebSocket support for live collaborative-note sync (yjs updates relayed).
sock = Sock(app)


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
    """An account is E2EE once it carries wrapped-key material and a verifier.

    Accepts either the raw verifier (legacy, pre-pepper) or the peppered one
    (auth_hash2). Raw is dropped once a row is peppered (M-4 migration)."""
    try:
        verifier = row['auth_hash'] or row['auth_hash2']
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
WEAK_SCREEN_MAX = max(1, int(os.environ.get('NOTELY_WEAK_SCREEN_MAX', '48')))
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
    cose, pos = cbor_decode_minimal(bytes(cose_bytes), 0)
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
    from cryptography.exceptions import InvalidSignature
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
    # MFA TOTP (optional, non-breaking): secret encrypted with DB_KEY, confirmed
    # flag so setup must be verified before login starts challenging.
    conn.execute(
        'CREATE TABLE IF NOT EXISTS mfa_totp ('
        'username TEXT PRIMARY KEY, enc_secret BLOB NOT NULL, '
        'confirmed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, '
        'last_used INTEGER NOT NULL DEFAULT 0)'
    )
    # Short-lived MFA tickets issued after password-verifier passes but before
    # TOTP passes. Ticket is SHA256 hash only; plaintext goes to client once.
    conn.execute(
        'CREATE TABLE IF NOT EXISTS mfa_challenges ('
        'ticket_hash TEXT PRIMARY KEY, username TEXT NOT NULL, '
        'expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)'
    )
    # Retired table (MFA-bypass codes, removed 2026-09): account recovery now
    # clears MFA itself, so the second code system is unnecessary. Drop once
    # if left over from an older database; nothing references it anymore.
    conn.execute('DROP TABLE IF EXISTS recovery_codes')
    # Email password-reset tokens (hashes only, 15-min expiry, single-use).
    conn.execute(
        'CREATE TABLE IF NOT EXISTS email_recovery ('
        'token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, '
        'expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, used_at INTEGER)'
    )
    conn.execute('CREATE INDEX IF NOT EXISTS idx_email_recovery_user ON email_recovery (username)')
    # Password-loss recovery (E2EE-safe): client generates high-entropy codes,
    # wraps the master key locally (Argon2 KEK + AES-GCM) and uploads ONLY
    # {codeHash, salt, iv+data}. Server never sees codes or keys; lookup is by
    # hash so even the lookup does not reveal the code.
    conn.execute(
        'CREATE TABLE IF NOT EXISTS account_recovery ('
        'code_hash TEXT PRIMARY KEY, username TEXT NOT NULL, '
        'salt BLOB NOT NULL, wrapped_key BLOB NOT NULL, '
        'created_at INTEGER NOT NULL, used_at INTEGER)'
    )
    conn.execute('CREATE INDEX IF NOT EXISTS idx_acct_recovery_user ON account_recovery (username)')
    # Passkeys (WebAuthn, option-1 login): public creds only. Private keys never
    # leave the authenticator. Challenges short-lived, hashes stored.
    conn.execute(
        'CREATE TABLE IF NOT EXISTS passkey_creds ('
        'cred_id TEXT PRIMARY KEY, username TEXT NOT NULL, '
        'pubkey BLOB NOT NULL, sign_count INTEGER NOT NULL DEFAULT 0, '
        'transports TEXT NOT NULL DEFAULT \'\', created_at INTEGER NOT NULL)'
    )
    # Migration for PRF passwordless unlock (nullable: older creds lack it and
    # keep the password-unlock fallback).
    cred_cols = {row['name'] for row in conn.execute('PRAGMA table_info(passkey_creds)')}
    if 'prf_wrap' not in cred_cols:
        conn.execute('ALTER TABLE passkey_creds ADD COLUMN prf_wrap BLOB')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_passkey_user ON passkey_creds (username)')
    # PRF salt for passwordless unlock (one per user; each credential yields
    # its own secret from it, so per-cred wraps stay independent).
    conn.execute(
        'CREATE TABLE IF NOT EXISTS passkey_prf ('
        'username TEXT PRIMARY KEY, salt BLOB NOT NULL, created_at INTEGER NOT NULL)'
    )
    conn.execute(
        'CREATE TABLE IF NOT EXISTS passkey_challenges ('
        'chash TEXT PRIMARY KEY, username TEXT NOT NULL, kind TEXT NOT NULL, '
        'expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)'
    )
    # Pepper migration (toward OPAQUE, non-breaking): auth_hash2 =
    # HMAC(DB_KEY, 'notely-auth-v1:' + auth_hash). Old rows have NULL and keep
    # working via raw compare, then upgrade on next successful login.
    if 'auth_hash2' not in user_cols:
        conn.execute('ALTER TABLE users ADD COLUMN auth_hash2 BLOB')
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
                encrypt_profile({'firstName': first, 'lastName': last, 'subtitle': subtitle, 'email': ''}),
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
    # E2EE collaborative notes: each account publishes an ECDH P-256 public key
    # and its private key encrypted under the account master key (opaque). A
    # collaborative note has a random content key wrapped to each member's
    # public key; live Yjs CRDT updates are encrypted with that key. The server
    # stores/relays only ciphertext and can never read a note.
    conn.execute(
        'CREATE TABLE IF NOT EXISTS user_keys ('
        'username TEXT PRIMARY KEY, pubkey BLOB NOT NULL, enc_priv BLOB NOT NULL, '
        'algo TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)'
    )
    conn.execute(
        'CREATE TABLE IF NOT EXISTS collab_notes ('
        'id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, '
        'created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, enc_state BLOB)'
    )
    conn.execute(
        'CREATE TABLE IF NOT EXISTS collab_members ('
        'note_id INTEGER NOT NULL, username TEXT NOT NULL, wrapped_key BLOB NOT NULL, '
        'eph_pub BLOB NOT NULL, wrap_iv BLOB NOT NULL, added_at INTEGER NOT NULL, '
        'PRIMARY KEY (note_id, username))'
    )
    conn.execute(
        'CREATE TABLE IF NOT EXISTS collab_updates ('
        'id INTEGER PRIMARY KEY AUTOINCREMENT, note_id INTEGER NOT NULL, '
        'payload BLOB NOT NULL, created_at INTEGER NOT NULL)'
    )
    conn.execute('CREATE INDEX IF NOT EXISTS idx_collab_updates ON collab_updates (note_id, id)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_collab_members_user ON collab_members (username)')
    # Retired: the async one-way snapshot shares table (replaced by collab_*).
    conn.execute('DROP TABLE IF EXISTS shared_notes')
    conn.commit()
    conn.close()
    # Harden file perms: DB holds verifier material + opaque blobs. 0600 even
    # if umask created it 0644.
    try:
        os.chmod(DB_PATH, 0o600)
    except OSError:
        pass


# --- Automatic DB backups (SQLite online-backup on a daemon thread) ---

# Copy DB_PATH into BACKUP_DIR as notely-<timestamp>.db via sqlite3's backup
# API, which takes a consistent snapshot even while the server is writing.
# Uses a temp name + atomic rename so a crash mid-copy never leaves a truncated
# file looking like a valid backup. Returns the final path, or None on failure.
def take_db_backup():
    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = time.strftime('%Y%m%d-%H%M%S', time.localtime())
    final_path = os.path.join(BACKUP_DIR, f'notely-{stamp}.db')
    tmp_path = final_path + '.tmp'
    try:
        src = sqlite3.connect(DB_PATH)
        dst = sqlite3.connect(tmp_path)
        try:
            with dst:
                src.backup(dst)
        finally:
            src.close()
            dst.close()
        os.replace(tmp_path, final_path)
    except Exception as error:
        print(f'NOTELY BACKUP: failed: {error}', flush=True)
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        return None
    try:
        os.chmod(final_path, 0o600)
    except OSError:
        pass
    _prune_old_backups()
    return final_path


# Keep only the newest BACKUP_KEEP timestamped copies; never touch .tmp files
# (take_db_backup cleans its own) or anything else a user may keep there.
def _prune_old_backups():
    try:
        names = sorted(n for n in os.listdir(BACKUP_DIR)
                       if n.startswith('notely-') and n.endswith('.db'))
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


# --- Security audit logging + alerting (OWASP A09) -------------------------
# Structured JSONL of security-relevant events (auth outcomes, recovery, MFA,
# CSRF rejects, rate-limit trips, unhandled errors). Written append-only; the
# optional NOTELY_ALERT_WEBHOOK receives a POST for events at or above
# NOTELY_ALERT_MIN_SEVERITY (default 'high'). Callers pass identifiers only —
# never passwords, verifiers or key material.
AUDIT_LOG_PATH = os.environ.get('NOTELY_AUDIT_LOG', os.path.join(BASE_DIR, 'audit.log'))
AUDIT_ENABLED = os.environ.get('NOTELY_AUDIT', '1').lower() != '0'
ALERT_WEBHOOK = os.environ.get('NOTELY_ALERT_WEBHOOK', '').strip()
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
            with open(AUDIT_LOG_PATH, 'a') as handle:
                handle.write(line + '\n')
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
    if filename in PUBLIC_FILES or filename.startswith('vendor/'):
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
        # style-src keeps 'unsafe-inline': the static shell uses a handful of
        # inline style attributes. Refactoring those to classes would allow a
        # fully strict style-src (see hardening backlog).
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "img-src 'self' https: data:; "
        "font-src 'self' https://fonts.gstatic.com; "
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
        ok = verify_auth_hash(candidate, user)
        if not ok:
            # Burn equal PBKDF2 work so a wrong verifier on a real account
            # costs the same as an unknown-user attempt (timing-oracle fix).
            hashlib.pbkdf2_hmac('sha256', secrets.token_bytes(16), _DUMMY_SALT, PBKDF2_ITERATIONS)
            rate_hit(conn, ip_bucket('login'))
            rate_hit(conn, user_bucket)
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
                profile = decrypt_profile(user['enc_profile'])
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
             encrypt_profile({'firstName': first, 'lastName': last, 'subtitle': 'Personal space', 'email': email}),
             int(time.time()), salt_auth, salt_enc, (None if auth_hash2 else auth_hash), wrap_iv + wrap_ct,
             'argon2id', json.dumps(ARGON2_DESCRIPTOR), auth_hash2),
        )
        conn.commit()
    except sqlite3.IntegrityError:
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
            (new_salt_auth, new_salt_enc, new_auth, new_wrap_iv + new_wrap_ct,
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
        (new_salt_auth, new_salt_enc, new_auth, new_wrap_iv + new_wrap_ct,
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
        (user['username'], encrypt_notes(cleaned), now, b''),
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


@app.route('/api/vault-meta', methods=['GET'])
def api_vault_meta_get():
    """Return the vault verifier material (salts + wrapped key) for unlocking.
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
    # Server-side weak-password screen for the vault verifier. The vault
    # password never reaches the server, but a trivially weak one can be
    # rejected here (same tiny-dictionary check as account registration).
    if is_weak_vault_verifier(verifier, salt_auth):
        rate_hit(conn, ip_bucket('vault'))
        rate_hit(conn, 'vault:' + user['username'].lower())
        conn.close()
        return jsonify({'error': 'Vault password too weak: choose a longer, less common password.'}), 400
    existing = conn.execute('SELECT verifier FROM vault_meta WHERE username = ?',
                            (user['username'],)).fetchone()
    if existing and not vault_proof_ok(conn, user['username'], data, existing['verifier']):
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
    if not vault_proof_ok(conn, user['username'], data, existing['verifier']):
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
        (user['username'], encrypt_blob(secret), int(time.time())),
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
        secret = bytes(decrypt_blob(bytes(row['enc_secret'])))
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
        secret = bytes(decrypt_blob(bytes(row['enc_secret'])))
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
        secret = bytes(decrypt_blob(bytes(mfa['enc_secret'])))
    except Exception:
        conn.close()
        return jsonify({'error': 'MFA error.'}), 500
    ok = totp_verify(secret, str(data.get('code', '')))
    if not ok:
        rate_hit(conn, ip_bucket('mfa'))
        rate_hit(conn, user_mfa_bucket)
        conn.close()
        return jsonify({'error': 'Incorrect code.'}), 401
    conn.execute('DELETE FROM mfa_challenges WHERE ticket_hash = ?', (digest,))
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
        profile = decrypt_profile(user['enc_profile'])
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
    conn.close()
    return jsonify({'keys': [{'id': r['cred_id'], 'created_at': r['created_at'],
                              'transports': r['transports'],
                              'passwordless': bool(r['prf_wrap'])} for r in rows]})


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
                     'subtitle': profile.get('subtitle', 'Personal space'),
                     'email': email,
                 }), user['username']))
    conn.commit()
    conn.close()
    return jsonify({'ok': True, 'email': email})


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
    conn.commit()
    conn.close()
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
    try:
        pubkey = base64.b64decode(str(data.get('pubkey', '')).encode('ascii'), validate=True)
        enc_priv = base64.b64decode(str(data.get('encPriv', '')).encode('ascii'), validate=True)
    except (base64.binascii.Error, ValueError, AttributeError):
        return jsonify({'error': 'Invalid key payload.'}), 400
    # Raw P-256 point is 65 bytes; wrapped private key is nonce(12)+ct(>=48).
    if len(pubkey) != 65 or not (60 <= len(enc_priv) <= 4096):
        return jsonify({'error': 'Invalid key payload.'}), 400
    now = int(time.time())
    conn = get_db()
    conn.execute(
        'INSERT INTO user_keys (username, pubkey, enc_priv, algo, created_at, updated_at)'
        ' VALUES (?, ?, ?, ?, ?, ?)'
        ' ON CONFLICT(username) DO UPDATE SET pubkey = excluded.pubkey,'
        ' enc_priv = excluded.enc_priv, algo = excluded.algo, updated_at = excluded.updated_at',
        (user['username'], pubkey, enc_priv, algo, now, now),
    )
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/keys/me', methods=['GET'])
def api_keys_me():
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    row = conn.execute('SELECT pubkey, enc_priv, algo, updated_at FROM user_keys WHERE username = ?',
                       (user['username'],)).fetchone()
    conn.close()
    if not row:
        return jsonify({'exists': False})
    return jsonify({
        'exists': True,
        'algo': row['algo'],
        'pubkey': base64.b64encode(bytes(row['pubkey'])).decode('ascii'),
        'encPriv': base64.b64encode(bytes(row['enc_priv'])).decode('ascii'),
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
    row = conn.execute('SELECT pubkey, algo FROM user_keys WHERE username = ?', (target,)).fetchone()
    conn.commit()
    conn.close()
    if not row:
        return jsonify({'error': 'That account has not set up sharing yet. Ask them to log in to Notely once, then try again.'}), 404
    return jsonify({
        'username': target,
        'algo': row['algo'],
        'pubkey': base64.b64encode(bytes(row['pubkey'])).decode('ascii'),
    })


# --- E2EE collaborative notes (live, server-blind) ------------------------
# A collaborative note has a random 256-bit key generated on a client. The key
# is wrapped to each member's ECDH public key and stored here (opaque). Live
# edits are Yjs CRDT updates, AES-GCM encrypted with that key, relayed over a
# WebSocket and stored as an append-only log. The server can never read them.

import base64 as _b64

collab_rooms = {}  # note_id -> set of live websocket connections


def _is_collab_member(conn, note_id, username):
    return conn.execute('SELECT 1 FROM collab_members WHERE note_id = ? AND username = ?',
                        (note_id, username)).fetchone() is not None


@app.route('/api/collab', methods=['POST'])
def api_collab_create():
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    data = json_object()
    try:
        wrapped_key = _b64.b64decode(str(data.get('wrappedKey', '')).encode('ascii'), validate=True)
        eph_pub = _b64.b64decode(str(data.get('ephPub', '')).encode('ascii'), validate=True)
        wrap_iv = _b64.b64decode(str(data.get('wrapIv', '')).encode('ascii'), validate=True)
    except (ValueError, AttributeError, _b64.binascii.Error):
        return jsonify({'error': 'Invalid key payload.'}), 400
    if len(eph_pub) != 65 or len(wrap_iv) != 12 or not (48 <= len(wrapped_key) <= 80):
        return jsonify({'error': 'Invalid key payload.'}), 400
    now = int(time.time())
    conn = get_db()
    cur = conn.execute('INSERT INTO collab_notes (owner, created_at, updated_at, enc_state) VALUES (?, ?, ?, NULL)',
                       (user['username'], now, now))
    note_id = cur.lastrowid
    conn.execute('INSERT OR REPLACE INTO collab_members (note_id, username, wrapped_key, eph_pub, wrap_iv, added_at)'
                 ' VALUES (?, ?, ?, ?, ?, ?)',
                 (note_id, user['username'], wrapped_key, eph_pub, wrap_iv, now))
    conn.commit()
    conn.close()
    return jsonify({'ok': True, 'id': note_id})


@app.route('/api/collab', methods=['GET'])
def api_collab_list():
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    rows = conn.execute(
        'SELECT n.id, n.owner, n.updated_at,'
        ' (SELECT COUNT(*) FROM collab_members m2 WHERE m2.note_id = n.id) AS members'
        ' FROM collab_notes n JOIN collab_members m ON m.note_id = n.id'
        ' WHERE m.username = ? ORDER BY n.updated_at DESC LIMIT 200',
        (user['username'],),
    ).fetchall()
    conn.close()
    return jsonify({'notes': [{'id': r['id'], 'owner': r['owner'], 'updatedAt': r['updated_at'], 'members': r['members']} for r in rows]})


@app.route('/api/collab/<int:note_id>', methods=['GET'])
def api_collab_get(note_id):
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    if not _is_collab_member(conn, note_id, user['username']):
        conn.close()
        return jsonify({'error': 'Not a member of this note.'}), 403
    row = conn.execute('SELECT id, owner, updated_at, enc_state FROM collab_notes WHERE id = ?', (note_id,)).fetchone()
    mine = conn.execute('SELECT wrapped_key, eph_pub, wrap_iv FROM collab_members WHERE note_id = ? AND username = ?',
                        (note_id, user['username'])).fetchone()
    members = [r['username'] for r in conn.execute('SELECT username FROM collab_members WHERE note_id = ? ORDER BY added_at', (note_id,))]
    conn.close()
    if not row or not mine:
        return jsonify({'error': 'Not found.'}), 404
    return jsonify({
        'id': row['id'],
        'owner': row['owner'],
        'updatedAt': row['updated_at'],
        'members': members,
        'myKey': {
            'wrappedKey': _b64.b64encode(bytes(mine['wrapped_key'])).decode('ascii'),
            'ephPub': _b64.b64encode(bytes(mine['eph_pub'])).decode('ascii'),
            'wrapIv': _b64.b64encode(bytes(mine['wrap_iv'])).decode('ascii'),
        },
        'hasState': bool(row['enc_state']),
    })


@app.route('/api/collab/<int:note_id>/members', methods=['POST'])
def api_collab_add_member(note_id):
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    data = json_object()
    target = str(data.get('username', '')).strip()
    if not validate_username(target):
        return jsonify({'error': 'Invalid username.'}), 400
    try:
        wrapped_key = _b64.b64decode(str(data.get('wrappedKey', '')).encode('ascii'), validate=True)
        eph_pub = _b64.b64decode(str(data.get('ephPub', '')).encode('ascii'), validate=True)
        wrap_iv = _b64.b64decode(str(data.get('wrapIv', '')).encode('ascii'), validate=True)
    except (ValueError, AttributeError, _b64.binascii.Error):
        return jsonify({'error': 'Invalid key payload.'}), 400
    conn = get_db()
    if not _is_collab_member(conn, note_id, user['username']):
        conn.close()
        return jsonify({'error': 'Not a member of this note.'}), 403
    if not conn.execute('SELECT 1 FROM users WHERE username = ?', (target,)).fetchone():
        conn.close()
        return jsonify({'error': 'No such account.'}), 404
    if len(eph_pub) != 65 or len(wrap_iv) != 12 or not (48 <= len(wrapped_key) <= 80):
        conn.close()
        return jsonify({'error': 'Invalid key payload.'}), 400
    conn.execute('INSERT OR REPLACE INTO collab_members (note_id, username, wrapped_key, eph_pub, wrap_iv, added_at)'
                 ' VALUES (?, ?, ?, ?, ?, ?)',
                 (note_id, target, wrapped_key, eph_pub, wrap_iv, int(time.time())))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/collab/<int:note_id>/members/<username>', methods=['DELETE'])
def api_collab_remove_member(note_id, username):
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    row = conn.execute('SELECT owner FROM collab_notes WHERE id = ?', (note_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({'ok': True})
    if row['owner'] != user['username'] and username != user['username']:
        conn.close()
        return jsonify({'error': 'Only the owner can remove members.'}), 403
    conn.execute('DELETE FROM collab_members WHERE note_id = ? AND username = ?', (note_id, username))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/collab/<int:note_id>', methods=['DELETE'])
def api_collab_delete(note_id):
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    conn = get_db()
    row = conn.execute('SELECT owner FROM collab_notes WHERE id = ?', (note_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({'ok': True})
    if row['owner'] != user['username']:
        conn.close()
        return jsonify({'error': 'Only the owner can delete this note.'}), 403
    conn.execute('DELETE FROM collab_notes WHERE id = ?', (note_id,))
    conn.execute('DELETE FROM collab_members WHERE note_id = ?', (note_id,))
    conn.execute('DELETE FROM collab_updates WHERE note_id = ?', (note_id,))
    conn.commit()
    conn.close()
    # Drop any live connections.
    for ws in list(collab_rooms.get(note_id, ())):
        try: ws.close()
        except Exception: pass
    collab_rooms.pop(note_id, None)
    return jsonify({'ok': True})


@app.route('/api/collab/<int:note_id>/compact', methods=['POST'])
def api_collab_compact(note_id):
    # A member uploads the full encrypted CRDT state; the update log resets.
    user = current_session_user()
    if not user:
        return jsonify({'error': 'Not signed in.'}), 401
    data = json_object()
    try:
        payload = _b64.b64decode(str(data.get('state', '')).encode('ascii'), validate=True)
    except (ValueError, AttributeError, _b64.binascii.Error):
        return jsonify({'error': 'Invalid state.'}), 400
    if not (1 <= len(payload) <= SHARE_MAX_BYTES):
        return jsonify({'error': 'State too large.'}), 413
    conn = get_db()
    if not _is_collab_member(conn, note_id, user['username']):
        conn.close()
        return jsonify({'error': 'Not a member of this note.'}), 403
    conn.execute('UPDATE collab_notes SET enc_state = ?, updated_at = ? WHERE id = ?', (payload, int(time.time()), note_id))
    conn.execute('DELETE FROM collab_updates WHERE note_id = ?', (note_id,))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@sock.route('/ws/collab/<int:note_id>')
def ws_collab(ws, note_id):
    # Authenticate + authorise from the session cookie; block cross-site opens.
    origin = request.headers.get('Origin')
    if origin:
        from urllib.parse import urlparse
        try:
            if (urlparse(origin).hostname or '').lower() != (request.host.split(':')[0] or '').lower():
                ws.close()
                return
        except Exception:
            ws.close()
            return
    user = current_session_user()
    if not user:
        ws.close()
        return
    conn = get_db()
    if not _is_collab_member(conn, note_id, user['username']):
        conn.close()
        ws.close()
        return
    state_row = conn.execute('SELECT enc_state FROM collab_notes WHERE id = ?', (note_id,)).fetchone()
    backlog = [bytes(r['payload']) for r in conn.execute('SELECT payload FROM collab_updates WHERE note_id = ? ORDER BY id', (note_id,))]
    conn.close()
    # Late joiner: send the last compacted state, then every update since.
    if state_row and state_row['enc_state']:
        try:
            ws.send(json.dumps({'type': 'state', 'payload': _b64.b64encode(bytes(state_row['enc_state'])).decode('ascii')}))
        except Exception:
            return
    for u in backlog:
        try:
            ws.send(json.dumps({'type': 'update', 'payload': _b64.b64encode(u).decode('ascii')}))
        except Exception:
            return
    room = collab_rooms.setdefault(note_id, set())
    room.add(ws)
    try:
        while True:
            message = ws.receive()
            if message is None:
                break
            try:
                data = json.loads(message)
            except (ValueError, TypeError):
                continue
            if not isinstance(data, dict) or data.get('type') != 'update':
                continue
            try:
                payload = _b64.b64decode(str(data.get('payload', '')).encode('ascii'), validate=True)
            except (ValueError, AttributeError, _b64.binascii.Error):
                continue
            if not (1 <= len(payload) <= SHARE_MAX_BYTES):
                continue
            conn = get_db()
            conn.execute('INSERT INTO collab_updates (note_id, payload, created_at) VALUES (?, ?, ?)',
                         (note_id, payload, int(time.time())))
            conn.execute('UPDATE collab_notes SET updated_at = ? WHERE id = ?', (int(time.time()), note_id))
            # Cap the log; clients re-compact opportunistically.
            conn.execute('DELETE FROM collab_updates WHERE note_id = ? AND id NOT IN '
                         '(SELECT id FROM collab_updates WHERE note_id = ? ORDER BY id DESC LIMIT 5000)',
                         (note_id, note_id))
            conn.commit()
            conn.close()
            outgoing = json.dumps({'type': 'update', 'payload': data['payload']})
            for peer in list(collab_rooms.get(note_id, ())):
                if peer is ws:
                    continue
                try:
                    peer.send(outgoing)
                except Exception:
                    pass
    finally:
        collab_rooms.get(note_id, set()).discard(ws)


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
                 (new_salt_auth, new_auth, new_hash2, username))
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
                 (new_salt_auth, new_salt_enc, new_auth, new_iv + new_ct,
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
