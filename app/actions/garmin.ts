"use server";

import { revalidatePath } from "next/cache";
import pg from "pg";

import { getDatabaseUrl } from "@/lib/database-url";
import { createDiveFromGarminImport, mergeGarminImportIntoDive, type DiveInput } from "@/lib/dives";
import {
  assertGarminIntegrationConfigured,
  deleteGarminIntegration,
  getGarminSessionJson,
  hashGarminEmail,
  markGarminFetched,
  markGarminNeedsReconnect,
  saveGarminIntegration,
} from "@/lib/garmin/integrations";
import {
  countPendingGarminImports,
  deleteGarminImport,
  getGarminDuplicateStatuses,
  getNextPendingGarminImportId,
  listPendingGarminImports,
  stageGarminImport,
} from "@/lib/garmin/imports";
import { compileGarminProfile } from "@/lib/garmin/profile";
import { extractFitFromZip, parseFitBuffer } from "@/lib/garmin/raw-fit";
import {
  downloadGarminFit,
  listGarminActivities,
  GarminSidecarError,
  garminLogin,
  type GarminActivitySummary,
} from "@/lib/garmin/sidecar-client";
import { requireUser } from "@/lib/session";
import {
  checkGarminRateLimit,
  isGarminRateLimited,
  recordFailedGarminAttempt,
} from "@/lib/garmin/rate-limit";

const UNAVAILABLE_ERROR = "Garmin import is temporarily unavailable. Please try again later.";

// Non-blocking advisory lock keyed by a fixed classid, exactly as lib/padi/sync.ts does for PADI --
// distinct from PADI's 84271 so the two features can never block each other. Arbitrary, just needs
// to stay fixed once chosen.
const ADVISORY_LOCK_CLASSID = 84273;

// Wall-time budget for the unbounded "all time" fetch. Deliberately larger than PADI's 45s: a single
// Garmin export can run up to the sidecar's 180s export timeout, so a smaller budget would often
// stage nothing per click. A budget hit is a resumption, not a failure -- the dedupe in
// getGarminDuplicateStatuses makes clicking Fetch again pick up exactly where this left off.
// Overridable by env solely so tests can shrink it; production never sets it.
const FETCH_ALL_BUDGET_MS = 90_000;

function fetchAllBudgetMs(): number {
  const override = Number(process.env.GARMIN_FETCH_ALL_BUDGET_MS);
  // Clamped at both ends so a misconfigured override can neither disable the budget nor stretch it
  // far past what the request itself can survive.
  return Number.isFinite(override) && override > 0
    ? Math.min(override, FETCH_ALL_BUDGET_MS * 4)
    : FETCH_ALL_BUDGET_MS;
}

export type GarminActionResult = { ok: true } | { ok: false; error: string };

export type FetchGarminRequest = { mode: "days"; daysBack: number } | { mode: "all" };

export type DeleteGarminImportActionResult =
  | { ok: true; nextImportId: number | null; pendingCount: number }
  | { ok: false; error: string };

export type FetchGarminActionResult =
  | {
      ok: true;
      checked: number;
      staged: number;
      alreadySaved: number;
      alreadyStaged: number;
      skippedNonDives: number;
      failedExports: number;
      pendingCount: number;
      nextImportId: number | null;
      // True only in "all" mode, when the wall-time budget stopped the loop with workouts left to
      // try. The user clicks Fetch again to continue; `mode: "days"` is always false.
      remaining: boolean;
    }
  | { ok: false; error: string; reason?: string };

export type SaveGarminImportActionResult =
  | { ok: true; id: number; nextImportId: number | null; pendingCount: number }
  | { ok: false; error: string; reason: "missing_import" | "missing_dive" | "already_saved" | "unknown" };

function revalidateGarminPaths(diveId?: number) {
  revalidatePath("/settings/integrations");
  revalidatePath("/dives");
  revalidatePath("/dashboard");
  if (diveId !== undefined) revalidatePath(`/dives/${diveId}`);
}

function activityId(workout: GarminActivitySummary): string | null {
  const candidates = [workout.key, workout.activityId, workout.id, workout.workoutId];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  }
  return null;
}

