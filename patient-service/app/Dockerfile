# ── Stage 1: install dependencies ─────────────────────────────────────────
FROM python:3.11-slim AS builder

WORKDIR /build

COPY app/requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

# ── Stage 2: lean production image ────────────────────────────────────────
FROM python:3.11-slim

WORKDIR /app

# HIPAA: run as non-root user
RUN adduser --disabled-password --gecos "" mediflow

# Copy only installed packages from builder
COPY --from=builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=builder /usr/local/bin/gunicorn /usr/local/bin/gunicorn

# Copy application code
COPY app/ .

# Switch to non-root user before running
USER mediflow

EXPOSE 5000

# 4 workers, timeout for DB queries, bind to all interfaces
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "4", "--timeout", "120", "app:app"]