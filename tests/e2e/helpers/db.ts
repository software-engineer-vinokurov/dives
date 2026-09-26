import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";

import pg from "pg";

// e2e-only helper: connects to the SAME Postgres the `pnpm dev` server (spawned by
// playwright.config.ts's webServer with DATABASE_URL) uses, so tests can seed state the UI
// has no way to trigger deterministically (e.g. a magic-link token, since the real email is
// never sent in dev/test — mailer is unconfigured).
//
// Deliberately uses a raw pg pool + a relative import of lib/auth/session-token.ts instead
// of importing lib/magic-link.ts or lib/session.ts directly: those modules (and most of
// lib/) start with `import "server-only"`, which throws when loaded outside a Next.js RSC
// bundle — including in Playwright's plain Node test process. session-token.ts has no such
// import, so it's safe to reuse here for hash-compatibility with the server.
import { hashSessionToken } from "../../../lib/auth/session-token";
// getDatabaseUrl merges the split DATABASE_USER/DATABASE_PASSWORD convention (used by CI and
// scripts/db-migrate.mjs) into DATABASE_URL -- a raw process.env.DATABASE_URL read here would
// miss those and connect as the wrong role wherever the URL itself doesn't embed credentials.
import { getDatabaseUrl } from "../../../scripts/env.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL ?? getDatabaseUrl();

if (!databaseUrl) {
  throw new Error(
    "e2e tests require a real Postgres. Set TEST_DATABASE_URL or DATABASE_URL to a migrated " +
      "database, e.g. postgres://dives_user:dives@localhost:5432/dev_dives",
  );
}

// allowExitOnIdle so the pool never keeps the Playwright test process alive after the run.
const pool = new pg.Pool({ connectionString: databaseUrl, allowExitOnIdle: true });

/**
 * Inserts a valid, unused magic-link token row directly into magic_link_tokens and returns
 * the raw token, exactly as createMagicLinkToken(email) would hand back to a caller for use
 * in a `/register/[token]` URL.
 */
export async function seedMagicLinkToken(email: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

  await pool.query(
    "insert into magic_link_tokens (email, token_hash, expires_at) values ($1, $2, $3)",
    [email, tokenHash, expiresAt],
  );

  return token;
}