function startedAt(workout: GarminActivitySummary, compiledStartedAt: string | null): string | null {
  if (compiledStartedAt) return compiledStartedAt;
  const candidate = workout.startTime ?? workout.startTimeUnix ?? workout.start_time;
  if (typeof candidate === "number") {
    const ms = candidate > 10_000_000_000 ? candidate : candidate * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof candidate === "string" && candidate) {
    const ms = Date.parse(candidate);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

function toUserError(error: unknown): { error: string; reason?: string } {
  if (error instanceof GarminSidecarError) {
    if (error.reason === "auth_expired") {
      return { error: "Your Garmin session expired. Reconnect Garmin and try again.", reason: error.reason };
    }
    if (error.reason === "bad_request") {
      return { error: "Garmin request was invalid. Check the form and try again.", reason: error.reason };
    }
    return { error: UNAVAILABLE_ERROR, reason: error.reason };
  }
  return { error: UNAVAILABLE_ERROR };
}

export async function connectGarminAction(email: string, password: string): Promise<GarminActionResult> {
  const user = await requireUser();

  let emailHash: string;
  try {
    // Validate local storage prerequisites before contacting Garmin with the user's password. If
    // encryption/pepper config is missing, the user cannot fix it by retrying credentials.
    assertGarminIntegrationConfigured();
    emailHash = hashGarminEmail(email);
  } catch (error) {
    console.error("Garmin connect preflight failed", error);
    return { ok: false, error: UNAVAILABLE_ERROR };
  }

  const rateLimitCheck = await checkGarminRateLimit(user.id, emailHash);
  if (isGarminRateLimited(rateLimitCheck)) {
    return { ok: false, error: "Too many attempts. Please wait a while before trying again." };
  }

  let login: Awaited<ReturnType<typeof garminLogin>>;
  try {
    login = await garminLogin(email, password);
  } catch (error) {
    if (error instanceof GarminSidecarError && error.reason === "auth_expired") {
      await recordFailedGarminAttempt(user.id, email);
      return { ok: false, error: "Could not sign in to Garmin. Check your email and password." };
    }
    return { ok: false, error: toUserError(error).error };
  }

  try {
    await saveGarminIntegration(user.id, { email, sessionJson: login.sessionJson });
  } catch (error) {
    console.error("Garmin session save failed", error);
    return { ok: false, error: UNAVAILABLE_ERROR };
  }

  revalidateGarminPaths();
  return { ok: true };
}

export async function disconnectGarminAction(): Promise<GarminActionResult> {
  const user = await requireUser();
  await deleteGarminIntegration(user.id);
  revalidateGarminPaths();
  return { ok: true };
}

type StageWorkoutsResult =
  | { ok: true; counts: FetchCounts; remaining: boolean }
  | { ok: false; error: string; reason?: string };

type FetchCounts = {
  checked: number;
  staged: number;
  alreadySaved: number;
  alreadyStaged: number;
  skippedNonDives: number;
  failedExports: number;
};

/**
 * Dedupes, exports, compiles and stages a listed batch of workouts. Shared verbatim by both fetch
 * modes; `deadline` is null for `mode: "days"` (bounded at 100 workouts by the sidecar, so an
 * unbudgeted loop is fine) and a wall-clock timestamp for `mode: "all"`. The budget is only ever
 * checked *before* starting an export, never mid-export -- an in-flight sidecar call is always
 * allowed to finish, same principle as lib/padi/sync.ts.
 */
async function stageListedWorkouts(
  userId: string,
  sessionJson: string,
  workouts: GarminActivitySummary[],
  deadline: number | null,
): Promise<StageWorkoutsResult> {
  const counts: FetchCounts = {
    // Incremented per iteration, not pre-seeded with workouts.length: a budget-truncated run must
    // report how many workouts were actually examined, not how many were listed.
    checked: 0,
    staged: 0,
    alreadySaved: 0,
    alreadyStaged: 0,
    skippedNonDives: 0,
    failedExports: 0,
  };
  const keyedWorkouts = workouts.flatMap((workout) => {
    const key = activityId(workout);
    return key ? [{ key, workout }] : [];
  });
  const duplicateStatuses = await getGarminDuplicateStatuses(
    userId,
    keyedWorkouts.map(({ key }) => key),
  );

  for (const workout of workouts) {
    counts.checked += 1;
    const key = activityId(workout);
    if (!key) {
      counts.failedExports += 1;
      continue;
    }
    const duplicateStatus = duplicateStatuses.get(key);
    if (duplicateStatus === "already_saved") {
      counts.alreadySaved += 1;
      continue;
    }
    if (duplicateStatus === "already_staged") {
      counts.alreadyStaged += 1;
      continue;
    }

    // This workout is a real candidate that hasn't been exported yet, so stopping here always
    // leaves work behind -- the caller reports `remaining` so the user knows to fetch again.
    if (deadline !== null && Date.now() > deadline) {
      return { ok: true, counts, remaining: true };
    }

    let exported: Awaited<ReturnType<typeof downloadGarminFit>>;
    try {
      exported = await downloadGarminFit(userId, sessionJson, Number(key));
    } catch (error) {
      if (error instanceof GarminSidecarError && error.reason === "auth_expired") {
        await markGarminNeedsReconnect(userId);
        const failure = toUserError(error);
        return { ok: false, ...failure };
      }
      if (error instanceof GarminSidecarError) {
        counts.failedExports += 1;
        continue;
      }
      console.error("Garmin export failed outside sidecar contract", error);
      return { ok: false, error: UNAVAILABLE_ERROR };
    }

    const originalFit = Buffer.from(exported.fitBase64, "base64");
    const fitBuffer = await extractFitFromZip(originalFit);
    const messages = parseFitBuffer(fitBuffer);
    const compiled = compileGarminProfile(key, messages);
    if (!compiled.ok) {
      counts.skippedNonDives += 1; console.warn("Skipped non-dive:", compiled.error);
      continue;
    }

    try {
      const staged = await stageGarminImport(userId, {
        activityId: key,
        activityStartedAt: startedAt(workout, compiled.profile.startedAt),
        summary: workout,
        draftDive: compiled.draftDive,
        compiledProfile: compiled.profile,
        originalFit: Buffer.from(exported.fitBase64, "base64"),
      });

      if (staged.staged) counts.staged += 1;
      else if (staged.reason === "already_saved") counts.alreadySaved += 1;
      else counts.alreadyStaged += 1;
    } catch (error) {
      console.error("Garmin staging failed", error);
      return { ok: false, error: UNAVAILABLE_ERROR };
    }
  }

  return { ok: true, counts, remaining: false };
}

// Shared tail of both fetch modes: stamp the fetch, re-read the pending queue, revalidate.
async function finishFetch(userId: string, staged: { counts: FetchCounts; remaining: boolean }) {
  await markGarminFetched(userId);
  const [pendingCount, pending] = await Promise.all([
    countPendingGarminImports(userId),
    listPendingGarminImports(userId),
  ]);

  revalidateGarminPaths();
  return {
    ok: true as const,
    ...staged.counts,
    remaining: staged.remaining,
    pendingCount,
    nextImportId: pending[0]?.id ?? null,
  };
}

async function listWorkoutsForRequest(
  userId: string,
  sessionJson: string,
  request: FetchGarminRequest,
): Promise<{ ok: true; workouts: GarminActivitySummary[] } | { ok: false; error: string; reason?: string }> {
  try {
    const workouts: GarminActivitySummary[] = [];
    let start = 0;
    const limit = 20;

    const cutoffDate = new Date();
    if (request.mode === "days") {
      const normalizedDaysBack = Number.isFinite(request.daysBack) ? Math.floor(request.daysBack) : 10;
      const boundedDaysBack = Math.max(1, Math.min(365, normalizedDaysBack));
      cutoffDate.setDate(cutoffDate.getDate() - boundedDaysBack);
    } else {
      cutoffDate.setFullYear(2000); // Effectively all
    }

    while (true) {
      const { activities } = await listGarminActivities(userId, sessionJson, { start, limit });
      if (!activities || activities.length === 0) break;

      workouts.push(...activities);

      const lastActivity = activities[activities.length - 1];
      if (lastActivity && lastActivity.startTimeLocal) {
        const activityDate = new Date(lastActivity.startTimeLocal);
        if (activityDate < cutoffDate) break;
      }
      
      start += limit;
      if (start > 1000) break; // Hard limit for safety
    }

    return { ok: true, workouts };
  } catch (error) {
    if (error instanceof GarminSidecarError && error.reason === "auth_expired") {
      await markGarminNeedsReconnect(userId);
    }
    return { ok: false, ...toUserError(error) };
  }
}

export async function fetchGarminActivitiesAction(request: FetchGarminRequest): Promise<FetchGarminActionResult> {
  const user = await requireUser();

  // Server Action arguments are client-controlled, so the discriminant is validated rather than
  // assumed: without this, anything that isn't "days" would fall through to the expensive unbounded
  // all-time path.
  if (request?.mode !== "days" && request?.mode !== "all") {
    return { ok: false, error: "Unsupported fetch mode.", reason: "bad_request" };
  }

  let sessionJson: string | null;
  try {
    sessionJson = await getGarminSessionJson(user.id);
  } catch {
    return { ok: false, error: UNAVAILABLE_ERROR };
  }
  if (!sessionJson) {
    return { ok: false, error: "Connect Garmin before fetching workouts.", reason: "not_connected" };
  }

  if (request.mode === "days") {
    const listed = await listWorkoutsForRequest(user.id, sessionJson, request);
    if (!listed.ok) return listed;

    const staged = await stageListedWorkouts(user.id, sessionJson, listed.workouts, null);
    if (!staged.ok) return staged;
    return finishFetch(user.id, staged);
  }

  // Dedicated, single-use client for the advisory lock -- deliberately not a pooled connection.
  // pg_try_advisory_lock is session-scoped: it lives and dies with this one connection, so closing
  // this client (below, unconditionally) always releases the lock even if the explicit unlock query
  // itself fails. Same shape and rationale as lib/padi/sync.ts's lock.
  const lockClient = new pg.Client({ connectionString: getDatabaseUrl() });
  await lockClient.connect();

  let lockAcquired = false;
  try {
    const lockResult = await lockClient.query<{ pg_try_advisory_lock: boolean }>(
      "select pg_try_advisory_lock($1::int4, $2::int4)",
      [ADVISORY_LOCK_CLASSID, Number(user.id)],
    );
    lockAcquired = lockResult.rows[0]?.pg_try_advisory_lock ?? false;

    if (!lockAcquired) {
      // Scoped wording: the lock only guards mode "all", so a concurrent mode "days" fetch is
      // unaffected and never sees this.
      return { ok: false, error: "An all-time Garmin fetch is already in progress.", reason: "in_progress" };
    }

    // Started before the listing, not after it: the listing alone can run for minutes, and the
    // budget is meant to bound the whole request (and therefore how long this lock is held). If
    // listing already blew it, the staging loop stops at its first real candidate and reports
    // `remaining: true`, which is exactly the "click Fetch again" outcome.
    const deadline = Date.now() + fetchAllBudgetMs();
    const listed = await listWorkoutsForRequest(user.id, sessionJson, request);
    if (!listed.ok) return listed;

    const staged = await stageListedWorkouts(user.id, sessionJson, listed.workouts, deadline);
    if (!staged.ok) return staged;
    return finishFetch(user.id, staged);
  } finally {
    if (lockAcquired) {
      try {
        await lockClient.query("select pg_advisory_unlock($1::int4, $2::int4)", [
          ADVISORY_LOCK_CLASSID,
          Number(user.id),
        ]);
      } catch {
        // Best-effort: the connection closes immediately below regardless, which releases the
        // session-scoped lock either way.
      }
    }
    await lockClient.end();
  }
}

export async function createGarminDiveImportAction(
  importId: number,
  input: DiveInput,
): Promise<SaveGarminImportActionResult> {
  const user = await requireUser();

  try {
    const result = await createDiveFromGarminImport(user, importId, input);
    if (!result.inserted) {
      return {
        ok: false,
        reason: result.reason,
        error:
          result.reason === "already_saved"
            ? "This Garmin workout was already saved. Delete the saved dive before importing it again."
            : "That Garmin import is no longer available.",
      };
    }

    const [pendingCount, pending] = await Promise.all([
      countPendingGarminImports(user.id),
      listPendingGarminImports(user.id),
    ]);
    revalidateGarminPaths(result.dive.id);
    return { ok: true, id: result.dive.id, pendingCount, nextImportId: pending[0]?.id ?? null };
  } catch (error) {
    console.error("Garmin import save failed", error);
    return { ok: false, error: "Something went wrong. Please try again.", reason: "unknown" };
  }
}

export async function mergeGarminDiveImportAction(
  importId: number,
  targetDiveId: number,
  input: DiveInput,
): Promise<SaveGarminImportActionResult> {
  const user = await requireUser();

  try {
    const result = await mergeGarminImportIntoDive(user, importId, targetDiveId, input);
    if (!result.merged) {
      return {
        ok: false,
        reason: result.reason,
        error:
          result.reason === "already_saved"
            ? "This Garmin workout was already saved. Delete the saved dive before importing it again."
            : result.reason === "missing_dive"
              ? "That target dive is no longer available."
              : "That Garmin import is no longer available.",
      };
    }

    const [pendingCount, pending] = await Promise.all([
      countPendingGarminImports(user.id),
      listPendingGarminImports(user.id),
    ]);
    revalidateGarminPaths(result.dive.id);
    return { ok: true, id: result.dive.id, pendingCount, nextImportId: pending[0]?.id ?? null };
  } catch (error) {
    console.error("Garmin import merge failed", error);
    return { ok: false, error: "Something went wrong. Please try again.", reason: "unknown" };
  }
}

export async function deleteGarminImportAction(importId: number): Promise<DeleteGarminImportActionResult> {
  const user = await requireUser();
  const nextBeforeDelete = await getNextPendingGarminImportId(user.id, importId);
  const deleted = await deleteGarminImport(user.id, importId);

  if (!deleted) {
    return { ok: false, error: "That Garmin import is no longer available." };
  }

  const pendingCount = await countPendingGarminImports(user.id);
  const nextImportId =
    nextBeforeDelete ?? (pendingCount > 0 ? (await listPendingGarminImports(user.id))[0]?.id ?? null : null);

  revalidatePath("/settings/integrations");
  revalidatePath(`/settings/integrations/garmin/imports/${importId}`);
  if (nextImportId !== null) revalidatePath(`/settings/integrations/garmin/imports/${nextImportId}`);
  return { ok: true, nextImportId, pendingCount };
}
