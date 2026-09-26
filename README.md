# Dives

A multi-user scuba dive logbook. Each user privately logs and manages their own
dives: structured, reusable dive sites with GPS, manual dive parameters
(depths, bottom time, water temp, visibility, gas mix, tank, weight, suit,
conditions, buddy, operator, notes, rating) plus an optional depth-over-time
profile. Every dive create/edit/delete also emails the user a backup copy of
that dive.

Deployed at [dives.aleksandr.vin](https://dives.aleksandr.vin) as pumpking
project `dev-dives`.

## Stack

- Next.js (App Router) + React, TypeScript, Tailwind + shadcn/ui + Radix
- Postgres via raw `pg` (no ORM), numbered SQL migrations in `migrations/`
- Authentik (OIDC) for authentication
- Email backups through a Postgres outbox (`notification_queue`) drained by a
  Kubernetes CronJob over Proton SMTP
- OpenTelemetry traces/metrics/logs, `pino` logging
- Deployed with Helm (`helm-charts/`) onto pumpking

## Getting started

```sh
pnpm install
docker-compose up -d postgres
pnpm db:migrate

# Start the main Next.js development server
pnpm dev
```

To run the Garmin Connect integration sidecar locally (required for Garmin syncing):
```sh
# The sidecar has its own isolated dependencies that must be installed first
cd scripts/garmin-sidecar
npm install
cd ../..

# Run the sidecar in a separate terminal
pnpm garmin:sidecar
```

See [`docs/development.md`](docs/development.md) for the full local setup,
migration conventions, auth, email/notification-queue mechanics, tests and
deployment notes, and [`AGENTS.md`](AGENTS.md) for the working conventions in
this repo.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Next.js dev server |
| `pnpm build` | Production build |
| `pnpm test` | Typecheck + unit tests |
| `pnpm test:pg` | Postgres-backed integration tests |
| `pnpm test:e2e` | Playwright (WebKit) end-to-end tests |
| `pnpm lint` / `pnpm lint:unused` | ESLint / knip |
| `pnpm db:migrate` | Apply `migrations/*.sql` |
| `pnpm notifications:process` | Drain the notification queue once |
| `pnpm suunto:sidecar` | Run the local pod-style suuntool sidecar wrapper |
| `pnpm garmin:sidecar` | Run the local Node.js Garmin Connect sidecar |

This repo was scaffolded from the upstream 21daylabs Next.js template; see
"Project identity" in `AGENTS.md` for what was and wasn't carried over.
