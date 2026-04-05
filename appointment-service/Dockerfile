# ── Stage 1: install dependencies ─────────────────────────────────────────
# Alpine is used for Node.js because it produces much smaller images
# than node:20-slim (~170MB vs ~300MB)
FROM node:20-alpine AS builder

# Set working directory — all subsequent commands run from here
WORKDIR /app

# Copy package files first (before source code)
# Docker caches each layer — if package.json hasn't changed,
# Docker reuses the cached npm ci layer and skips reinstalling.
# This makes rebuilds much faster during development.
COPY package*.json ./

# Install ONLY production dependencies
# npm ci = clean install, uses package-lock.json exactly (reproducible)
# --only=production = skip devDependencies (nodemon, jest, etc.)
RUN npm ci --only=production

# ── Stage 2: lean production image ────────────────────────────────────────
# Fresh Alpine image — nothing from builder except what we explicitly copy
# This means no npm cache, no build tools, nothing unnecessary
FROM node:20-alpine

WORKDIR /app

# HIPAA: create non-root user and group
# Alpine syntax is different from Debian — uses -S flag
# Running as non-root means if the app is exploited,
# the attacker doesn't get root access to the container
RUN addgroup -S mediflow && adduser -S -G mediflow mediflow

# Copy only production node_modules from builder stage
# We don't copy the entire builder — just what we need
COPY --from=builder /app/node_modules ./node_modules

# Copy application source code from your local machine into the image
COPY src/ ./src/

# Copy package.json — needed by Node.js to identify the app
COPY package.json ./

# Switch to non-root user as the final step before CMD
# Everything above ran as root (needed for setup)
# Everything below runs as mediflow (HIPAA least privilege)
USER mediflow

# Document which port the app listens on
# This doesn't actually open the port — that's done at runtime
# but it serves as documentation and works with docker run -P
EXPOSE 3000

# Start the application
# Using array form (exec form) — more reliable than string form
# String form runs via /bin/sh which adds an extra process
CMD ["node", "src/app.js"]