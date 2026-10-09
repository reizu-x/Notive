# Containerfile — Notive app image (podman build / docker build).
#
# Separate container from Postgres by design: this image holds the Python
# app only. Single gunicorn worker + threads is load-bearing (see
# gunicorn.conf.py) — do not raise workers without reworking SSE streams
# and the backup loop.
# Offline-safe builds: pypi/apt round-trips are impossible while VPS egress
# is blocked upstream. apt layer stays cache-hit; python deps come from the
# vendored wheelhouse (see README "Wheelhouse" section) instead of pypi.
FROM docker.io/library/python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# postgresql-client = pg_dump for the in-app hourly backup thread.
# curl = container healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
      postgresql-client curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/notive
COPY requirements.txt ./
COPY wheels/ ./wheels/
RUN pip install --no-cache-dir --no-index --find-links=/srv/notive/wheels -r requirements.txt
RUN rm -rf /srv/notive/wheels

COPY server.py gunicorn.conf.py index.html styles.css ./
COPY js/ ./js/
COPY vendor/ ./vendor/

# Runtime state (key, backups) lives on the /data volume, never in the image.
# Certs are mounted read-only at deploy time (never baked in: private key).
ENV NOTIVE_KEY_PATH=/data/notive.key \
    NOTIVE_BACKUP_DIR=/data/dbbackup \
    PORT=5001

EXPOSE 5001

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -sk -o /dev/null -w "%{http_code}" https://localhost:5001/ | grep -q 200

CMD ["python", "-m", "gunicorn", "-c", "gunicorn.conf.py", "server:app"]
