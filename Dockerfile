# syntax=docker/dockerfile:1
#
# LeadRadar — one Dockerfile, two runtime targets.
#
# The web tier and the worker tier deploy SEPARATELY, because BullMQ workers hold
# blocking Redis reads and must live in a long-running process — they cannot be a
# serverless function or a Next.js route. But they share a codebase, so they share
# a build and diverge only at the final stage. Building them from two Dockerfiles
# would let their dependencies drift apart, which is the failure where a job
# processes differently from how the web tier expects.
#
# Build:
#   docker build --target web    -t leadradar-web .
#   docker build --target worker -t leadradar-worker .

# ---------------------------------------------------------------------------
# deps — install once, reuse for every stage
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app

# Copied before the source so a source change does not invalidate the install
# layer. `npm ci` for a reproducible tree from the lockfile.
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# deps-prod — runtime dependencies only
# ---------------------------------------------------------------------------
#
# The worker previously reused the full `deps` tree, which put vitest, eslint,
# prettier, next and the Prisma CLI into the production image: 1.54GB, and every
# devDependency advisory became a production advisory. `tsx` is the one dev tool
# the worker genuinely needs at runtime, so it moved to `dependencies` and this
# stage installs nothing else.
FROM node:22-alpine AS deps-prod
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# builder — Prisma client + Next.js build
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The Prisma client is generated code; it must exist before typecheck or build.
RUN npx prisma generate

# Build-time configuration only.
#
# `next build` evaluates env.ts while tracing modules, so it needs values that
# parse — but NO provider credentials are required, because MOCK_EXTERNAL_APIS
# short-circuits the live-credential check. That is deliberate: an image build
# that needs real API keys is one where those keys end up in a layer, and layers
# get pushed to registries.
#
# NODE_ENV is left unset here. `next build` emits a production build regardless,
# and setting it to `production` would trip the guard that (correctly) forbids
# mock mode in production — forcing exactly the placeholder credentials this
# avoids. The runtime stages set NODE_ENV=production, which is where it matters.
ENV NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL=postgresql://build:build@localhost:5432/build \
    REDIS_URL=redis://localhost:6379 \
    MOCK_EXTERNAL_APIS=true

RUN npm run build

# ---------------------------------------------------------------------------
# web — the Next.js server
# ---------------------------------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

# Non-root. This process is internet-facing and fetches third-party URLs; a
# container escape should not start from uid 0.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Prisma schema and migrations travel with the image so `prisma migrate deploy`
# can run from the same artifact that will serve traffic — the migration and the
# code that depends on it are then provably the same version.
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma

USER nextjs
EXPOSE 3000

# Hits the real health endpoint, which checks PostgreSQL and Redis. A check that
# only proved the process was listening would report healthy while every request
# failed on a dead database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

# ---------------------------------------------------------------------------
# worker — BullMQ consumers
# ---------------------------------------------------------------------------
FROM node:22-alpine AS worker
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs worker

# The worker runs TypeScript through tsx rather than a compiled bundle, so it
# needs real node_modules — `output: 'standalone'` traces only what the Next.js
# server reaches, and the worker's entry point is not in that trace. It takes the
# production-only tree: tsx is a runtime dependency, the rest of the dev toolchain
# is not.
COPY --from=deps-prod --chown=worker:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=worker:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --chown=worker:nodejs package.json tsconfig.json ./
COPY --chown=worker:nodejs src ./src
COPY --chown=worker:nodejs prisma ./prisma

USER worker

# SIGTERM arrives on every deploy. The worker drains in-flight jobs on it; killing
# it instead leaves jobs locked until their lock expires, which for a two-minute
# scrape means two minutes of a lead in limbo and then a duplicate fetch that
# costs another credit. `--init` in compose ensures the signal actually arrives.
STOPSIGNAL SIGTERM

# `node` directly, NOT `npx tsx`.
#
# Measured: with `CMD ["npx", "tsx", ...]`, `docker stop -t 40` took 60s, the
# container exited 143, and the shutdown handler logged nothing — the drain never
# ran. `npx` and the `tsx` CLI shim each sit between the init process and node,
# and neither forwards SIGTERM, so the signal never reached the process holding
# the BullMQ locks. Every deploy was a hard kill, which is precisely the
# behaviour the STOPSIGNAL above exists to avoid.
#
# `node --import tsx` makes node the direct child of the init process, so the
# signal arrives where the handler is installed.
CMD ["node", "--import", "tsx", "src/workers/index.ts"]
