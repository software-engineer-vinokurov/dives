# Local development

## Install

```sh
pnpm install
```

Node `>=24.0.0 <25` is required (pinned in `package.json` `engines`).

## Database

Postgres is the only backend (`lib/db.ts` / `lib/database-url.ts`, raw `pg`
driver against `DATABASE_URL`). Start a local Postgres and run the migrations
before `pnpm dev`:

```sh
docker-compose up -d postgres
pnpm db:migrate
```

(Use the standalone `docker-compose` binary; the `docker compose` v2 plugin
may not be installed on every machine.)

`pnpm db:migrate` runs `scripts/db-migrate.mjs` against the SQL files in
`migrations/`. It also bootstraps an admin user when these variables are set:

```sh
DIVES_ADMIN_EMAIL=admin@aleksandr.vin
DIVES_ADMIN_PASSWORD=change-me
```

### Migration numbering

This repo was scaffolded from the upstream 21daylabs Next.js template and
kept only that template's auth/session/notification migrations, under their original
filenames so the numbers still line up with the template they came from:

| File | Purpose |
| --- | --- |
| `001_users.sql` | `users` |
| `003_user_sessions.sql` | `user_sessions` |
| `004_magic_link_tokens.sql` | `magic_link_tokens` (password/magic-link login, off by default) |
| `014_notification_queue.sql` | `notification_queue` outbox |
| `016_oidc_users.sql` | Authentik columns on `users` (`oidc_subject`, `is_admin`) |
| `017_session_id_token.sql` | `user_sessions.id_token`, for RP-initiated logout |
| `018_dive_sites.sql` | `dive_sites` (Dives) |
| `019_dives.sql` | `dives` (Dives) |

The gaps (002, 005–013, 015) are the template's BOM/nexar/catfooder migrations,
deliberately never ported, as are the template's own 018–022 (`tos_acceptance`
and its follow-up `notification_type` constraint alters). Nothing is missing; do
not try to "fill in" those numbers. New Dives migrations continue from the
highest number present — `018`/`019` above are Dives' own tables, not the
template's.

### `notification_queue.notification_type`

`014_notification_queue.sql` is the template's file with one hand-edit: its
`notification_type` check constraint lists exactly the types this app enqueues —
`new_user_signup` (the Authentik signup callback, `lib/user-signup-notification.ts`)
and `dive_backup` (every dive create/edit/delete). The template's BOM/ToS types
(`bom_uploaded`, `first_check`, `status_change`, `tos_acceptance`) are gone along
with the features that enqueued them, and the template's `019`/`021` follow-up
migrations — which only `alter` that constraint on an already-live table — were
not ported. Adding a new notification type means editing this constraint list;
there is no live deployment to `alter` yet.

### Dive tables

`dive_sites` and `dives` are both owned per user: `user_id integer not null
references users (id) on delete cascade`, with a leading-`user_id` index on each
so every query can be (and must be) filtered by the session's user. `dives.dive_site_id`
is nullable and `on delete set null` — deleting a site never deletes the dives
logged at it.

`scripts/db-migrate.mjs`'s `grantAppRoleOperationalAccess` runs after every
migration batch and grants the low-privilege runtime role (`APP_DB_ROLE`)
ordinary CRUD on every table, plus `ALTER DEFAULT PRIVILEGES` so future
migrations' tables inherit the same grant automatically. **No per-table grant
migration is ever needed for a new table.**

## Dive logbook data access

`lib/dives.ts` holds every dive/dive-site query. `app/actions/dives.ts` exposes the
`"use server"` wrappers the dive form calls (`createDiveAction`,
`updateDiveAction`, `deleteDiveAction`, plus `searchDiveSitesAction`/
`createDiveSiteAction` for the site autocomplete), while
`app/actions/dive-sites.ts` exposes the management-page wrappers
(`updateDiveSiteAction`, `mergeDiveSitesAction`). Every function there takes the
session user's id — resolved by `requireUser()` in the action, never from a URL
or form field — and filters on it. A dive or site id belonging to somebody else
matches no row: reads return `null`/an empty list, mutations throw
`DiveNotFoundError`/`DiveSiteNotFoundError`, so cross-user access is always
not-found and never a partial write.

Each dive mutation runs as one transaction (`getPool().connect()` → `begin` →
write → `commit`, released in a `finally`) that also resolves the dive site
(create-or-reuse by name, so a rolled-back dive leaves no orphan site) and
enqueues the `dive_backup` notification through
`enqueueNotification(..., { client })`. The dive row and its backup email can
therefore never exist without each other. Deletes snapshot the dive *before*
removing it, since the worker draining the queue later has no row left to read.
Dive-site merge is also transactional: it locks both owned site rows, applies the
chosen result properties to the survivor, rewrites `dives.dive_site_id` for the
source site to the survivor, then deletes the source site.

The enqueued payload is the flat
`{ event, dive: { ...columns, site_name, site_location, site_lat, site_lng } }`
contract the worker's renderer expects (see "Combinable vs per-row notification
types" below) — the site is flattened into `site_*` keys rather than nested,
because the CSV attachment writes one cell per key. Each enqueue mints its own
`dive-backup:<id>:<event>:<uuid>` idempotency key, so two consecutive edits of the
same dive produce two outbox rows instead of collapsing into one.

## Dive logbook screens

