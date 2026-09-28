# ── Stage 1: Install dependencies ──────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

# Copy package files first for better Docker layer caching.
# Docker caches each layer — if package.json hasn't changed, npm install is skipped.
COPY package.json package-lock.json ./

# Copy prisma schema so that `postinstall` (prisma generate) can run.
COPY prisma/schema.prisma prisma/schema.prisma
COPY prisma.config.ts prisma.config.ts

# Prisma generate (triggered by postinstall) needs DATABASE_URL to parse the
# schema, but no actual connection is made. This dummy value satisfies it.
ENV DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy"

RUN npm ci

# ── Stage 2: Build TypeScript ──────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Bring in everything from deps stage.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/generated ./generated

# Copy source code.
COPY package.json package-lock.json tsconfig.json tsconfig.scripts.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY src ./src

# Compile TypeScript to JavaScript (output goes to ./dist).
RUN npm run build

# ── Stage 3: Production image ─────────────────────────────────────────────────
FROM node:22-alpine AS production

WORKDIR /app

# Only copy what's needed to run.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/generated ./generated
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

# Copy prisma files so we can run migrations at startup.
COPY prisma ./prisma
COPY prisma.config.ts ./

# The backend listens on port 3000 by default.
EXPOSE 3000

# Run database migrations, seed demo data (idempotent), then start the server.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/prisma/seed.js && node dist/src/server.js"]
