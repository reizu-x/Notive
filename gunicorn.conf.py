# gunicorn.conf.py — production entry for Notive.
#
# Run from this directory:
#   nohup gunicorn -c gunicorn.conf.py server:app > /home/r3izu/Documents/audit/server-dev.log 2>&1 &
#
# Design notes (do not "fix" without reading server.py first):
# - workers = 1 + gthread. collab_streams (live SSE subscriptions) and the
#   hourly pg_dump loop are per-process state: a second worker would split
#   streams (account-delete could no longer close them all) and double
#   backups. Concurrency comes from threads (I/O-bound workload; argon2 and
#   PG calls release the GIL).
# - TLS reuses server.build_tls_context verbatim (TLS >= 1.2, AEAD-only),
#   so the negotiated policy is identical to `python server.py`.
# - `python server.py` (Werkzeug) stays as the dev path; under gunicorn
#   __main__ never runs, so schema init + backup loop start in post_fork.
import os
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

wsgi_app = 'server:app'

workers = 1
worker_class = 'gthread'
threads = int(os.environ.get('NOTIVE_THREADS', '8'))

bind_host = os.environ.get('NOTIVE_BIND_HOST', '0.0.0.0')
bind_port = os.environ.get('PORT', '5001')
bind = [f'{bind_host}:{bind_port}']

# Same cert resolution as server.py (env override, else local CA-signed pair).
tls_cert = os.environ.get('NOTIVE_TLS_CERT') or os.path.join(BASE_DIR, 'certs', 'notive.crt')
tls_key = os.environ.get('NOTIVE_TLS_KEY') or os.path.join(BASE_DIR, 'certs', 'notive.key')
if not os.path.exists(tls_cert) or not os.path.exists(tls_key):
    sys.exit(
        'NOTIVE: HTTPS is required. Provide NOTIVE_TLS_CERT and NOTIVE_TLS_KEY, '
        f'or place a cert/key at {tls_cert} and {tls_key}.'
    )
# Required for is_ssl: without these gunicorn serves plain HTTP even with a
# custom ssl_context factory. The chain itself is loaded by ssl_context below.
certfile = tls_cert
keyfile = tls_key


def ssl_context(conf, default_factory):
    # Identical policy to the dev server: see server.build_tls_context.
    from server import build_tls_context
    return build_tls_context(tls_cert, tls_key)


def post_fork(server, worker):
    # __main__ never executes under gunicorn: init schema + backup loop here.
    # Runs once (workers = 1); init_db is idempotent (IF NOT EXISTS + ALTERs).
    from server import init_db, start_backup_thread
    init_db()
    start_backup_thread()
