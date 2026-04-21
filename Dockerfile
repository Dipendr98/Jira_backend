# ── Stage 1: Build ───────────────────────────────────────────────────────────
# node:20-bookworm-slim = Debian 12 + glibc + OpenSSL 3.0.x
# Prisma detects this correctly and generates the native binary (not WASM).
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Install OpenSSL so Prisma can detect the version and link correctly.
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY tsconfig.json ./
COPY prisma ./prisma/

RUN npm ci

# Dummy DATABASE_URL so `prisma generate` passes schema validation at build time.
# The real DATABASE_URL is injected by Railway at RUNTIME via environment variables.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
RUN npx prisma generate

COPY src ./src
RUN npm run build

# ── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS production

WORKDIR /app

# OpenSSL required at runtime so Prisma native binary works (not WASM fallback).
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

# Set dummy DATABASE_URL BEFORE npm ci so @prisma/client postinstall hook
# does not fail if it tries to validate the schema during installation.
# Railway overrides this with the real DATABASE_URL at runtime.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"

RUN npm ci --only=production

# ── Artefacts from builder ────────────────────────────────────────────────────
# Compiled app
COPY --from=builder /app/dist ./dist

# Prisma generated client (native debian-openssl-3.0.x binary + js client)
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# Schema + migrations (needed for `prisma migrate deploy` at startup)
COPY prisma ./prisma

# Startup script: runs migrations then starts the server.
# Migration failure is non-fatal so the HTTP server always comes up
# and Railway's health check can succeed even if DATABASE_URL is not
# yet configured. Set DATABASE_URL in Railway env vars and redeploy.
COPY start.sh ./start.sh
RUN chmod +x ./start.sh

ENV NODE_ENV=production

EXPOSE 3000

CMD ["/app/start.sh"]