| Route | What it renders |
| --- | --- |
| `/dashboard` | `getDiveStats` tiles (total dives, total bottom time, distinct sites — the earlier "Deepest dive" tile was dropped to make room) + two SAC-rate tiles: last-5-dive average, and a p50/p90 pair as a single slash-joined value, e.g. "15/19 L/min" (`lib/sac-rate.ts`'s `diveSacRate`/`average`/`percentile`, issue #23 — a raw average alone reads as "typical" but is skewed by outlier dives, so p50 is the actual "typical" figure and p90 the worst-case tail) + a GitHub-style activity calendar (`components/dive-activity-calendar.tsx`, backed by `getDiveActivityByDay`/`getEarliestDiveDate`) with a year-range selector (1..N years or All, N capped at 10) + two collapsible radar-chart sections, "Seasonality" and "Distributions" (`components/dive-radar-charts.tsx`, data from `lib/dive-radar-stats.ts`'s `buildDiveRadarStats`, hidden entirely when the user has no dives) + a compact tag cloud (top 12 tags, linking into `/dives?tag=…`) + the five most recent dives |
| `/dives` | The whole logbook, newest first, with a full tag cloud and `?tag=` filtering (see "Tags" below) + the connected integration fetch buttons for PADI/Suunto (moved here from `/dashboard` per issue #21) |
| `/dive-sites` | All saved dive sites with attached-dive counts, edit buttons, and a two-site merge workflow (`components/dive-sites-manager.tsx`) that lets the user choose the surviving row plus which name/location/coordinates to keep |
| `/dives/[id]` | One dive in full, with its depth-profile chart, a create-in-PADI action for unlinked dives, an update-to-PADI action for linked recreational dives marked out-of-sync, its SAC rate colored red/green against the average of the 5 chronologically preceding dives (issue #23), and text-selection bookmarking over its property/notes content (issue #6, see "Bookmarks" below) |
| `/dives/new`, `/dives/[id]/edit` | The dive form (same `components/dive-form.tsx` in both modes) |
| `/bookmarks` | Every bookmark the user has saved, each linking back to its dive with the originally-selected text highlighted and scrolled into view (see "Bookmarks" below) |

### Dashboard radar charts

`lib/dive-radar-stats.ts`'s `buildDiveRadarStats(dives)` is a pure function (no
DB access of its own — it re-slices the same `DiveRecord[]` the dashboard
already fetched via `listDives`) that turns a user's whole logbook into two
groups of radar-chart datasets, one per collapsible section
(`components/dive-radar-charts.tsx`'s `RadarSection`, backed by
`components/ui/collapsible.tsx`, both sections open by default):

**Seasonality** — angle axis = calendar month, aggregated across every year
the user has logged (a January dive from 2023 and one from 2026 land in the
same bucket — this is a seasonality view, not a timeline). Per issue #7:
dives/month is a single-series radar scaled `0..max+10%` headroom; duration
uses the issue's explicit `5min..max+15min` domain instead; depth is
normalised to exactly the observed max (`exactMax`, a follow-up correction —
its outer ring reads as "the deepest dive", not as a scale with spare room,
unlike every other chart here); visibility and SAC rate (computed per dive via
`lib/sac-rate.ts`'s `diveSacRate`, which wraps `lib/gas-consumption.ts`'s
`computeGasConsumption` and is also shared by the dashboard/dive-page SAC
stats from issue #23) are three-series min/max/avg radars per a follow-up
correction; water temp is a two-series avg-high/avg-low radar.

**Distributions** — angle axis = a value range or a value itself, radius = how
many dives fall in it (a follow-up correction replaced the original single
normalised-percentage "Conditions & company" radar with this group).
`numericDistribution` buckets depth/duration/visibility/SAC rate into
fixed-size steps — depth is the issue's own 5m example; duration/visibility/
SAC rate were tightened by a second follow-up correction to 5min/2.5m/(5/3)
L-per-min (2x/2x/3x finer than their original 10min/5m/5 L-per-min steps) —
one bucket per step up to whichever bucket the largest observed value falls
into, labelled by each bucket's lower bound (`formatBucketLabel` rounds to
hundredths and trims trailing zeros, since a fractional step like 5/3
otherwise produces floating-point tails in the label). `current`, `surge` and
`waves` (dive-form.tsx's `INTENSITY_ORDER`: None/Mild/Moderate/Strong) share
one radar as three series — a dive that never recorded a given field is
excluded from that field's series rather than folded into "None", since "not
recorded" and "recorded as none" are different facts.

Categories with no matching dives pull to the chart's center rather than
leaving a gap — Recharts' polar angle axis is a fixed set of categories, not a
continuous axis a line can skip across, so an empty category has nowhere else
to plot. `RadarStatCard` sets `outerRadius="62%"` plus wider chart margins
(not shadcn's stock example) so the longer angle-axis labels used here
("Moderate", "Strong") don't clip against the card edge the way three-letter
month abbreviations never did.

All authenticated logbook screens call `requireUser("<their own path>")` before any query, so a logged-out
request is redirected (307) to `/?next=…` and never reaches `lib/dives.ts`.
`/dives/[id]` and `/dives/[id]/edit` render `notFound()` both for ids that do not
exist and for ids owned by someone else — the two are deliberately
indistinguishable.

Shared pieces live in `components/`: `app-shell.tsx` (header + nav, wrapping
every authenticated screen), `manage-menu.tsx` (the header menu linking to Dive
Sites, Bookmarks, Integrations and Settings), `dive-form.tsx`, `dive-site-field.tsx` (autocomplete
over the user's own sites, with inline create), `tags-field.tsx` (the same
autocomplete-chip pattern for tags), `dive-sites-manager.tsx`,
`depth-profile-field.tsx`, `depth-profile-chart.tsx`, `create-padi-dive-button.tsx`,
`delete-dive-button.tsx`, `bookmark-capture.tsx`, `text-fragment-highlight.tsx` and
`bookmarks-list.tsx`. Every button that makes a server call follows `AGENTS.md`'s convention:
disabled with a spinner for the duration, then a sonner toast on the result.

### Bookmarks

Issue #6: select a piece of a dive's properties/notes, name it, and later jump
straight back to that exact text from a `/bookmarks` list. Backed by
`dive_bookmarks` (migration `028_dive_bookmarks.sql`; per-user like every other
table here, plus `dive_id references dives (id) on delete cascade` so a
deleted dive silently takes its bookmarks with it) and `lib/bookmarks.ts`
(`createBookmark`/`listBookmarks`/`deleteBookmark`, wrapped by
`app/actions/bookmarks.ts`'s `"use server"` actions). `createBookmark` re-checks
dive ownership itself with a `where d.id = $2 and d.user_id = $1` join at
insert time — a `diveId` is client-supplied input, so it's never trusted the
way a dive fetched from `getDive()` already would be.

The location back to that text is a [URL fragment text
directive](https://wicg.github.io/scroll-to-text-fragment/) (`#:~:text=…`),
built by `lib/text-fragment.ts`'s `buildTextFragmentHash`. A first cut relied
on the browser's own native "Scroll To Text Fragment" handling of that
directive and shipped with no matching parser on this app's side — reasoning
that the `:~:` marker is a *fragment directive* which any browser recognizing
the syntax strips from script-visible state (`location.hash`) before page JS
runs, so this app's own JS could never read it back out anyway. That much is
true (confirmed against this project's Playwright WebKit build: even a bare
`page.goto()` to a `:~:text=` URL comes back with an empty hash), but it
missed a second fact: **stripping the directive and implementing the
highlight are two different things**, and real Safari (and this project's
WebKit build) do the former without ever doing the latter — a live bookmark
link on Safari just reloaded the dive page with nothing highlighted (caught
in prod). So the URL doubles up:

```
#bookmark-text=<value>:~:text=<value>
```

Per the same stripping rule, a browser only removes `:~:` and what follows
it — content *before* the marker is left alone. `location.hash` therefore
comes back as `#bookmark-text=<value>` in every browser (verified for both a
fresh navigation and a `history.pushState`), and `parseBookmarkTextHash`
reads that segment back out. `components/text-fragment-highlight.tsx`,
mounted on `/dives/[id]`, does the rest on mount: walks each bookmarkable
container's text nodes with a `TreeWalker`, locates the bookmarked string
with `findTextOffset` (exact match first, falling back to a
whitespace-collapsed match so re-wrapped text still round-trips), wraps the
matching text node(s) in `<mark>`, and scrolls the first one into view. The
`:~:text=` half of the URL is left for browsers that *do* implement the spec
(mainly Chromium) to act on natively, redundantly with this app's own
highlight — harmless, and free upside where it works.

`components/bookmark-capture.tsx`, mounted on the same page, is what makes a
selection bookmarkable in the first place: a `selectionchange` listener shows
a floating "Bookmark" button whenever the current selection sits entirely
inside one of the page's bookmarkable containers *and* within a single
element (`anchorNode.parentElement === focusNode.parentElement`) — a
selection spanning multiple fields is rejected rather than accepted and
silently unfindable later, since `findTextOffset` only searches for one
contiguous run of text. Clicking it opens a naming dialog and calls
`createBookmarkAction`.

Both components take a `containerIds: string[]` prop rather than a single
id: `app/dives/[id]/page.tsx`'s `BOOKMARK_CONTAINER_IDS` lists
`#dive-bookmark-scope-heading` (the title/subtitle block), `#dive-bookmark-scope`
(the property `DetailGroup`s + notes card), and `#dive-bookmark-scope-caption`
(the `<figcaption>` summary line under whichever profile chart is showing,
e.g. "4249 samples · showing depth (m)" or "… reaching 27m over 60 min") —
three separate containers because the page's layout puts the action buttons
between the heading and the property cards, and puts each chart's own SVG
(excluded on purpose: axis-tick text re-renders differently depending on the
container's pixel width, so it isn't reliably re-findable later) between the
property cards and its caption. The site map is in none of them. Passing a
plain array literal at the call site would re-subscribe both components'
effects on every render, so `BOOKMARK_CONTAINER_IDS` is hoisted to module
scope for a stable reference, same as `SAC_COMPARISON_WINDOW` above it.

### Tags

`dives.tags` (migration `027_dives_tags.sql`, `text[] not null default '{}'`,
GIN-indexed) holds free-text tags the user types into the dive form's
`components/tags-field.tsx`. `lib/dives.ts`'s `listUserTags(userId, query?)`
(`select ... from dives, unnest(tags) as tag ...`) backs its autocomplete —
the user's own tag vocabulary, ranked by how many of their dives use each one.

`"missing-padi"`/`"missing-suunto"` are never written to that column.
`lib/tags.ts`'s `effectiveTags(dive, { padiConnected, suuntoConnected })`
derives them on every read instead, from `padi_dive_id`/`suunto_workout_key`
being `null` plus the user's current integration connection status — so a
dive that gets synced later, or an integration that gets connected or
disconnected, never needs a backfill to stay correct. The same module's
`buildTagCloud(dives, connections)` aggregates counts across an
already-fetched `listDives()` result (personal logbooks are small enough that
this runs in JS rather than a second SQL round trip, and guarantees the
cloud's counts and `/dives`' `?tag=` filtered list always agree). `/dives`
filters its full list by tag; dive numbering (`#1, #2, …`) is computed before
filtering so it never shifts when a tag filter is applied.
`components/tags-field.tsx` normalizes on add (trim, lowercase, collapse
whitespace) and refuses to let a user manually add either reserved tag name.

### Depth profile

`lib/depth-profile.ts` is framework-free and has no `server-only` import on
purpose, so the exact same parser runs in two places: the form parses the pasted
or uploaded text in the browser on every keystroke (so a malformed profile
disables submit and shows the parser's own line-specific error before any server
action is called, and `depth_profile` is never partially written), and the detail
page narrows the JSONB it read back with the same module's `isDepthProfile`
guard. The raw text is stored verbatim in `depth_profile_raw` alongside the
derived `depth_profile` JSON, so a future parser change can re-derive it.

`components/depth-profile-chart.tsx` and `components/suunto-profile-chart.tsx`
are client components built on shadcn's `chart.tsx` (recharts) — shadcn's Area
Chart - Gradient, with tooltips. The depth y-axis uses recharts' `reversed`, so
depth still grows downward and the trace reads like a dive computer's.
`SuuntoProfileChart`'s six streams
(depth/temperature/tankPressure/gasConsumption/gasConsumptionRate/surfaceConsumptionRate)
don't share a scale, so only the primary selected stream draws a (visible)
y-axis; a multi-select `ToggleGroup` lets several streams be overlaid at once,
with the tooltip reporting every selected stream's real value at the hovered
time. `gasConsumptionRate` is `lib/suunto/profile.ts`'s `rate(gas_used[1m])`
— the average bar/min drop in tank pressure over the trailing 1-minute window
ending at each point, computed with a two-pointer walk since points are
already time-ordered. `surfaceConsumptionRate` is that same rate normalized
to a Surface Air Consumption (SAC) rate in L/min via `lib/gas-consumption.ts`'s
shared `ataAtDepth` helper — raw bar/min reads faster at depth purely because
compressed gas is denser there, so it isn't comparable point-to-point without
this normalization; the whole stream is `null` when a dive's tank size wasn't
captured, since bar/min can't be converted to L/min without it. The component
takes just `points`, not the whole `SuuntoDiveProfile`, so the raw Suunto
summary blob (see below) never crosses the server→client boundary.

### Theme

`components/CausticOverlay.tsx` is a byte-for-byte copy of the component from
`2prutsers.com` and is mounted once in `app/layout.tsx`. It is the only
underwater motif in the app — deliberately. Nothing else changes Tailwind theme
colours or fonts, and no other component adds wave/bubble decoration. It is
`fixed`, `pointer-events-none` and sits at `z-index: 25`, above `AppShell`'s
`z-10` page content, so the light rays wash visibly over edit boxes, buttons
and cards instead of being hidden behind them. Being `pointer-events-none`
means this never intercepts a click. It stays below Radix portal content
(dialogs/dropdowns/selects/tooltips, all `z-50`), so popovers and menus still
render above the rays.

## Run the app

```sh
pnpm dev
```

Visit `http://localhost:3000` (requires a migrated Postgres, see above).

`docker-compose up -d` also starts `pgadmin` (Postgres admin UI). There is no
object storage: dive media is an explicit non-goal for v1.

## Auth

Authentik (OIDC) is the only sign-in path. `lib/auth/oidc.ts` handles
discovery/PKCE, `app/api/auth/authentik/{route,signup,callback}` are the
sign-in, enrollment and callback Route Handlers, and `lib/session.ts` issues
and reads the session cookie.

`requireUser()` redirects unauthenticated visitors to `/`. It deliberately has
**no** ToS-acceptance gate — unlike the upstream template it was copied from,
this app has no `tos_acceptance` table, and re-adding `hasAcceptedTosVersion`
would 500 every authenticated page.

The local email/password + magic-link flow (`app/actions/auth.ts`,
`lib/magic-link.ts`, `lib/passwords.ts`, `app/register/[token]/`) stays in the
codebase but every entry point checks `isPasswordAuthEnabled()`
(`lib/auth-config.ts`) server-side. It is off unless `PASSWORD_AUTH_ENABLED=true`;
the Playwright e2e suite turns it on for itself (see `playwright.config.ts`).

The Authentik callback enqueues a `new_user_signup` notification on a first
sign-in (`lib/user-signup-notification.ts`), which is why `new_user_signup`
must stay in `notification_queue`'s `notification_type` check constraint.

## Email

`lib/mailer.ts` wraps `nodemailer` behind an `isMailerConfigured()` gate; when
the `email_*` env vars (see `.env.example`) are unset, sending is a graceful
no-op. `scripts/mailer.mjs` is its plain-JS twin for the CronJob worker, which
runs outside the Next build and can't import `@/lib` modules. Both send as
`Dives <email_host_user>` (currently `zulu@aleksandr.vin`).

## Notification queue + worker

`migrations/014_notification_queue.sql` defines `notification_queue` (status
`pending`/`sending`/`sent`/`failed`, `attempts`, `next_attempt_at`,
`locked_at`, jsonb `payload`, unique `idempotency_key`).
`scripts/notification-worker.mjs` is a CronJob (`notifications.schedule`,
default `*/2 * * * *`) running `processNotificationQueue` from
`scripts/notifications/queue.mjs`:

- **Reap** rows stuck in `sending` past `staleLockMs` (worker crash recovery),
  then **claim** a batch atomically with `FOR UPDATE SKIP LOCKED` (race-safe
  even without a `Forbid` concurrency policy).
- **Render + send** via `scripts/notifications/templates.mjs` and
  `scripts/mailer.mjs`, then mark the rows `sent`. On a retryable SMTP failure
  (Proton 4xx or a network/timeout error, per `classifySmtpError`) the row is
  rescheduled with exponential backoff and ±20% jitter (`computeBackoff`); on a
  permanent 5xx, or once `attempts` reaches `max_attempts`, it dead-letters to
  `failed`.
- `lib/notification-queue.ts` (TS, for the Next app) and
  `scripts/notifications/queue.mjs` (plain JS, for the worker) each carry their
  own `enqueueNotification` — the same TS/`.mjs` duplication `lib/mailer.ts`
  and `scripts/mailer.mjs` use. The TS one takes an optional
  `{ client }` second argument so a caller can enqueue inside its own
  transaction (dive mutations write the dive row and its `dive_backup`
  notification atomically); without it, it uses a pooled connection.

### Combinable vs per-row notification types

`queue.mjs`'s `COMBINABLE_TYPES` decides how claimed rows are grouped into
emails:

- **Combinable** (`new_user_signup`): all of a recipient's rows are collapsed
  into one email by `renderCombinedEmail`, and marked `sent`/retried together.
- **Not combinable** (`dive_backup`, `padi_reconnect`): each row is its own
  email, claimed, sent and marked individually. A dive backup carries a JSON +
  CSV snapshot of the dive as attachments (built in the send path, passed
  through `sendMail`'s optional `attachments` argument to nodemailer), which a
  combined email has no way to represent. Its payload is
  `{ event: "create" | "edit" | "delete", dive: { ...flat column snapshot } }`.
  `padi_reconnect` (see [PADI.md](../PADI.md)) has no attachments; its payload
  is just `{ userId }`.

Both the email body and the CSV order columns through `templates.mjs`'s
`orderedDiveColumns` — known `dives` columns first in a fixed reading order,
unknown ones appended alphabetically. Postgres normalises jsonb key order on
write, so the payload's own key order coming back out of the queue is *not* the
order the server action wrote it in; ordering there instead keeps every backup's
columns identical. A row whose `notification_type` no renderer handles throws
rather than being silently marked sent with no email.

## PADI logbook sync

See [PADI.md](../PADI.md) for the full auth-flow explanation and field map.
In short: `app/actions/padi.ts`'s `connectPadiAction` relays a user's PADI
login/password to PADI's own login endpoint once (server-side, password never
stored), encrypts the returned tokens (`scripts/padi/crypto.mjs`,
`PADI_TOKEN_ENCRYPTION_KEY`), and a `padi-token-refresh` CronJob
(`padiTokenRefresh.schedule`, default `*/30 * * * *`) keeps the access token
fresh via `scripts/padi/token-refresh.mjs`; malformed 2xx refresh bodies are
classified instead of being allowed to crash the CronJob. A "Fetch PADI" button
(`syncPadiAction` → `lib/padi/sync.ts`) imports the user's full logbook into
`dives`, deduped by `padi_dive_id`, and compares already-linked details so
linked recreational dives whose local fields differ are flagged with
`padi_needs_update`. The detail page's "Update to PADI" action uses the captured
recreational update mutation and never updates PADI course/training dives.
Requires `PADI_TOKEN_ENCRYPTION_KEY` and `PADI_USERNAME_HASH_PEPPER` (see
`.env.example`); both are read lazily, so an unconfigured checkout still boots
and serves every non-PADI page/test normally.

### PADI backup (issue #14)

`lib/padi/auth.ts`'s `getPadiCredentials` (decrypting the stored idToken and
resolving the affiliate id) and `lib/padi/concurrency.ts`'s
`mapWithConcurrency` are shared between `lib/padi/sync.ts` and
`lib/padi/backup.ts`, since both walk the same paginated logbook endpoint —
sync imports into `dives`, backup just collects the raw records. The
Integrations page's "Backup PADI dives" button
(`backupPadiAction` → `fetchPadiBackup`) walks the full logbook and returns it
as one timestamped JSON file, downloaded client-side via
`lib/download-file.ts`'s `downloadTextFile` (a `Blob` + `URL.createObjectURL`,
no separate authenticated download route needed). Unlike sync it takes no
advisory lock (read-only) and, since a partial backup file would be
misleading, treats hitting its wall-time budget as a real failure
(`reason: "too_large"`) rather than a resumable partial result. A successful
backup sets `padi_integrations.backup_done_at`.

`CreatePadiDiveButton` (the "Create in PADI" / first-upload action) shows a
one-time nudge dialog — "Back up your PADI logbook first?" — whenever
`backup_done_at` and `backup_prompt_dismissed_at` are both still null.
"Back up now" runs the same backup flow in place; "Skip and upload" calls
`dismissPadiBackupPromptAction` (setting `backup_prompt_dismissed_at`) and
proceeds straight to the upload. Either choice permanently suppresses the
prompt — neither column is ever cleared back to null.

## Dives backup zip (issue #16)

`/settings` (`app/settings/page.tsx`, reached from the header's Manage menu) is
the app's own settings screen, distinct from `/settings/integrations`, which
stays where it is and keeps its own menu entry. Its "Backup" card holds
`components/backup-dives-button.tsx`, which downloads everything the app stores
for the user's dives as one zip.

Unlike the PADI backup above this is a **route handler**
(`app/api/backup/dives/route.ts`), not a server action, because the payload is
binary — a server action would have to base64 the whole zip through the RSC
stream. The handler uses `getOptionalUser()` + a 401 rather than `requireUser()`
on purpose: `requireUser` redirects to the login page, and a `fetch()`-driven
download would follow that redirect and hand the client an HTML page named
`*.zip`. The user id comes from the session only; nothing about the request
selects whose data is archived.

`lib/backup/dives-zip.ts`'s `buildDivesBackupZip(userId)` assembles the archive
with `jszip`:

- `dives.json` — `listDivesForBackup(userId)`, the same flat snapshot the backup
  emails use, but via its own full-`snapshotColumns` query rather than the
  UI's `listDives` (see "Lean list reads" below) — a backup must not silently
  drop `suunto_profile`.
- `dive_sites.json` — `listDiveSites(userId)`.
- `bookmarks.json` — `listBookmarks(userId)`.
- `suunto/<diveId>/<path>` — the *raw* Suunto export bundle, unpacked verbatim.

That last part is why `lib/suunto/raw-bundle.ts` grew `extractAllFiles`
alongside `extractSmlJson`: the app itself only ever needs `workout.sml.json`,
but a backup that silently dropped the other files in the bundle wouldn't be a
backup. `extractAllFiles` is async (promisified `zlib.gunzip`) where
`extractSmlJson` stays sync — the backup decodes many bundles in a row, and
`gunzipSync` would pin the event loop for the whole batch, stalling every other
in-flight request behind it.

Bundle blobs are excluded from `snapshotColumns` by design (see "Raw Suunto
data preview"), so the backup fetches them through `getDiveSuuntoOriginalBundles`
— the batch sibling of the raw preview page's `getDiveSuuntoOriginalBundle`,
same ownership contract (`where d.user_id = $1 and d.id = any($2::int[])`, so
another user's id is simply absent from the returned map). Only dives whose
`suunto_workout_key` is non-null are asked for.

**What is and isn't bounded** matters here, because it's easy to over-claim.
`BUNDLE_BATCH_SIZE` (5) bounds how many gzipped blobs one query materializes at
once, and `BUNDLE_DECODE_CONCURRENCY` (5) bounds how many decode in parallel.
Neither bounds *total* memory: JSZip holds every added entry until
`generateAsync()` runs, so the archive grows with the number and size of a
user's bundles regardless. That's what `MAX_TOTAL_BUNDLE_BYTES` (300 MB) is
for — decoded bytes are counted as they're added and `BackupTooLargeError` is
thrown past the ceiling, which the route turns into a `413` with an explicit
message rather than letting an OOM take the server process down. Chunking the
fetch is also what lets that check fire *before* the memory is committed rather
than after. There's still no wall-time budget like PADI's: every read here is a
local Postgres query, not a third-party API.

A bundle that isn't a real gzipped export (integration tests and older
placeholder rows store a plain `bundle:<workoutKey>` string) is logged and
skipped rather than failing the whole backup, matching how
`scripts/backfill-suunto-gas-rate.ts` steps over them. Entry paths are
sanitized (no absolute paths, no `..`) and then de-duplicated per dive with a
numeric suffix — sanitizing is lossy, and `JSZip.file()` silently *replaces* a
colliding entry, so without that a file would vanish from the backup with no
error anywhere.

`tests/integration/dives-backup-zip.test.ts` covers all of it against a real
Postgres, including the rule-10 invariant: a second user's dives, sites,
bookmarks and bundle bytes must appear nowhere in the first user's archive.

Client-side the blob is saved by `lib/download-file.ts`'s `downloadBlobFile` —
the binary sibling of `downloadTextFile`, sharing its append/click/remove +
deferred `URL.revokeObjectURL` dance for the same Firefox/WebKit reasons.

## Suunto staged imports

Suunto integration is fetch-only and user-triggered. The fetch dialog offers two time ranges. "Recent days" asks for how many recent days to check and the sidecar lists workouts with `suuntool workouts list --since <days>d --limit 100 --format json`. "All time" (issue #24) fetches the user's entire workout history by paginating that *same* bounded, single-page call itself, looping with an increasing `--offset` (`suuntool workouts list --since <since>? --limit 100 --offset <n> --format json`) until a page comes back shorter than the requested 100, rather than relying on suuntool's own `--stream --limit 0` auto-pagination. That auto-pagination was the original implementation and proved fundamentally unreliable for a large real history: a production fetch with ~9,600 activities died with `BAD_ENVELOPE: unexpected end of JSON input` (suuntool exit code 5) first at suuntool's own 30s default HTTP timeout, then again at an explicit 170s `--timeout` override — proving the override only delayed the same failure rather than fixing it, since one continuous multi-minute streaming HTTP operation was never going to reliably finish for a large-enough history no matter how long it was allowed to run. Paginating independently means every individual `suuntool` invocation is exactly as reliable as the already-proven "recent days" call, and a hiccup on one page never loses the pages already collected: if a later page's `suuntool` process exits non-zero with a `server`/`timeout`/`network`-classified reason, whatever's been paginated so far is returned as a salvaged partial listing instead of being discarded — safe because the caller already dedupes against `dives`/`suunto_imports`, so the next click's from-scratch re-pagination just skips everything already staged/saved. The very first page failing, or any auth/usage failure at any offset, still hard-fails with no salvage. `SUUNTOOL_LIST_ALL_TIMEOUT_MS` (180s) now bounds the whole pagination *loop's* wall time (checked between pages, not inside any single `suuntool` call) — if it elapses mid-pagination, whatever's been collected so far is returned rather than erroring, matching the same "click Fetch again to continue" flow. `SUUNTO_SIDECAR_MAX_LIST_ALL_WORKOUTS` (20,000) is a hard cap on accumulated results, since pagination itself has no other natural ceiling the way a single bounded page does. The two modes are separate, type-checked request shapes end to end — `listSuuntoWorkouts(session, { daysBack } | { all: true })` and `fetchSuuntoWorkoutsAction({ mode: "days", daysBack } | { mode: "all" })` — and the action re-validates the `mode` discriminant at runtime too, since Server Action arguments are client-controlled and an unrecognised mode must not fall through to the expensive all-time path. Everything after the listing (dedupe, export, compile, stage) is the same code for both modes.

"All time" borrows the PADI sync section's two safety mechanisms above, for the same reason: one click can mean an arbitrarily large amount of work. It takes a non-blocking `pg_try_advisory_lock` on its own fixed classid (distinct from PADI's, on a dedicated non-pooled client so closing the connection always releases it), returning `reason: "in_progress"` instead of running a second concurrent fetch of the same history; and it runs under a wall-time budget, started before the listing so it bounds the whole request (and therefore how long the lock is held) and not just the staging loop, then checked only before starting each export so an in-flight sidecar call is never abandoned mid-flight. The budget is larger than PADI's (a single Suunto export can run up to the sidecar's 180s export timeout), and hitting it is a resumption, not a failure: the action returns `remaining: true` with `checked` counting only the workouts actually examined, the button toasts "click Fetch workouts again to continue", and the existing already-saved/already-staged dedupe makes the next click pick up exactly where the last one stopped. The Next app talks only to a
pod-local, stateless suuntool sidecar (`scripts/suunto-sidecar/server.mjs`) over
`http://127.0.0.1:<port>`; there is no Service, Ingress, PVC, background sync, or
Suunto write-back path. The sidecar runs fixed `suuntool` commands, passes the
Suunto password to `suuntool login --password-stdin`, writes any supplied session
to a temporary `SUUNTOOL_SESSION_FILE`, and deletes that temp directory after the
request. It emits structured JSON logs for request lifecycle, suuntool exit codes, output sizes, list result shape/counts, and export bundle file names; password and session payloads are redacted before logging.

The app owns persistence. `suunto_integrations` stores only a hashed email and an
encrypted suuntool session JSON (`SUUNTO_SESSION_ENCRYPTION_KEY`, falling back to
`PADI_TOKEN_ENCRYPTION_KEY` for local compatibility); it never stores the user's
Suunto password. `suunto_imports` stores staged workout imports per user until the
user reviews them. Saved dives carry `suunto_workout_key` plus the compiled
`suunto_profile` JSON used by charts; the original exported bundle is retained in
`suunto_original_bundle` but is deliberately not selected into `getDive`'s ordinary
snapshot/backup/UI DTO query (`lib/dives.ts`'s `snapshotColumns`) — see "Raw Suunto
data preview" below for the one place it is deliberately read back out.

Duplicate handling mirrors PADI sync semantics: a Suunto workout key already
saved to `dives` or already staged in `suunto_imports` is ignored. To re-import a
workout, the user must delete the saved/staged copy first. A reviewed staged item
is consumed in the same transaction that creates the dive, and the resulting dive
is a normal local dive eligible for PADI upload.

`lib/suunto/profile.ts` compiles `workout.sml.json` into a versioned JSON profile
with depth, temperature, tank pressure and gas-consumption points, while also
producing the simple `{ time, depth }[]` `depth_profile` used by the existing
chart/form code. Suunto SML exports can split `DiveHeader`, `DiveFooter`,
`Windows`, and `Header` across separate summary samples; the parser merges those
rows before extracting average depth, dive/bottom time, pressure endpoints and
location. Exported workout metadata does not include a human-readable site name,
and may carry zeroed top-level positions. Coordinates are drafted only from
workout-scoped SML sources: `DiveLocation.Stop`, `DiveLocation.Start`,
`DiveRouteOrigin`, or per-sample latitude/longitude. Lone `LastKnownCoordinates`
values are ignored because observed Suunto exports can carry a stale watch/app
location from another workout when the dive itself has no GPS route. Accepted
coordinates are converted from radians to degrees when needed and drafted as a
coordinate-named site (`Suunto GPS <lat>, <lng>`) for user review. Plain air is
normalized to `Air` rather than `Air 21% O₂`.

The Integrations page shows a `Review staged dives` link whenever pending Suunto
imports exist. The review queue is ordered by workout time; save, merge, delete,
and cancel continue to the next staged item when one exists, otherwise they
return to the normal destination.

The Suunto review form can either save the staged import as a new dive or merge it
into an existing user-owned dive. Merge candidates are existing dives without a
Suunto workout id, ordered by closeness to the staged workout date. The merge
flow is an explicit two-step dialog: first choose the target dive, then choose
field-by-field whether each editable value survives from the reviewed Suunto
import or from the existing dive, mirroring the dive-site merge workflow. Each
field is preselected rather than always defaulting to the import: whichever side
actually has data wins, and if both sides do, the side with more decimal
precision wins for the ten numeric measurement fields (depths, temps,
visibility, cylinder size, pressures, weight) — see `lib/merge-fields.ts`'s
`pickMergeSource`. The user can still override any field before merging. Merging
attaches the Suunto workout id/profile/original bundle to the selected dive,
deletes the staged import, and enqueues a normal edit backup in one transaction.

### Raw Suunto data preview

`/dives/[id]/raw` (issue #5) is the one deliberate exception to `suunto_original_bundle`
never being read back out: `lib/dives.ts`'s `getDiveSuuntoOriginalBundle(userId, diveId)`
is a narrowly-scoped, ownership-filtered query kept separate from `getDive`/
`snapshotColumns` on purpose, returning `null` (never another user's bundle) for a
missing dive, another user's dive, or a dive with no Suunto data alike — the page
renders the same `notFound()` for all three. `lib/suunto/raw-bundle.ts`'s
`extractSmlJson` gunzips the bundle and parses out `workout.sml.json`; both this
page and `scripts/backfill-suunto-gas-rate.ts` import that one implementation. A
bundle that doesn't decode as that shape (e.g. a test fixture's placeholder bytes)
renders an inline "couldn't be read" message rather than a 500. The dive detail
page links to this route whenever `suunto_workout_key` is set, independent of
whether the compiled `suunto_profile` chart itself renders.

### Lean list reads

Issue #27: Dashboard and Logbook were taking seconds to load. The sibling `gym`
app had already diagnosed the identical symptom in its own suunto-backed table
(issue #32) — a heavy JSON column selected unconditionally by a shared
list/detail query — so this repo was audited for the same pattern rather than
reaching for caching first. `suunto_profile` holds a whole dive-computer
download's per-second GPS/HR/temperature samples (megabytes for one imported
dive), and `lib/dives.ts`'s `snapshotColumns` selected it on every row of every
read, including `listDives` — shared by Dashboard, Logbook, and the dive detail
page's own "other dives" list (used only to find the prior dives for SAC-rate
comparison). None of those views render a dive's Suunto profile; only the
single-dive detail/edit pages (`getDive`) do. That unconditional `unknown`
JSONB round-tripped through `JSON.stringify`/`JSON.parse` on every list load
whether or not any dive in it even had Suunto data.

The fix is `snapshotColumnsLean` (`d.suunto_profile` swapped for a
`null::jsonb` literal, so `DiveRecord`'s shape is unchanged) used by `listDives`
and `listSuuntoMergeDiveCandidates` — neither reads `suunto_profile`, and
merge candidates in particular can never have one anyway, since they're
queried `where d.suunto_workout_key is null`. `getDive`, the mutation
transactions' `loadSnapshot`, and the new `listDivesForBackup` (used only by
`buildDivesBackupZip`, see "Dives backup zip" above) keep the full
`snapshotColumns` — the backup's `dives.json` is documented as a complete
export and must not silently lose the profile.

Unlike `SuuntoProfileChart` (which was deliberately narrowed to just `points` after
a prior review flagged the whole profile blob crossing the server→client boundary
unnecessarily — see above), this page's entire purpose is showing the user their
own raw data, so the full parsed SML JSON is passed to the client on purpose. That
distinction is about *what* crosses the boundary (data minimization: send only
what a component renders vs. send everything because rendering everything is the
feature), not about payload size — a real SML export gzips to tens of KB over the
wire regardless.

`components/suunto-raw-preview.tsx` renders a single (250ms-debounced, since a real
export runs to tens of thousands of JSON nodes and recomputing on every keystroke
is wasted work) search input over two `components/ui/tabs.tsx` tabs:
`components/json-tree-view.tsx` (a collapsible object viewer, default-expanded 3
levels deep, arrays capped at 100 rendered items with a "show more" step) and
`components/json-text-view.tsx` (`JSON.stringify(data, null, 2)` with a
regex-tokenized syntax highlighter, replaced with a plain block + an explicit
"too large to highlight" notice past 250k characters — one `<span>` per JSON token
means a real multi-megabyte export would otherwise turn into hundreds of thousands
of React children). Both share `lib/json-highlight.tsx`'s `<Highlight>` for
`<mark>`ing search matches, so the two tabs highlight matches consistently
whenever both are actually rendering colored tokens — the size fallback above is
the one case where the text tab intentionally stops highlighting (still fully
readable and browser-`Ctrl+F`-searchable) while the tree tab, whose rendering cost
is bounded by its own depth/reveal caps rather than total document size, keeps
highlighting regardless of dive size.

The tree view's search additionally walks the whole tree once per (debounced)
query to compute which ancestor paths must auto-expand and how many array items to
reveal so a match past the default cap isn't hidden. Two guards keep that bounded
on a large, permissively-matching query (e.g. a single common letter): auto-expand
only kicks in at 2+ characters, and a hard cap on how many containers one search
is allowed to force open. Manual expand/collapse overrides reset whenever the
query itself changes, so a node collapsed under one search can't silently hide a
match under a later, different search.

## Tests

```sh
pnpm test        # typecheck + fast, DB-free unit tests (vitest)
pnpm test:pg     # Postgres-backed integration tests (vitest)
pnpm test:e2e    # Playwright end-to-end tests
```

`pnpm test:unit` (part of `pnpm test`) covers `tests/unit/**` only — pure
logic with no database access. `pnpm test:pg` runs `tests/integration/**`
against a real Postgres and requires `DATABASE_URL` (or `TEST_DATABASE_URL`)
pointing at a migrated database; it fails loudly if neither is set:

```sh
DATABASE_URL=postgres://dives_user:dives@localhost:5432/dev_dives \
  PASSWORD_AUTH_ENABLED=true pnpm test:pg
```

`PASSWORD_AUTH_ENABLED=true` is required for the magic-link/registration
integration tests specifically: they drive `completeRegistrationAction`, which
refuses to run at all while password auth is off (its normal deployed state).

Playwright is configured to use WebKit (see `AGENTS.md`), starts the Next.js
dev server automatically, and drives it against the same local Postgres.

## Feedback button (issue #22)

The header's feedback button (`components/feedback-button.tsx`, rendered by
`components/app-shell.tsx` between the theme toggle and sign-out) opens a
dialog whose submit calls `submitFeedbackAction`
(`app/actions/feedback.ts`). That action files a Gitea issue labelled
`user-feedback` via `lib/gitea/client.ts` and then best-effort emails
`DIVES_ADMIN_EMAIL` through `sendPlainEmail` — the issue is the durable
record, so a mail failure is logged but still reports success to the user.

`lib/gitea/client.ts` resolves (and, on first use, creates) the
`user-feedback` label because Gitea's issue-create endpoint takes numeric
label ids, not names. It reads `GITEA_TOKEN` (secret, required) plus
`GITEA_BASE_URL` / `GITEA_OWNER` / `GITEA_REPO` (defaulted in code, see
`.env.example`); with the token unset — or still set to its Helm placeholder —
submissions fail with a generic "try again later" toast and a server-side log
rather than calling out with an empty token.

## Healthcheck route

`app/api/health/route.ts` responds to health probes (used by the Helm
deployment's liveness/readiness checks) and also pings an external monitor
via `lib/healthcheck-ping.ts` when `HEALTHCHECK_PING_URL` is set. Leave it
unset locally — the ping is a no-op without it.

## OpenTelemetry

`instrumentation.ts` + `lib/otel.ts` wire up the OTel Node SDK (traces,
metrics, logs) on server start; `lib/logger.ts` provides a `pino` logger. No
collector is required for local dev — the exporters are only installed when
`OTEL_EXPORTER_OTLP_ENDPOINT` (or `..._TRACES_ENDPOINT`) is set.

`lib/auth-otel.ts` emits `auth.signups`/`auth.signins`/`auth.logouts`, labeled
`method` (`password` or `oidc`); `lib/email-otel.ts` emits `email.sends` and
`email.duration`. The notification CronJob bootstraps the same SDK via
`scripts/notifications/otel.mjs` and logs NDJSON via
`scripts/ndjson-console.mjs`.

`lib/action-otel.ts`'s `withActionTelemetry` wraps every exported function in
`app/actions/**` (issue #26), emitting `app.action.calls` /
`app.action.duration`, labeled `action`, `status`
(`success`/`failure`/`redirect`/`error` — `failure` covers the `{ ok: false }`
half of an action's own discriminated-union result, not just thrown errors),
and `user`. `user` is the session's email, falling back to `user:<id>` or
`"anonymous"` — a deliberately high-cardinality label, by explicit request, so
activity can be attributed per person. Actions that don't know their user
until mid-flow (`loginAction`, `completeRegistrationAction`) pass a closure
over a `let` variable assigned once the user is resolved, since
`withActionTelemetry` reads it lazily after the wrapped function settles.
`requireUser()` itself sits outside the wrapper in every protected action and
`redirect()`s on its own for an unauthenticated caller (a deliberate choice —
it avoids a second session lookup per action, see the git history on
`lib/session.ts`), so that redirect is invisible to these metrics and
`app.action.duration` never includes the session lookup's own latency.

## Deployment

`build-and-push.sh` builds the image and `helm upgrade --install`s
`helm-charts/` with `dev-values.yaml` (git-ignored; keep
`dev-values.example.yaml` in sync key-for-key). The chart runs migrations in an
initContainer as the schema owner (`database`) and everything else — the web
container and the notification-worker CronJob — as the low-privilege
`databaseApp` role.

`app/robots.ts` and `proxy.ts` lock the dev stage out of search engines, keyed
off `OTEL_DEPLOYMENT_ENVIRONMENT=dev` (`lib/deployment-stage.ts`). Both stay
request-time rather than statically baked, since one image is built and
deployed to every stage.


## Garmin Integration Sidecar

The Garmin Connect integration requires a stateless pod-local HTTP sidecar to negotiate the OAuth login flow and download binary FIT files safely.

To run the sidecar locally:
```sh
# 1. Install the sidecar's specific dependencies
cd scripts/garmin-sidecar
npm install
cd ../..

# 2. Run the sidecar alongside the main dev server
pnpm garmin:sidecar
```

The sidecar will start on `http://127.0.0.1:4818`. The main Next.js app communicates with it automatically when interacting with Garmin Connect in the UI.

## Garmin staged imports

Garmin integration mirrors the Suunto fetch-only architecture, utilizing a user-triggered sync. It relies on a local Node.js sidecar (`scripts/garmin-sidecar/server.mjs`) running on port 4818.
- The sidecar leverages the `garmin-connect` library to handle OAuth negotiation and download raw activity data. The sidecar specifically downloads activities as ZIP archives containing `.fit` binary files.
- The Next.js app receives these ZIP archives, unzips them natively (`lib/garmin/raw-fit.ts`), and extracts the underlying `.fit` file buffer. 
- Garmin FIT binaries are decoded into messages via `@garmin/fitsdk`. The `compileGarminProfile` logic filters out Apnea/Free diving activities, checking that the device originates from the Descent family.

### Garmin Profile Parsing & Rounding
Because FIT logs rely heavily on high-frequency telemetry records and sometimes omit session-level summaries, the parser reconstructs essential dive metrics:
- **Depth**: Both `maxDepth` and `averageDepth` are verified against the `recordMesgs` telemetry arrays. To avoid noisy floating-point anomalies (e.g., `5.990305...`), these values are strictly rounded to 2 decimal places.
- **Temperatures**: `waterTemp` (Surface) is pulled from `diveSettingsMesgs` or the first available record. `waterTempLow` (Lowest) is aggressively extracted by finding the absolute minimum temperature across all individual time-series points.
- **Gases**: `gasMix` is decoded from `diveGasMesgs`. If `oxygenContent` equals 21, it maps cleanly to `Air`; otherwise, it generates standard EAN labels (e.g., `EAN32`).

### Staging and UI Review
Like Suunto, parsed activities are buffered in the `garmin_imports` table to allow the user to review or merge them before they pollute the main `dives` logbook. 
- The staging UI form at `/settings/integrations/garmin/imports/[id]` uses visual placeholder text (e.g., grayed-out `EAN32`, `21.0°C`, `12L steel`) to indicate format expectations when fields are genuinely empty.
- Real data extracted via the FIT parser overrides these placeholders as solid pre-filled values. Deduplication ensures that already-staged or imported dives (by `activity_id`) are skipped during subsequent syncs.

