import "server-only";

import { getPool, queryRead } from "@/lib/db";
import type { DiveInput } from "@/lib/dives";
import type { GarminDiveProfile } from "./profile";

export type GarminImportRow = {
  id: number;
  activity_id: string;
  activity_started_at: Date | null;
  summary: unknown;
  draft_dive: Partial<DiveInput>;
  compiled_profile: GarminDiveProfile;
  created_at: Date;
};

export type StageGarminImportInput = {
  activityId: string;
  activityStartedAt: string | Date | null;
  summary: unknown;
  draftDive: Partial<DiveInput>;
  compiledProfile: GarminDiveProfile;
  originalFit: Buffer;
};

export type StageGarminImportResult =
  | { staged: true; id: number }
  | { staged: false; reason: "already_staged" | "already_saved" };

export type GarminDuplicateStatus = "new" | "already_staged" | "already_saved";

export async function stageGarminImport(
  userId: string,
  input: StageGarminImportInput,
): Promise<StageGarminImportResult> {
  const result = await getPool().query<{ id: number }>(
    `
      insert into garmin_imports
        (user_id, activity_id, activity_started_at, summary, draft_dive, compiled_profile, original_fit, updated_at)
      select $1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, now()
      where not exists (
        select 1 from dives where user_id = $1 and garmin_activity_id = $2
      )
      on conflict (user_id, activity_id) do nothing
      returning id
    `,
    [
      userId,
      input.activityId,
      input.activityStartedAt,
      JSON.stringify(input.summary ?? {}),
      JSON.stringify(input.draftDive ?? {}),
      JSON.stringify(input.compiledProfile),
      input.originalFit,
    ],
  );

  if (result.rows[0]) return { staged: true, id: result.rows[0].id };

  const saved = await queryRead<{ exists: boolean }>(
    "select exists(select 1 from dives where user_id = $1 and garmin_activity_id = $2) as exists",
    [userId, input.activityId],
  );
  return { staged: false, reason: saved.rows[0]?.exists ? "already_saved" : "already_staged" };
}

export async function getGarminDuplicateStatuses(
  userId: string,
  activityIds: string[],
): Promise<Map<string, GarminDuplicateStatus>> {
  const uniqueKeys = [...new Set(activityIds.filter((key) => key.trim()))];
  const statuses = new Map<string, GarminDuplicateStatus>();
  for (const key of uniqueKeys) statuses.set(key, "new");
  if (uniqueKeys.length === 0) return statuses;

  const result = await queryRead<{ activity_id: string; status: Exclude<GarminDuplicateStatus, "new"> }>(
    `
      select garmin_activity_id as activity_id, 'already_saved'::text as status
      from dives
      where user_id = $1
        and garmin_activity_id = any($2::text[])
      union all
      select activity_id, 'already_staged'::text as status
      from garmin_imports
      where user_id = $1
        and activity_id = any($2::text[])
    `,
    [userId, uniqueKeys],
  );

  for (const row of result.rows) {
    if (statuses.get(row.activity_id) === "already_saved") continue;
    statuses.set(row.activity_id, row.status);
  }

  return statuses;
}

export async function getFirstPendingGarminImportId(userId: string): Promise<number | null> {
  const result = await queryRead<{ id: number }>(
    `
      select id
      from garmin_imports
      where user_id = $1
      order by coalesce(activity_started_at, created_at) asc, id asc
      limit 1
    `,
    [userId],
  );
  return result.rows[0]?.id ?? null;
}

export async function getNextPendingGarminImportId(userId: string, currentImportId: number): Promise<number | null> {
  const result = await queryRead<{ id: number }>(
    `
      with ordered as (
        select
          id,
          row_number() over (order by coalesce(activity_started_at, created_at) asc, id asc) as position
        from garmin_imports
        where user_id = $1
      ),
      current_position as (
        select position from ordered where id = $2
      )
      select ordered.id
      from ordered
      cross join current_position
      where ordered.position > current_position.position
      order by ordered.position asc
      limit 1
    `,
    [userId, currentImportId],
  );
  return result.rows[0]?.id ?? null;
}

export async function countPendingGarminImports(userId: string): Promise<number> {
  const result = await queryRead<{ count: string }>(
    "select count(*) as count from garmin_imports where user_id = $1",
    [userId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function listPendingGarminImports(userId: string): Promise<GarminImportRow[]> {
  const result = await queryRead<GarminImportRow>(
    `
      select id, activity_id, activity_started_at, summary, draft_dive, compiled_profile, created_at
      from garmin_imports
      where user_id = $1
      order by coalesce(activity_started_at, created_at) asc, id asc
    `,
    [userId],
  );
  return result.rows;
}

export async function getPendingGarminImport(
  userId: string,
  importId: number,
): Promise<(GarminImportRow & { remaining_count: number }) | null> {
  const result = await queryRead<GarminImportRow & { remaining_count: string }>(
    `
      with pending as (
        select id, activity_id, activity_started_at, summary, draft_dive, compiled_profile, created_at
        from garmin_imports
        where user_id = $1
      )
      select pending.*, counts.remaining_count
      from pending
      cross join (select count(*)::int as remaining_count from pending) counts
      where pending.id = $2
      limit 1
    `,
    [userId, importId],
  );

  const row = result.rows[0];
  if (!row) return null;
  return { ...row, remaining_count: Number(row.remaining_count) };
}

export async function deleteGarminImport(userId: string, importId: number): Promise<boolean> {
  const result = await getPool().query("delete from garmin_imports where id = $1 and user_id = $2", [
    importId,
    userId,
  ]);
  return (result.rowCount ?? 0) > 0;
}
