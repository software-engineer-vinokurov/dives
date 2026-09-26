import "server-only";

import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { getPool, queryRead } from "./db";
import { enqueueNotification } from "./notification-queue";
import type { PadiOnlyFields } from "./padi/field-map";

// Every query in this module takes the session user's id and filters on it. A dive/site id coming
// from a URL or a form is never trusted on its own: a mutation scoped by `user_id` that matches no
// row throws DiveNotFoundError, so another user's row is never read, updated or deleted (AGENTS.md's
// per-user ownership rule).
export class DiveNotFoundError extends Error {
  constructor(message = "Dive not found") {
    super(message);
    this.name = "DiveNotFoundError";
  }
}

export class DiveSiteNotFoundError extends Error {
  constructor(message = "Dive site not found") {
    super(message);
    this.name = "DiveSiteNotFoundError";
  }
}

export type DiveSiteRow = {
  id: number;
  name: string;
  location: string | null;
  lat: number | null;
  lng: number | null;
  created_at: Date;
};

export type DiveSiteWithDiveCount = DiveSiteRow & { dive_count: number };

export type DiveSiteInput = {
  name: string;
  location?: string | null;
  lat?: number | null;
  lng?: number | null;
};

export type DiveSiteMergeInput = DiveSiteInput & {
  fromSiteId: number;
  intoSiteId: number;
};

export type DiveSiteMergeResult = {
  site: DiveSiteWithDiveCount;
  movedDives: number;
};

// The dive_backup payload contract (scripts/notifications/templates.mjs's renderDiveBackupEmail and
// queue.mjs's buildDiveBackupAttachments): a FLAT column snapshot. The site is flattened into
// site_name/site_location/site_lat/site_lng rather than nested, because the CSV attachment writes
// one cell per key and JSON-stringifies any nested object into it.
export type DiveSnapshot = {
  id: number;
  title: string | null;
  occurred_at: Date;
  max_depth: string | null;
  avg_depth: string | null;
  bottom_time_minutes: number | null;
  water_temp: string | null;
  water_temp_low: string | null;
  air_temp: string | null;
  visibility: string | null;
  gas_mix: string | null;
  tank_info: string | null;
  cylinder_size: string | null;
  start_pressure: string | null;
  end_pressure: string | null;
  weight: string | null;
  weight_feedback: string | null;
  suit_type: string | null;
  hood: boolean | null;
  gloves: boolean | null;
  boots: boolean | null;
  buddy: string | null;
  dive_shop: string | null;
  current: string | null;
  surge: string | null;
  waves: string | null;
  weather: string | null;
  water_type: string | null;
  body_of_water: string | null;
  entry_type: string | null;
  notes: string | null;
  rating: number | null;
  depth_profile: unknown;
  depth_profile_raw: string | null;
  created_at: Date;
  updated_at: Date;
  // The 8 PADI-only columns (migration 023): write-once by createDiveFromPadi's own insert, never
  // by DiveInput/diveValues()/updateDive (see that function's comment). Restored here read-only
  // (plan's fix B) so listDives/getDive/the dive detail page can show PADI provenance, and so a
  // PADI-imported dive's later manual edit -- which does flow through the untouched updateDive path
  // -- produces a backup CSV/JSON that includes them.
  padi_dive_id: number | null;
  dive_number: number | null;
  padi_member_number: number | null;
  adventure_dive: boolean | null;
  dive_type: string | null;
  log_type: string | null;
  log_course: string | null;
  padi_status: string | null;
  padi_needs_update: boolean;
  padi_last_compared_at: Date | null;
  // Suunto provenance/profile is safe to expose to the app UI for charts and duplicate hints.
  // The original bundle blob is intentionally not part of snapshots/backups/DTOs.
  suunto_workout_key: string | null;
  suunto_profile: unknown;
  garmin_activity_id: string | null;
  garmin_profile: unknown;
  // User-supplied free-text tags (migration 027). "missing-padi"/"missing-suunto" are never stored
  // here -- see lib/tags.ts's effectiveTags(), which derives them from padi_dive_id/
  // suunto_workout_key plus the user's integration status instead, so they can't go stale.
  tags: string[];
  site_name: string | null;
  site_location: string | null;
  site_lat: number | null;
  site_lng: number | null;
};

// Reads for the UI additionally need the raw foreign key (the edit form preselects the site);
// the backup payload deliberately doesn't carry it -- the flattened site_* fields are the snapshot.
export type DiveRecord = DiveSnapshot & { dive_site_id: number | null };

// A dive's site is either one the user already picked from their own autocomplete list, or a name
// typed into it that may or may not exist yet -- resolved inside the mutation's own transaction so a
// rolled-back dive write can't leave an orphaned site behind.
type DiveSiteSelection =
  | { id: number }
  | { name: string; location?: string | null; lat?: number | null; lng?: number | null };

export type DiveInput = {
  site: DiveSiteSelection | null;
  title: string | null;
  occurredAt: Date | string;
  maxDepth: number | null;
  avgDepth: number | null;
  bottomTimeMinutes: number | null;
  waterTemp: number | null;
  waterTempLow: number | null;
  airTemp: number | null;
  visibility: number | null;
  gasMix: string | null;
  tankInfo: string | null;
  cylinderSize: number | null;
  startPressure: number | null;
  endPressure: number | null;
  weight: number | null;
  weightFeedback: string | null;
  suitType: string | null;
  hood: boolean | null;
  gloves: boolean | null;
  boots: boolean | null;
  buddy: string | null;
  diveShop: string | null;
  current: string | null;
  surge: string | null;
  waves: string | null;
  weather: string | null;
  waterType: string | null;
  bodyOfWater: string | null;
  entryType: string | null;
  notes: string | null;
  rating: number | null;
  depthProfile: unknown;
  depthProfileRaw: string | null;
  tags: string[];
};

type DiveEvent = "create" | "edit" | "delete";

export type DiveOwner = { id: string; email: string };

