# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.5.0 --activate

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile; \
  status=$?; \
  if [ "$status" -eq 0 ]; then \
    exit 0; \
  fi; \
  if [ "$status" -eq 134 ] \
    && [ -d node_modules/.pnpm ] \
    && [ -d node_modules/next ] \
    && [ -d node_modules/react ] \
    && [ -d node_modules/typescript ]; then \
    echo "pnpm install completed, ignoring Node/libuv exit 134 seen under linux/amd64 emulation"; \
    exit 0; \
  fi; \
  exit "$status"

FROM golang:1.26-bookworm AS suuntool-builder
ARG SUUNTOOL_VERSION=v0.8.0
RUN GOBIN=/out go install github.com/tajchert/suuntool@${SUUNTOOL_VERSION}

FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm test && pnpm build

FROM node:24-bookworm-slim AS runner
ENV HOSTNAME=0.0.0.0
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs --home-dir /app nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/migrations ./migrations
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=suuntool-builder /out/suuntool /usr/local/bin/suuntool

# The Garmin sidecar is not imported by the Next.js application, so standalone
# output tracing does not include its garmin-connect dependency. Install the
# sidecar's own production manifest in place; Node resolves it from the
# server.mjs directory without changing the app's traced node_modules tree.
RUN npm install --omit=dev --no-package-lock --prefix /app/scripts/garmin-sidecar

# `output: "standalone"` only traces node_modules actually reachable from the
# Next.js app's own bundle -- pg (used by scripts/*.mjs too) rides along for
# free because lib/db.ts already pulls it in for the app itself, but `ws`
# (scripts/ws-sidecar/server.mjs only, nothing in the app imports it) isn't
# reachable that way and gets pruned. Installed directly rather than copied
# from the deps stage: pnpm's node_modules there is a tree of symlinks into
# its content-addressed store, which a plain `COPY` doesn't dereference into
# something that exists in this image. `ws` has zero required runtime
# dependencies, so a plain npm install is simple and safe here -- done in an
# isolated directory rather than /app directly, since npm install trips a
# "Cannot read properties of null (reading 'matches')" error when run
# against the minimal package.json the standalone output just placed there.
RUN mkdir /tmp/ws-install \
  && cd /tmp/ws-install \
  && npm install --no-save --omit=dev ws@^8.21.3 \
  && cp -r /tmp/ws-install/node_modules/ws /app/node_modules/ws \
  && rm -rf /tmp/ws-install

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
