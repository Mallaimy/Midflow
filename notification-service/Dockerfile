# ── Stage 1: install dependencies ─────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# package*.json matches both package.json and package-lock.json
# Copy these first to leverage Docker layer caching —
# if dependencies haven't changed, this layer is reused
COPY package*.json ./

# Clean install using lockfile — reproducible across all environments
# --omit=dev is the modern equivalent of --only=production
RUN npm ci --omit=dev

# ── Stage 2: lean production image ────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# HIPAA: create non-root group and user
# -S = system account (no home dir, no password)
# -G = assign to group
RUN addgroup -S mediflow && adduser -S -G mediflow mediflow

# Copy only production node_modules from builder
# Nothing else from builder comes across — no npm cache, no build tools
COPY --from=builder /app/node_modules ./node_modules

# Copy application source code
COPY src/ ./src/

# Copy package.json — needed by Node.js at runtime
COPY package.json ./

# HIPAA: switch to non-root user as final step
# All setup above ran as root (required for file operations)
# App runs as mediflow (least privilege)
USER mediflow

# Document the port this service listens on
EXPOSE 3001

# Start the notification service
# Exec form — runs node directly, no shell wrapper
CMD ["node", "src/app.js"]