const snapshotColumns = `
  d.id,
  d.title,
  d.occurred_at,
  d.max_depth,
  d.avg_depth,
  d.bottom_time_minutes,
  d.water_temp,
  d.water_temp_low,
  d.air_temp,
  d.visibility,
  d.gas_mix,
  d.tank_info,
  d.cylinder_size,
  d.start_pressure,
  d.end_pressure,
  d.weight,
  d.weight_feedback,
  d.suit_type,
  d.hood,
  d.gloves,
  d.boots,
  d.buddy,
  d.dive_shop,
  d.current,
  d.surge,
  d.waves,
  d.weather,
  d.water_type,
  d.body_of_water,
  d.entry_type,
  d.notes,
  d.rating,
  d.depth_profile,
  d.depth_profile_raw,
  d.created_at,
  d.updated_at,
  d.padi_dive_id,
  d.dive_number,
  d.padi_member_number,
  d.adventure_dive,
  d.dive_type,
  d.log_type,
  d.log_course,
  d.padi_status,
  d.padi_needs_update,
  d.padi_last_compared_at,
  d.suunto_workout_key,
  d.suunto_profile,
  d.garmin_activity_id,
  d.garmin_profile,
  d.tags,
  s.name as site_name,
  s.location as site_location,
  s.lat as site_lat,
  s.lng as site_lng
`;

// Lean variant of snapshotColumns for list/summary reads that never render a dive's Suunto profile.
// suunto_profile holds a whole dive-computer download's per-second GPS/HR/temperature samples --
// megabytes for a single imported dive -- and snapshotColumns selected it unconditionally on every
// row. Dashboard, Logbook and the detail page's own "other dives" list (used only for prev/next SAC
// comparison) only ever render title/site/depth/tags/rating, so that JSON was paid for (stringified
// out of Postgres, parsed back in Node, and for a while shipped whole to the browser) on every load
// without being read. Same root cause as the sibling gym app's issue #32. getDive/loadSnapshot/
// listDivesForBackup keep the full column for the single-dive and backup paths that actually need it.
const snapshotColumnsLean = snapshotColumns.replace(
  "d.suunto_profile",
  "null::jsonb as suunto_profile",
);

// The join is scoped by user_id on both sides: even if a dive somehow referenced a foreign site,
// its details would not be readable here.
const diveFrom = `
  from dives d
  left join dive_sites s on s.id = d.dive_site_id and s.user_id = d.user_id
`;