export function uniqueTestEmail(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString("hex")}@example.com`;
}

// The real Suunto fetch/merge flow needs OAuth-equivalent credentials the e2e suite can't reach
// (see tags.spec.ts's comment on missing-suunto coverage), so raw-preview e2e coverage seeds a
// dive with a real gzip'd { files } bundle directly, mirroring what scripts/suunto-sidecar/server.mjs
// actually produces (lib/suunto/raw-bundle.ts's extractSmlJson reads this same shape back out).
export async function seedSuuntoDive(email: string, sml: unknown): Promise<{ diveId: number; workoutKey: string }> {
  const user = await pool.query<{ id: number }>("select id from users where email = $1", [email]);
  if (user.rows.length === 0) throw new Error(`no user found for email ${email}`);

  const workoutKey = `e2e-${randomBytes(6).toString("hex")}`;
  const bundle = gzipSync(
    Buffer.from(
      JSON.stringify({
        files: [
          { path: "workout.sml.json", contentBase64: Buffer.from(JSON.stringify(sml)).toString("base64") },
        ],
      }),
    ),
  );

  const result = await pool.query<{ id: number }>(
    `insert into dives (user_id, title, occurred_at, suunto_workout_key, suunto_profile, suunto_original_bundle)
     values ($1, 'Suunto raw preview e2e dive', now(), $2, $3, $4)
     returning id`,
    [user.rows[0].id, workoutKey, JSON.stringify({ source: "suunto", workoutKey, points: [] }), bundle],
  );

  return { diveId: result.rows[0].id, workoutKey };
}

/**
 * Marks a user as Suunto-connected so the Integrations page renders the fetch dialog. The stored
 * blobs are deliberately junk: rendering the connected state only reads `status`/timestamps, never
 * decrypts, and there is no suuntool sidecar in the e2e environment anyway — a fetch submitted from
 * this state is expected to come back as the "temporarily unavailable" error toast, which is exactly
 * what proves the button reached the server action.
 */
export async function seedSuuntoIntegration(email: string): Promise<void> {
  const user = await pool.query<{ id: number }>("select id from users where email = $1", [email]);
  if (user.rows.length === 0) throw new Error(`no user found for email ${email}`);

  await pool.query(
    `insert into suunto_integrations (user_id, email_hash, session_encrypted, status)
     values ($1, $2, 'e2e-not-a-real-session', 'connected')`,
    [user.rows[0].id, `e2e-${randomBytes(8).toString("hex")}`],
  );
}

/**
 * Inserts a plain dive row directly (same rationale as seedSuuntoDive: driving dive creation
 * through the UI form races router.refresh()/router.push()'s client-side transition, which is
 * fine for specs that only create one dive but flaky for specs that immediately navigate
 * elsewhere afterwards).
 */
export async function seedDive(
  email: string,
  fields: {
    title?: string | null;
    occurredAt: string;
    maxDepth?: number | null;
    notes?: string | null;
    // SAC-rate inputs (issue #23): all four plus bottomTimeMinutes must be set together for
    // computeGasConsumption to produce a rate, matching lib/gas-consumption.ts's own contract.
    avgDepth?: number | null;
    bottomTimeMinutes?: number | null;
    cylinderSize?: number | null;
    startPressure?: number | null;
    endPressure?: number | null;
    // Seeded directly rather than driven through the dive form's textarea: typing a valid profile
    // there mounts the form's own live-preview chart (components/depth-profile-field.tsx's
    // dynamic() import), which -- on top of the detail page's own chart -- doubles the
    // recharts/d3 chunks a test forces Next dev to cold-compile. Bypassing the form avoids that
    // extra, unnecessary compile.
    depthProfile?: { time: number; depth: number }[] | null;
  },
): Promise<{ diveId: number }> {
  const user = await pool.query<{ id: number }>("select id from users where email = $1", [email]);
  if (user.rows.length === 0) throw new Error(`no user found for email ${email}`);

  const result = await pool.query<{ id: number }>(
    `insert into dives (
       user_id, title, occurred_at, max_depth, notes,
       avg_depth, bottom_time_minutes, cylinder_size, start_pressure, end_pressure, depth_profile
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning id`,
    [
      user.rows[0].id,
      fields.title ?? null,
      fields.occurredAt,
      fields.maxDepth ?? null,
      fields.notes ?? null,
      fields.avgDepth ?? null,
      fields.bottomTimeMinutes ?? null,
      fields.cylinderSize ?? null,
      fields.startPressure ?? null,
      fields.endPressure ?? null,
      fields.depthProfile ? JSON.stringify(fields.depthProfile) : null,
    ],
  );

  return { diveId: result.rows[0].id };
}

// Deliberately duck-typed instead of importing Partial<DiveInput> from lib/dives.ts: that module
// (like most of lib/) starts with `import "server-only"`, unsafe to load in this plain Node
// process even as a type-only import (see the header comment on session-token.ts above).
type DraftDiveFields = {
  title?: string | null;
  occurredAt?: string;
  maxDepth?: number | null;
  buddy?: string | null;
  notes?: string | null;
};

/**
 * Inserts a staged suunto_imports row directly (see seedSuuntoDive's comment on why the real
 * OAuth-backed fetch/merge flow can't be driven from e2e), so merge-review specs can open
 * `/settings/integrations/suunto/imports/[id]` without a live Suunto connection.
 */
export async function seedSuuntoImport(
  email: string,
  draftDive: DraftDiveFields,
): Promise<{ importId: number; workoutKey: string }> {
  const user = await pool.query<{ id: number }>("select id from users where email = $1", [email]);
  if (user.rows.length === 0) throw new Error(`no user found for email ${email}`);

  const workoutKey = `e2e-merge-${randomBytes(6).toString("hex")}`;
  const compiledProfile = {
    source: "suunto",
    version: 1,
    workoutKey,
    startedAt: draftDive.occurredAt ?? null,
    durationMinutes: null,
    maxDepth: draftDive.maxDepth ?? null,
    averageDepth: null,
    waterTemperature: null,
    waterTemperatureLow: null,
    tankStartPressure: null,
    tankEndPressure: null,
    tankSizeLitres: null,
    gasMix: null,
    location: null,
    points: [],
    depthProfile: [],
    summary: {},
  };

  const result = await pool.query<{ id: number }>(
    `insert into suunto_imports
       (user_id, workout_key, workout_started_at, summary, draft_dive, compiled_profile, original_bundle, updated_at)
     values ($1, $2, $3, '{}'::jsonb, $4::jsonb, $5::jsonb, $6, now())
     returning id`,
    [
      user.rows[0].id,
      workoutKey,
      draftDive.occurredAt ?? null,
      JSON.stringify(draftDive),
      JSON.stringify(compiledProfile),
      Buffer.from(""),
    ],
  );

  return { importId: result.rows[0].id, workoutKey };
}

export async function seedGarminIntegration(email: string): Promise<void> {
  const user = await pool.query<{ id: number }>("select id from users where email = $1", [email]);
  if (user.rows.length === 0) throw new Error(`no user found for email ${email}`);

  await pool.query(
    `insert into garmin_integrations (user_id, email_hash, session_encrypted, status)
     values ($1, $2, 'e2e-not-a-real-session', 'connected')`,
    [user.rows[0].id, `e2e-${randomBytes(8).toString("hex")}`],
  );
}

export async function seedGarminImport(
  email: string,
  draftDive: DraftDiveFields,
): Promise<{ importId: number; activityId: string }> {
  const user = await pool.query<{ id: number }>("select id from users where email = $1", [email]);
  if (user.rows.length === 0) throw new Error(`no user found for email ${email}`);

  const activityId = `e2e-garmin-${randomBytes(6).toString("hex")}`;
  const compiledProfile = {
    source: "garmin",
    version: 1,
    activityId,
    startedAt: draftDive.occurredAt ?? null,
    durationMinutes: null,
    maxDepth: draftDive.maxDepth ?? null,
    averageDepth: null,
    waterTemperature: null,
    waterTemperatureLow: null,
    surfaceTemperature: null,
    gasMix: null,
    points: [],
    depthProfile: null,
    depthProfileRaw: null,
  };

  const result = await pool.query<{ id: number }>(
    `insert into garmin_imports
       (user_id, activity_id, activity_started_at, summary, draft_dive, compiled_profile, original_fit, updated_at)
     values ($1, $2, $3, '{}'::jsonb, $4::jsonb, $5::jsonb, $6, now())
     returning id`,
    [
      user.rows[0].id,
      activityId,
      draftDive.occurredAt ?? null,
      JSON.stringify(draftDive),
      JSON.stringify(compiledProfile),
      Buffer.from(""),
    ],
  );

  return { importId: result.rows[0].id, activityId };
}