function diveValues(diveSiteId: number | null, input: DiveInput) {
  return [
    diveSiteId,
    input.title,
    input.occurredAt,
    input.maxDepth,
    input.avgDepth,
    input.bottomTimeMinutes,
    input.waterTemp,
    input.waterTempLow,
    input.airTemp,
    input.visibility,
    input.gasMix,
    input.tankInfo,
    input.cylinderSize,
    input.startPressure,
    input.endPressure,
    input.weight,
    input.weightFeedback,
    input.suitType,
    input.hood,
    input.gloves,
    input.boots,
    input.buddy,
    input.diveShop,
    input.current,
    input.surge,
    input.waves,
    input.weather,
    input.waterType,
    input.bodyOfWater,
    input.entryType,
    input.notes,
    input.rating,
    input.depthProfile === null || input.depthProfile === undefined
      ? null
      : JSON.stringify(input.depthProfile),
    input.depthProfileRaw,
    input.tags,
  ];
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

// Autocomplete source for the dive form's tags field: the session user's own tag vocabulary,
// deduped and ranked by how many of their dives use each one. "missing-padi"/"missing-suunto" are
// never in here since they're never stored (see lib/tags.ts's effectiveTags()).
export async function listUserTags(userId: string, query?: string): Promise<string[]> {
  const result = await queryRead<{ tag: string }>(
    `
      select tag, count(*) as dive_count
      from dives, unnest(tags) as tag
      where user_id = $1
        and ($2::text is null or tag ilike '%' || $2 || '%')
      group by tag
      order by dive_count desc, tag asc
      limit 50
    `,
    [userId, query?.trim() ? query.trim() : null],
  );

  return result.rows.map((row) => row.tag);
}

// ---------------------------------------------------------------------------
// Dive sites
// ---------------------------------------------------------------------------

// Autocomplete source for the dive form. Only ever the session user's own sites -- there is no
// shared cross-user site directory in v1.
export async function listDiveSites(userId: string, query?: string): Promise<DiveSiteRow[]> {
  const result = await queryRead<DiveSiteRow>(
    `
      select id, name, location, lat, lng, created_at
      from dive_sites
      where user_id = $1
        and ($2::text is null or name ilike '%' || $2 || '%')
      order by name asc
      limit 50
    `,
    [userId, query?.trim() ? query.trim() : null],
  );

  return result.rows;
}


export async function listDiveSitesWithDiveCounts(userId: string): Promise<DiveSiteWithDiveCount[]> {
  const result = await queryRead<DiveSiteWithDiveCount>(
    `
      select ds.id, ds.name, ds.location, ds.lat, ds.lng, ds.created_at, count(d.id)::int as dive_count
      from dive_sites ds
      left join dives d on d.dive_site_id = ds.id and d.user_id = ds.user_id
      where ds.user_id = $1
      group by ds.id, ds.name, ds.location, ds.lat, ds.lng, ds.created_at
      order by ds.name asc
    `,
    [userId],
  );

  return result.rows;
}

function normalizeDiveSiteInput(input: DiveSiteInput): Required<DiveSiteInput> {
  const name = input.name.trim();

  if (!name) {
    throw new Error("Dive site name is required.");
  }

  return {
    name,
    location: input.location?.trim() || null,
    lat: input.lat ?? null,
    lng: input.lng ?? null,
  };
}

async function loadDiveSiteWithDiveCount(
  executor: Pick<PoolClient, "query">,
  userId: string,
  siteId: number,
): Promise<DiveSiteWithDiveCount> {
  const result = await executor.query<DiveSiteWithDiveCount>(
    `
      select ds.id, ds.name, ds.location, ds.lat, ds.lng, ds.created_at, count(d.id)::int as dive_count
      from dive_sites ds
      left join dives d on d.dive_site_id = ds.id and d.user_id = ds.user_id
      where ds.id = $1 and ds.user_id = $2
      group by ds.id, ds.name, ds.location, ds.lat, ds.lng, ds.created_at
    `,
    [siteId, userId],
  );

  if (!result.rows[0]) throw new DiveSiteNotFoundError();
  return result.rows[0];
}

export async function updateDiveSite(
  userId: string,
  siteId: number,
  input: DiveSiteInput,
): Promise<DiveSiteWithDiveCount> {
  const normalized = normalizeDiveSiteInput(input);

  const updated = await getPool().query<DiveSiteRow>(
    `
      update dive_sites
      set name = $3, location = $4, lat = $5, lng = $6
      where id = $1 and user_id = $2
      returning id
    `,
    [siteId, userId, normalized.name, normalized.location, normalized.lat, normalized.lng],
  );

  if (updated.rowCount === 0) throw new DiveSiteNotFoundError();
  return loadDiveSiteWithDiveCount(getPool(), userId, siteId);
}

export async function mergeDiveSites(userId: string, input: DiveSiteMergeInput): Promise<DiveSiteMergeResult> {
  if (input.fromSiteId === input.intoSiteId) {
    throw new Error("Choose two different dive sites to merge.");
  }

  const normalized = normalizeDiveSiteInput(input);

  return inTransaction(async (client) => {
    const sites = await client.query<{ id: number }>(
      `
        select id
        from dive_sites
        where user_id = $1 and id = any($2::int[])
        for update
      `,
      [userId, [input.fromSiteId, input.intoSiteId]],
    );

    if (sites.rows.length !== 2) throw new DiveSiteNotFoundError();

    const updatedTarget = await client.query(
      `
        update dive_sites
        set name = $3, location = $4, lat = $5, lng = $6
        where id = $1 and user_id = $2
      `,
      [input.intoSiteId, userId, normalized.name, normalized.location, normalized.lat, normalized.lng],
    );

    if (updatedTarget.rowCount === 0) throw new DiveSiteNotFoundError();

    const moved = await client.query(
      `
        update dives
        set dive_site_id = $3, updated_at = now()
        where user_id = $1 and dive_site_id = $2
      `,
      [userId, input.fromSiteId, input.intoSiteId],
    );

    const deleted = await client.query("delete from dive_sites where id = $1 and user_id = $2", [
      input.fromSiteId,
      userId,
    ]);

    if (deleted.rowCount === 0) throw new DiveSiteNotFoundError();

    return {
      site: await loadDiveSiteWithDiveCount(client, userId, input.intoSiteId),
      movedDives: moved.rowCount ?? 0,
    };
  });
}

// Create-or-reuse for the form's site autocomplete: an existing site of this user with the same
// (case-insensitive) name is reused rather than duplicated. Takes an optional client so the site
// can be created inside the dive's own transaction -- a rolled-back dive write must not leave an
// orphaned site behind.
export async function findOrCreateDiveSite(
  userId: string,
  input: DiveSiteInput,
  client?: PoolClient,
): Promise<DiveSiteRow> {
  const name = input.name.trim();

  if (!name) {
    throw new Error("Dive site name is required.");
  }

  const executor = client ?? getPool();

  const existing = await executor.query<DiveSiteRow>(
    `
      select id, name, location, lat, lng, created_at
      from dive_sites
      where user_id = $1
        and lower(name) = lower($2)
      limit 1
    `,
    [userId, name],
  );

  if (existing.rows[0]) {
    return existing.rows[0];
  }

  const created = await executor.query<DiveSiteRow>(
    `
      insert into dive_sites (user_id, name, location, lat, lng)
      values ($1, $2, $3, $4, $5)
      returning id, name, location, lat, lng, created_at
    `,
    [userId, name, input.location ?? null, input.lat ?? null, input.lng ?? null],
  );

  return created.rows[0];
}

// A site id from a form is never trusted: one belonging to another user resolves to not-found
// rather than silently attaching that user's site to this dive.
async function resolveDiveSiteId(
  client: PoolClient,
  userId: string,
  site: DiveSiteSelection | null,
): Promise<number | null> {
  if (!site) return null;

  if ("id" in site) {
    const result = await client.query(
      "select id from dive_sites where id = $1 and user_id = $2 limit 1",
      [site.id, userId],
    );

    if (result.rowCount === 0) {
      throw new DiveSiteNotFoundError();
    }

    return site.id;
  }

  return (await findOrCreateDiveSite(userId, site, client)).id;
}

// ---------------------------------------------------------------------------
// Dive reads
// ---------------------------------------------------------------------------

export async function listDives(userId: string): Promise<DiveRecord[]> {
  const result = await queryRead<DiveRecord>(
    `
      select ${snapshotColumnsLean}, d.dive_site_id
      ${diveFrom}
      where d.user_id = $1
      order by d.occurred_at desc, d.id desc
    `,
    [userId],
  );

  return result.rows;
}

// Full-profile counterpart of listDives for the one caller that actually needs suunto_profile on
// every row: buildDivesBackupZip's dives.json is documented (issue #16) as "everything this app
// stores for one user's dives", so unlike the UI list views it may not silently drop the profile.
export async function listDivesForBackup(userId: string): Promise<DiveRecord[]> {
  const result = await queryRead<DiveRecord>(
    `
      select ${snapshotColumns}, d.dive_site_id
      ${diveFrom}
      where d.user_id = $1
      order by d.occurred_at desc, d.id desc
    `,
    [userId],
  );

  return result.rows;
}

// Returns null (never another user's row) when the id belongs to somebody else -- callers render
// not-found from that.
export async function getDive(userId: string, diveId: number): Promise<DiveRecord | null> {
  const result = await queryRead<DiveRecord>(
    `
      select ${snapshotColumns}, d.dive_site_id
      ${diveFrom}
      where d.id = $1
        and d.user_id = $2
      limit 1
    `,
    [diveId, userId],
  );

  return result.rows[0] ?? null;
}

// Deliberately separate from getDive/snapshotColumns -- see the DiveSnapshot comment above:
// suunto_original_bundle is intentionally excluded from every ordinary dive read, so the raw-data
// preview page gets its own narrowly-scoped query instead of widening the shared one. Returns null
// (never another user's row, and never a row with no bundle) so callers render not-found from
// either case alike.
export async function getDiveSuuntoOriginalBundle(
  userId: string,
  diveId: number,
): Promise<{ workoutKey: string; originalBundle: Buffer } | null> {
  const result = await queryRead<{ suunto_workout_key: string | null; suunto_original_bundle: Buffer | null }>(
    `
      select d.suunto_workout_key, d.suunto_original_bundle
      from dives d
      where d.id = $1
        and d.user_id = $2
      limit 1
    `,
    [diveId, userId],
  );

  const row = result.rows[0];
  if (!row || row.suunto_workout_key === null || row.suunto_original_bundle === null) return null;

  return { workoutKey: row.suunto_workout_key, originalBundle: row.suunto_original_bundle };
}

// Batch form of getDiveSuuntoOriginalBundle, for the dives backup zip: same ownership contract
// (rows of other users simply don't match, so an id that isn't the caller's is absent from the map
// rather than an error), same exclusion from snapshotColumns. Callers pass ids in bounded chunks --
// each row carries a whole gzipped export, so "select every bundle at once" would trade N round
// trips for one unbounded result set.

export async function getDiveGarminOriginalFit(
  userId: string,
  diveId: number,
): Promise<{ activityId: string; originalFit: Buffer } | null> {
  const result = await queryRead<{ garmin_activity_id: string | null; garmin_original_fit: Buffer | null }>(
    `
      select d.garmin_activity_id, d.garmin_original_fit
      from dives d
      where d.id = $1
        and d.user_id = $2
    `,
    [diveId, userId],
  );

  const row = result.rows[0];
  if (!row || row.garmin_activity_id === null || row.garmin_original_fit === null) return null;
  return { activityId: row.garmin_activity_id, originalFit: row.garmin_original_fit };
}

export async function getDiveSuuntoOriginalBundles(
  userId: string,
  diveIds: number[],
): Promise<Map<number, { workoutKey: string; originalBundle: Buffer }>> {
  if (diveIds.length === 0) return new Map();

  const result = await queryRead<{ id: number; suunto_workout_key: string | null; suunto_original_bundle: Buffer | null }>(
    `
      select d.id, d.suunto_workout_key, d.suunto_original_bundle
      from dives d
      where d.user_id = $1
        and d.id = any($2::int[])
    `,
    [userId, diveIds],
  );

  const bundles = new Map<number, { workoutKey: string; originalBundle: Buffer }>();
  for (const row of result.rows) {
    if (row.suunto_workout_key === null || row.suunto_original_bundle === null) continue;
    bundles.set(row.id, { workoutKey: row.suunto_workout_key, originalBundle: row.suunto_original_bundle });
  }

  return bundles;
}

export async function listSuuntoMergeDiveCandidates(
  userId: string,
  preferredAt: Date | string | null,
): Promise<SuuntoMergeDiveCandidate[]> {
  const preferred = preferredAt ? new Date(preferredAt) : null;
  const result = await queryRead<SuuntoMergeDiveCandidate>(
    `
      select ${snapshotColumnsLean}, d.dive_site_id
      ${diveFrom}
      where d.user_id = $1
        and d.suunto_workout_key is null
      order by
        case when $2::timestamptz is null then 1 else 0 end,
        case when $2::timestamptz is null then null else abs(extract(epoch from (d.occurred_at - $2::timestamptz))) end asc,
        d.occurred_at desc,
        d.id desc
      limit 25
    `,
    [userId, preferred && Number.isFinite(preferred.getTime()) ? preferred : null],
  );

  return result.rows;
}

export type RecentCylinder = {
  tankInfo: string | null;
  cylinderSize: string | null;
};


export type GarminMergeDiveCandidate = DiveRecord;

export async function listGarminMergeDiveCandidates(
  userId: string,
  preferredAt: Date | string | null,
): Promise<GarminMergeDiveCandidate[]> {
  const preferred = preferredAt ? new Date(preferredAt) : null;
  const result = await queryRead<GarminMergeDiveCandidate>(
    `
      select ${snapshotColumns}, d.dive_site_id
      ${diveFrom}
      where d.user_id = $1
        and d.garmin_activity_id is null
      order by
        case when $2::timestamptz is null then 1 else 0 end,
        case when $2::timestamptz is null then null else abs(extract(epoch from (d.occurred_at - $2::timestamptz))) end asc,
        d.occurred_at desc,
        d.id desc
      limit 25
    `,
    [userId, preferred && Number.isFinite(preferred.getTime()) ? preferred : null],
  );
  return result.rows;
}

export type SuuntoMergeDiveCandidate = DiveRecord;

// The form's optional "recent cylinder" picker: the user's last 5 distinct (tank_info,
// cylinder_size) combinations, ordered by the most recent dive that used each one -- not by
// creation order, so editing an old dive's gear doesn't reorder the list. Rows where the user
// recorded neither field are excluded; there's nothing to offer for those.
export async function listRecentCylinders(userId: string): Promise<RecentCylinder[]> {
  const result = await queryRead<{ tank_info: string | null; cylinder_size: string | null }>(
    `
      select tank_info, cylinder_size
      from (
        select
          tank_info,
          cylinder_size,
          max(occurred_at) as last_used_at
        from dives
        where user_id = $1
          and (tank_info is not null or cylinder_size is not null)
        group by tank_info, cylinder_size
      ) recent
      order by last_used_at desc
      limit 5
    `,
    [userId],
  );

  return result.rows.map((row) => ({ tankInfo: row.tank_info, cylinderSize: row.cylinder_size }));
}

// GitHub-style activity calendar (dashboard): dive counts per day, grouped in SQL rather than
// aggregated client-side over the full dive list, since only the count and date leave the query.
export type DailyDiveCount = { date: string; count: number };

export async function getDiveActivityByDay(
  userId: string,
  range: { from: Date; to: Date },
): Promise<DailyDiveCount[]> {
  const result = await queryRead<{ date: string; count: string }>(
    `
      select to_char(occurred_at, 'YYYY-MM-DD') as date, count(*) as count
      from dives
      where user_id = $1
        and occurred_at >= $2
        and occurred_at < $3
      group by 1
      order by 1 asc
    `,
    [userId, range.from, range.to],
  );

  return result.rows.map((row) => ({ date: row.date, count: Number(row.count) }));
}

// Bounds the activity calendar's "All" range selector -- how far back it needs to fetch data
// depends on when the user's logbook actually starts, not a fixed window.
export async function getEarliestDiveDate(userId: string): Promise<Date | null> {
  const result = await queryRead<{ earliest: string | null }>(
    `select min(occurred_at) as earliest from dives where user_id = $1`,
    [userId],
  );

  const earliest = result.rows[0]?.earliest;
  return earliest ? new Date(earliest) : null;
}

export type DiveStats = {
  totalDives: number;
  totalBottomTimeMinutes: number;
  deepestDepth: string | null;
  distinctSites: number;
};

export async function getDiveStats(userId: string): Promise<DiveStats> {
  const result = await queryRead<{
    total_dives: string;
    total_bottom_time_minutes: string | null;
    deepest_depth: string | null;
    distinct_sites: string;
  }>(
    `
      select
        count(*) as total_dives,
        coalesce(sum(bottom_time_minutes), 0) as total_bottom_time_minutes,
        max(max_depth) as deepest_depth,
        count(distinct dive_site_id) as distinct_sites
      from dives
      where user_id = $1
    `,
    [userId],
  );

  const row = result.rows[0];

  return {
    totalDives: Number(row?.total_dives ?? 0),
    totalBottomTimeMinutes: Number(row?.total_bottom_time_minutes ?? 0),
    deepestDepth: row?.deepest_depth ?? null,
    distinctSites: Number(row?.distinct_sites ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Dive mutations (each one write + enqueue in a single transaction)
// ---------------------------------------------------------------------------

async function loadSnapshot(
  client: PoolClient,
  userId: string,
  diveId: number,
): Promise<DiveSnapshot> {
  const result = await client.query<DiveSnapshot>(
    `
      select ${snapshotColumns}
      ${diveFrom}
      where d.id = $1
        and d.user_id = $2
      limit 1
    `,
    [diveId, userId],
  );

  const row = result.rows[0];

  if (!row) {
    throw new DiveNotFoundError();
  }

  return row;
}

// Each invocation gets its own UUID: two consecutive edits of the same dive must produce two
// distinct outbox rows, not one collapsed row (enqueueNotification dedupes on idempotency_key).
function backupKey(diveId: number, event: DiveEvent) {
  return `dive-backup:${diveId}:${event}:${randomUUID()}`;
}

async function enqueueDiveBackup(
  client: PoolClient,
  owner: DiveOwner,
  event: DiveEvent,
  dive: DiveSnapshot,
) {
  await enqueueNotification(
    {
      recipientEmail: owner.email,
      notificationType: "dive_backup",
      idempotencyKey: backupKey(dive.id, event),
      payload: { event, dive },
    },
    { client },
  );
}

// Mirrors the manual-transaction pattern used by the rest of this repo's write paths: connect,
// BEGIN, write, COMMIT, release in a finally. The backup enqueue shares this client, so a dive can
// never be written without its backup notification (or vice versa).
async function inTransaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();

  try {
    await client.query("begin");
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function createDive(owner: DiveOwner, input: DiveInput): Promise<DiveSnapshot> {
  return inTransaction(async (client) => {
    const diveSiteId = await resolveDiveSiteId(client, owner.id, input.site);

    const inserted = await client.query<{ id: number }>(
      `
        insert into dives (
          user_id, dive_site_id, title, occurred_at, max_depth, avg_depth, bottom_time_minutes,
          water_temp, water_temp_low, air_temp, visibility, gas_mix, tank_info, cylinder_size,
          start_pressure, end_pressure, weight, weight_feedback, suit_type, hood, gloves, boots,
          buddy, dive_shop, current, surge, waves, weather, water_type, body_of_water,
          entry_type, notes, rating, depth_profile, depth_profile_raw, tags
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
          $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36
        )
        returning id
      `,
      [owner.id, ...diveValues(diveSiteId, input)],
    );

    const snapshot = await loadSnapshot(client, owner.id, inserted.rows[0].id);
    await enqueueDiveBackup(client, owner, "create", snapshot);

    return snapshot;
  });
}

// Bulk-import path for PADI logbook sync (a later story's syncPadiLogbook calls this once per
// remote log record). Deliberately NOT a parameter added to createDive: reusing createDive's shared
// write path for the 8 PADI-only columns is exactly the shape that caused the v2 data-loss bug (see
// this module's comment on DiveInput/diveValues/updateDive above) -- an ordinary edit's `undefined`
// for those columns would silently null them out via the existing `?? null` coercion. Instead this
// function owns its own insert, reusing diveValues() only for the DiveInput-shaped prefix so future
// DiveInput columns keep flowing into PADI imports automatically, and appending the 8 padiFields
// values as a positional tail that updateDive's SET list never touches.
//
// dive_site_id is unconditionally null: PADI's dive_location -> dive-site join is an explicitly
// deferred follow-up (see the plan), not implemented here.
//
// No backup email is enqueued here, on either the inserted or the conflict-skipped path -- bulk
// importing dozens/hundreds of dives must not enqueue dozens/hundreds of dive_backup rows through a
// queue tuned for one-off human edits. A PADI-imported dive gets its first backup email the normal
// way, the next time it's edited via the ordinary, untouched updateDive path.
export async function createDiveFromPadi(
  owner: DiveOwner,
  input: Partial<DiveInput>,
  padiFields: PadiOnlyFields,
): Promise<{ inserted: false } | { inserted: true; id: number }> {
  return inTransaction(async (client) => {
    // Same name-based create-or-reuse as the ordinary dive form (findOrCreateDiveSite): a PADI
    // dive_location that matches an existing site of this user (case-insensitively) reuses it
    // rather than duplicating it, so importing the same location across many dives converges on
    // one dive_sites row, same as a human typing the same name into the form repeatedly would.
    const diveSiteId = await resolveDiveSiteId(client, owner.id, input.site ?? null);

    // diveValues() requires a fully-populated DiveInput -- pg throws on an `undefined` query param,
    // so every field mapPadiLogToDive didn't set (avgDepth, rating, depthProfile, depthProfileRaw)
    // is defaulted to null here rather than left absent. `site` itself is never read by
    // diveValues() (it takes the already-resolved diveSiteId as a separate argument instead), so
    // its value here is unused -- present only to satisfy DiveInput's type.
    const fullInput: DiveInput = {
      site: null,
      title: input.title ?? null,
      occurredAt: input.occurredAt as Date | string,
      maxDepth: input.maxDepth ?? null,
      avgDepth: input.avgDepth ?? null,
      bottomTimeMinutes: input.bottomTimeMinutes ?? null,
      waterTemp: input.waterTemp ?? null,
      waterTempLow: input.waterTempLow ?? null,
      airTemp: input.airTemp ?? null,
      visibility: input.visibility ?? null,
      gasMix: input.gasMix ?? null,
      tankInfo: input.tankInfo ?? null,
      cylinderSize: input.cylinderSize ?? null,
      startPressure: input.startPressure ?? null,
      endPressure: input.endPressure ?? null,
      weight: input.weight ?? null,
      weightFeedback: input.weightFeedback ?? null,
      suitType: input.suitType ?? null,
      hood: input.hood ?? null,
      gloves: input.gloves ?? null,
      boots: input.boots ?? null,
      buddy: input.buddy ?? null,
      diveShop: input.diveShop ?? null,
      current: input.current ?? null,
      surge: input.surge ?? null,
      waves: input.waves ?? null,
      weather: input.weather ?? null,
      waterType: input.waterType ?? null,
      bodyOfWater: input.bodyOfWater ?? null,
      entryType: input.entryType ?? null,
      notes: input.notes ?? null,
      rating: input.rating ?? null,
      depthProfile: input.depthProfile ?? null,
      depthProfileRaw: input.depthProfileRaw ?? null,
      tags: input.tags ?? [],
    };

    const inserted = await client.query<{ id: number }>(
      `
        insert into dives (
          user_id, dive_site_id, title, occurred_at, max_depth, avg_depth, bottom_time_minutes,
          water_temp, water_temp_low, air_temp, visibility, gas_mix, tank_info, cylinder_size,
          start_pressure, end_pressure, weight, weight_feedback, suit_type, hood, gloves, boots,
          buddy, dive_shop, current, surge, waves, weather, water_type, body_of_water,
          entry_type, notes, rating, depth_profile, depth_profile_raw, tags,
          padi_dive_id, dive_number, padi_member_number, adventure_dive, dive_type, log_type,
          log_course, padi_status
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
          $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36,
          $37, $38, $39, $40, $41, $42, $43, $44
        )
        on conflict (user_id, padi_dive_id) where padi_dive_id is not null do nothing
        returning id
      `,
      [
        owner.id,
        ...diveValues(diveSiteId, fullInput),
        // Spelled out explicitly (not Object.values(padiFields)): several of PadiOnlyFields'
        // properties share the same type (dive_number/padi_member_number are both integer;
        // dive_type/log_type/log_course/padi_status are all text), so an object-key-order-dependent
        // spread would let a future reordering of PadiOnlyFields silently swap two columns with no
        // type error.
        padiFields.padi_dive_id,
        padiFields.dive_number,
        padiFields.padi_member_number,
        padiFields.adventure_dive,
        padiFields.dive_type,
        padiFields.log_type,
        padiFields.log_course,
        padiFields.padi_status,
      ],
    );

    if (inserted.rows.length === 0) {
      // The conflict-skip path can leave a just-created-or-reused dive_sites row with nothing
      // pointing at it (resolveDiveSiteId ran before this insert no-op'd). Harmless: the site
      // still matches by name for any future import, so it gets reused rather than duplicated --
      // same trade-off lib/dives.ts's own createDive already accepts for a rolled-back write.
      return { inserted: false };
    }

    return { inserted: true, id: inserted.rows[0].id };
  });
}

export type CreateDiveFromSuuntoImportResult =
  | { inserted: false; reason: "missing_import" | "already_saved" }
  | { inserted: true; dive: DiveSnapshot };

export type MergeSuuntoImportIntoDiveResult =
  | { merged: false; reason: "missing_import" | "missing_dive" | "already_saved" }
  | { merged: true; dive: DiveSnapshot };

// Human-reviewed save path for staged Suunto imports. It is deliberately separate from
// createDive()/updateDive(): Suunto provenance/profile/bundle columns are write-once here and never
// touched by ordinary manual edits, preserving the source identity needed for exact workout-key
// dedupe and later PADI upload eligibility. The staged row is deleted in the same transaction as the
// dive insert, so a consumed queue item cannot reappear after a successful save.
export async function createDiveFromSuuntoImport(
  owner: DiveOwner,
  suuntoImportId: number,
  input: DiveInput,
): Promise<CreateDiveFromSuuntoImportResult> {
  return inTransaction(async (client) => {
    const source = await client.query<{
      workout_key: string;
      compiled_profile: unknown;
      original_bundle: Buffer;
    }>(
      `
        select workout_key, compiled_profile, original_bundle
        from suunto_imports
        where id = $1
          and user_id = $2
        for update
      `,
      [suuntoImportId, owner.id],
    );

    const row = source.rows[0];
    if (!row) {
      return { inserted: false, reason: "missing_import" };
    }

    const diveSiteId = await resolveDiveSiteId(client, owner.id, input.site);

    const inserted = await client.query<{ id: number }>(
      `
        insert into dives (
          user_id, dive_site_id, title, occurred_at, max_depth, avg_depth, bottom_time_minutes,
          water_temp, water_temp_low, air_temp, visibility, gas_mix, tank_info, cylinder_size,
          start_pressure, end_pressure, weight, weight_feedback, suit_type, hood, gloves, boots,
          buddy, dive_shop, current, surge, waves, weather, water_type, body_of_water,
          entry_type, notes, rating, depth_profile, depth_profile_raw, tags,
          suunto_workout_key, suunto_profile, suunto_original_bundle
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
          $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36,
          $37, $38::jsonb, $39
        )
        on conflict (user_id, suunto_workout_key) where suunto_workout_key is not null do nothing
        returning id
      `,
      [
        owner.id,
        ...diveValues(diveSiteId, input),
        row.workout_key,
        JSON.stringify(row.compiled_profile),
        row.original_bundle,
      ],
    );

    if (inserted.rows.length === 0) {
      await client.query("delete from suunto_imports where id = $1 and user_id = $2", [
        suuntoImportId,
        owner.id,
      ]);
      return { inserted: false, reason: "already_saved" };
    }

    await client.query("delete from suunto_imports where id = $1 and user_id = $2", [
      suuntoImportId,
      owner.id,
    ]);

    const snapshot = await loadSnapshot(client, owner.id, inserted.rows[0].id);
    await enqueueDiveBackup(client, owner, "create", snapshot);

    return { inserted: true, dive: snapshot };
  });
}


export type CreateDiveFromGarminImportResult =
  | { inserted: true; dive: DiveSnapshot }
  | { inserted: false; reason: "already_saved" | "missing_import" };

export async function createDiveFromGarminImport(
  owner: DiveOwner,
  garminImportId: number,
  input: DiveInput,
): Promise<CreateDiveFromGarminImportResult> {
  return inTransaction(async (client) => {
    const source = await client.query<{
      activity_id: string;
      compiled_profile: unknown;
      original_fit: Buffer;
    }>(
      `
        select activity_id, compiled_profile, original_fit
        from garmin_imports
        where id = $1
          and user_id = $2
        for update
      `,
      [garminImportId, owner.id],
    );

    const row = source.rows[0];
    if (!row) {
      return { inserted: false, reason: "missing_import" };
    }

    const diveSiteId = await resolveDiveSiteId(client, owner.id, input.site);

    const inserted = await client.query<{ id: number }>(
      `
        insert into dives (
          user_id, dive_site_id, title, occurred_at, max_depth, avg_depth, bottom_time_minutes,
          water_temp, water_temp_low, air_temp, visibility, gas_mix, tank_info, cylinder_size,
          start_pressure, end_pressure, weight, weight_feedback, suit_type, hood, gloves, boots,
          buddy, dive_shop, current, surge, waves, weather, water_type, body_of_water,
          entry_type, notes, rating, depth_profile, depth_profile_raw, tags,
          garmin_activity_id, garmin_profile, garmin_original_fit
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
          $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36,
          $37, $38::jsonb, $39
        )
        on conflict (user_id, garmin_activity_id) where garmin_activity_id is not null do nothing
        returning id
      `,
      [
        owner.id,
        ...diveValues(diveSiteId, input),
        row.activity_id,
        JSON.stringify(row.compiled_profile),
        row.original_fit,
      ],
    );

    if (inserted.rows.length === 0) {
      await client.query("delete from garmin_imports where id = $1 and user_id = $2", [
        garminImportId,
        owner.id,
      ]);
      return { inserted: false, reason: "already_saved" };
    }

    await client.query("delete from garmin_imports where id = $1 and user_id = $2", [
      garminImportId,
      owner.id,
    ]);

    const snapshot = await loadSnapshot(client, owner.id, inserted.rows[0].id);
    await enqueueDiveBackup(client, owner, "create", snapshot);

    return { inserted: true, dive: snapshot };
  });
}

export async function mergeSuuntoImportIntoDive(
  owner: DiveOwner,
  suuntoImportId: number,
  targetDiveId: number,
  input: DiveInput,
): Promise<MergeSuuntoImportIntoDiveResult> {
  return inTransaction(async (client) => {
    const source = await client.query<{
      workout_key: string;
      compiled_profile: unknown;
      original_bundle: Buffer;
    }>(
      `
        select workout_key, compiled_profile, original_bundle
        from suunto_imports
        where id = $1
          and user_id = $2
        for update
      `,
      [suuntoImportId, owner.id],
    );

    const row = source.rows[0];
    if (!row) return { merged: false, reason: "missing_import" };

    const target = await client.query<{ suunto_workout_key: string | null }>(
      `
        select suunto_workout_key
        from dives
        where id = $1
          and user_id = $2
        for update
      `,
      [targetDiveId, owner.id],
    );

    if (!target.rows[0]) return { merged: false, reason: "missing_dive" };
    if (target.rows[0].suunto_workout_key && target.rows[0].suunto_workout_key !== row.workout_key) {
      return { merged: false, reason: "already_saved" };
    }

    const duplicate = await client.query<{ exists: boolean }>(
      `
        select exists(
          select 1 from dives
          where user_id = $1
            and suunto_workout_key = $2
            and id <> $3
        ) as exists
      `,
      [owner.id, row.workout_key, targetDiveId],
    );

    if (duplicate.rows[0]?.exists) {
      await client.query("delete from suunto_imports where id = $1 and user_id = $2", [
        suuntoImportId,
        owner.id,
      ]);
      return { merged: false, reason: "already_saved" };
    }

    const diveSiteId = await resolveDiveSiteId(client, owner.id, input.site);

    const updated = await client.query(
      `
        update dives set
          dive_site_id = $3,
          title = $4,
          occurred_at = $5,
          max_depth = $6,
          avg_depth = $7,
          bottom_time_minutes = $8,
          water_temp = $9,
          water_temp_low = $10,
          air_temp = $11,
          visibility = $12,
          gas_mix = $13,
          tank_info = $14,
          cylinder_size = $15,
          start_pressure = $16,
          end_pressure = $17,
          weight = $18,
          weight_feedback = $19,
          suit_type = $20,
          hood = $21,
          gloves = $22,
          boots = $23,
          buddy = $24,
          dive_shop = $25,
          current = $26,
          surge = $27,
          waves = $28,
          weather = $29,
          water_type = $30,
          body_of_water = $31,
          entry_type = $32,
          notes = $33,
          rating = $34,
          depth_profile = $35,
          depth_profile_raw = $36,
          tags = $37,
          suunto_workout_key = $38,
          suunto_profile = $39::jsonb,
          suunto_original_bundle = $40,
          padi_needs_update = case
            when padi_dive_id is not null and log_type = 'Recreational' and log_course is null then true
            else padi_needs_update
          end,
          updated_at = now()
        where id = $1
          and user_id = $2
      `,
      [
        targetDiveId,
        owner.id,
        ...diveValues(diveSiteId, input),
        row.workout_key,
        JSON.stringify(row.compiled_profile),
        row.original_bundle,
      ],
    );

    if (updated.rowCount === 0) return { merged: false, reason: "missing_dive" };

    await client.query("delete from suunto_imports where id = $1 and user_id = $2", [
      suuntoImportId,
      owner.id,
    ]);

    const snapshot = await loadSnapshot(client, owner.id, targetDiveId);
    await enqueueDiveBackup(client, owner, "edit", snapshot);

    return { merged: true, dive: snapshot };
  });
}


export type MergeGarminImportIntoDiveResult =
  | { merged: true; dive: DiveSnapshot }
  | { merged: false; reason: "missing_dive" | "already_saved" | "missing_import" };

export async function mergeGarminImportIntoDive(
  owner: DiveOwner,
  garminImportId: number,
  targetDiveId: number,
  input: DiveInput,
): Promise<MergeGarminImportIntoDiveResult> {
  return inTransaction(async (client) => {
    const source = await client.query<{
      activity_id: string;
      compiled_profile: unknown;
      original_fit: Buffer;
    }>(
      `
        select activity_id, compiled_profile, original_fit
        from garmin_imports
        where id = $1
          and user_id = $2
        for update
      `,
      [garminImportId, owner.id],
    );

    const row = source.rows[0];
    if (!row) return { merged: false, reason: "missing_import" };

    const target = await client.query<{ garmin_activity_id: string | null }>(
      `
        select garmin_activity_id
        from dives
        where id = $1
          and user_id = $2
        for update
      `,
      [targetDiveId, owner.id],
    );

    if (!target.rows[0]) return { merged: false, reason: "missing_dive" };
    if (target.rows[0].garmin_activity_id && target.rows[0].garmin_activity_id !== row.activity_id) {
      return { merged: false, reason: "already_saved" };
    }

    const duplicate = await client.query<{ exists: boolean }>(
      `
        select exists(
          select 1 from dives
          where user_id = $1
            and garmin_activity_id = $2
            and id <> $3
        ) as exists
      `,
      [owner.id, row.activity_id, targetDiveId],
    );

    if (duplicate.rows[0]?.exists) {
      await client.query("delete from garmin_imports where id = $1 and user_id = $2", [
        garminImportId,
        owner.id,
      ]);
      return { merged: false, reason: "already_saved" };
    }

    const diveSiteId = await resolveDiveSiteId(client, owner.id, input.site);

    const updated = await client.query(
      `
        update dives set
          dive_site_id = $3,
          title = $4,
          occurred_at = $5,
          max_depth = $6,
          avg_depth = $7,
          bottom_time_minutes = $8,
          water_temp = $9,
          water_temp_low = $10,
          air_temp = $11,
          visibility = $12,
          gas_mix = $13,
          tank_info = $14,
          cylinder_size = $15,
          start_pressure = $16,
          end_pressure = $17,
          weight = $18,
          weight_feedback = $19,
          suit_type = $20,
          hood = $21,
          gloves = $22,
          boots = $23,
          buddy = $24,
          dive_shop = $25,
          current = $26,
          surge = $27,
          waves = $28,
          weather = $29,
          water_type = $30,
          body_of_water = $31,
          entry_type = $32,
          notes = $33,
          rating = $34,
          depth_profile = $35,
          depth_profile_raw = $36,
          tags = $37,
          garmin_activity_id = $38,
          garmin_profile = $39::jsonb,
          garmin_original_fit = $40,
          padi_needs_update = case
            when padi_dive_id is not null and log_type = 'Recreational' and log_course is null then true
            else padi_needs_update
          end,
          updated_at = now()
        where id = $1
          and user_id = $2
      `,
      [
        targetDiveId,
        owner.id,
        ...diveValues(diveSiteId, input),
        row.activity_id,
        JSON.stringify(row.compiled_profile),
        row.original_fit,
      ],
    );

    if (updated.rowCount === 0) return { merged: false, reason: "missing_dive" };

    await client.query("delete from garmin_imports where id = $1 and user_id = $2", [
      garminImportId,
      owner.id,
    ]);

    const snapshot = await loadSnapshot(client, owner.id, targetDiveId);
    await enqueueDiveBackup(client, owner, "edit", snapshot);

    return { merged: true, dive: snapshot };
  });
}

export async function updateDive(
  owner: DiveOwner,
  diveId: number,
  input: DiveInput,
): Promise<DiveSnapshot> {
  return inTransaction(async (client) => {
    const diveSiteId = await resolveDiveSiteId(client, owner.id, input.site);

    const updated = await client.query(
      `
        update dives set
          dive_site_id = $3,
          title = $4,
          occurred_at = $5,
          max_depth = $6,
          avg_depth = $7,
          bottom_time_minutes = $8,
          water_temp = $9,
          water_temp_low = $10,
          air_temp = $11,
          visibility = $12,
          gas_mix = $13,
          tank_info = $14,
          cylinder_size = $15,
          start_pressure = $16,
          end_pressure = $17,
          weight = $18,
          weight_feedback = $19,
          suit_type = $20,
          hood = $21,
          gloves = $22,
          boots = $23,
          buddy = $24,
          dive_shop = $25,
          current = $26,
          surge = $27,
          waves = $28,
          weather = $29,
          water_type = $30,
          body_of_water = $31,
          entry_type = $32,
          notes = $33,
          rating = $34,
          depth_profile = $35,
          depth_profile_raw = $36,
          tags = $37,
          padi_needs_update = case
            when padi_dive_id is not null and log_type = 'Recreational' and log_course is null then true
            else padi_needs_update
          end,
          updated_at = now()
        where id = $1
          and user_id = $2
      `,
      [diveId, owner.id, ...diveValues(diveSiteId, input)],
    );

    // Fails closed: a dive id belonging to another user matches no row here, so the update is a
    // no-op and this throws instead of reporting success.
    if (updated.rowCount === 0) {
      throw new DiveNotFoundError();
    }

    const snapshot = await loadSnapshot(client, owner.id, diveId);
    await enqueueDiveBackup(client, owner, "edit", snapshot);

    return snapshot;
  });
}

export async function findDiveByPadiId(userId: string, padiDiveId: number): Promise<DiveRecord | null> {
  const result = await queryRead<DiveRecord>(
    `
      select ${snapshotColumns}, d.dive_site_id
      ${diveFrom}
      where d.user_id = $1
        and d.padi_dive_id = $2
      limit 1
    `,
    [userId, padiDiveId],
  );

  return result.rows[0] ?? null;
}

export async function markPadiComparison(
  userId: string,
  padiDiveId: number,
  needsUpdate: boolean,
): Promise<void> {
  await getPool().query(
    `
      update dives
      set padi_needs_update = $3,
          padi_last_compared_at = now()
      where user_id = $1
        and padi_dive_id = $2
    `,
    [userId, padiDiveId, needsUpdate],
  );
}

export async function deleteDive(owner: DiveOwner, diveId: number): Promise<DiveSnapshot> {
  return inTransaction(async (client) => {
    // Snapshot first: once the row is gone the worker draining the queue later has no way to
    // re-read it, so the payload captured here is the only copy the backup email can be built from.
    const snapshot = await loadSnapshot(client, owner.id, diveId);

    const deleted = await client.query("delete from dives where id = $1 and user_id = $2", [
      diveId,
      owner.id,
    ]);

    if (deleted.rowCount === 0) {
      throw new DiveNotFoundError();
    }

    await enqueueDiveBackup(client, owner, "delete", snapshot);

    return snapshot;
  });
}
