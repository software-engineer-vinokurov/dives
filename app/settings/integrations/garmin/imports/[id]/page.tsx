import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { DeleteGarminImportButton } from "@/components/delete-garmin-import-button";
import { DiveForm } from "@/components/dive-form";
import { GarminProfileChart } from "@/components/garmin-profile-chart";
import { Card, CardContent } from "@/components/ui/card";
import { listGarminMergeDiveCandidates, type GarminMergeDiveCandidate } from "@/lib/dives";
import { trimNumeric } from "@/lib/dive-format";
import {
  getFirstPendingGarminImportId,
  getNextPendingGarminImportId,
  getPendingGarminImport,
} from "@/lib/garmin/imports";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = {
  title: "Review Garmin dive · Dives",
};

function serializeMergeCandidate(dive: GarminMergeDiveCandidate) {
  const text = (value: string | null) => value ?? "";
  // bottomTimeMinutes is an integer column, not numeric(5,2) -- trimNumeric is a no-op for it and
  // correct for every other numeric field here, which pg returns as a fixed-scale string like
  // "24.00" that must be trimmed the same way stateFromDive trims it, or the merge dialog's
  // precision-based preselection would mistake DB padding for genuinely recorded precision.
  const numberText = (value: string | number | null) => trimNumeric(value) ?? "";
  const choice = (value: string | null) => value ?? "__none__";
  const bodyOfWater = dive.body_of_water ?? "__none__";

  return {
    id: dive.id,
    title: dive.title,
    occurredAt: dive.occurred_at.toISOString(),
    maxDepth: dive.max_depth,
    bottomTimeMinutes: dive.bottom_time_minutes,
    siteName: dive.site_name,
    values: {
      title: text(dive.title),
      occurredAt: dive.occurred_at.toISOString().slice(0, 16),
      site: {
        siteId: dive.dive_site_id,
        name: text(dive.site_name),
        location: text(dive.site_location),
        lat: numberText(dive.site_lat),
        lng: numberText(dive.site_lng),
      },
      maxDepth: numberText(dive.max_depth),
      avgDepth: numberText(dive.avg_depth),
      bottomTimeMinutes: numberText(dive.bottom_time_minutes),
      waterTemp: numberText(dive.water_temp),
      waterTempLow: numberText(dive.water_temp_low),
      airTemp: numberText(dive.air_temp),
      visibility: numberText(dive.visibility),
      gasMix: text(dive.gas_mix),
      tankInfo: text(dive.tank_info),
      cylinderSize: numberText(dive.cylinder_size),
      startPressure: numberText(dive.start_pressure),
      endPressure: numberText(dive.end_pressure),
      weight: numberText(dive.weight),
      weightFeedback: choice(dive.weight_feedback),
      suitType: choice(dive.suit_type),
      hood: dive.hood ?? false,
      gloves: dive.gloves ?? false,
      boots: dive.boots ?? false,
      buddy: text(dive.buddy),
      diveShop: text(dive.dive_shop),
      current: choice(dive.current),
      surge: choice(dive.surge),
      waves: choice(dive.waves),
      weather: text(dive.weather),
      waterType: choice(dive.water_type),
      bodyOfWater,
      bodyOfWaterOther: bodyOfWater === "__none__" ? "" : bodyOfWater,
      entryType: choice(dive.entry_type),
      notes: text(dive.notes),
      rating: dive.rating,
      depthProfileRaw: text(dive.depth_profile_raw),
      depthProfile: dive.depth_profile,
      tags: dive.tags,
    },
  };
}

export default async function ReviewGarminImportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const importId = Number(id);
  const user = await requireUser(`/settings/integrations/garmin/imports/${id}`);

  if (!Number.isInteger(importId)) notFound();

  const pending = await getPendingGarminImport(user.id, importId);
  if (!pending || pending.id !== importId) notFound();

  const [mergeCandidates, nextPendingImportId, firstPendingImportId] = await Promise.all([
    listGarminMergeDiveCandidates(user.id, pending.activity_started_at),
    getNextPendingGarminImportId(user.id, pending.id),
    getFirstPendingGarminImportId(user.id),
  ]);
  const cancelImportId = nextPendingImportId ?? (pending.remaining_count > 1 ? firstPendingImportId : null);

  return (
    <AppShell email={user.email}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <Link
            href="/settings/integrations"
            className="flex w-fit items-center gap-1 text-xs text-muted-foreground no-underline hover:text-foreground"
          >
            <ChevronLeft className="size-3.5" aria-hidden /> Integrations
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">Review Garmin dive</h1>
          <p className="text-sm text-muted-foreground">
            {pending.remaining_count} fetched {pending.remaining_count === 1 ? "dive" : "dives"} still in the edit queue.
          </p>
          <DeleteGarminImportButton importId={pending.id} />
        </div>

        <Card className="border-blue-200 bg-blue-50 text-blue-950 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-100">
          <CardContent className="px-4 text-sm">
            Review and edit the imported fields, then save it as a normal dive. This dive will keep
            Garmin activity id <span className="font-mono">{pending.activity_id}</span> and can be
            uploaded to PADI later.
          </CardContent>
        </Card>

        <Card>
          <CardContent className="px-4">
            <GarminProfileChart points={pending.compiled_profile.points} />
          </CardContent>
        </Card>

        <DiveForm
          draftDive={pending.draft_dive}
          garminImportId={pending.id}
          cancelHref={
            cancelImportId === null ? "/settings/integrations" : `/settings/integrations/garmin/imports/${cancelImportId}`
          }
          submitLabel="Save Garmin dive"
          garminMergeCandidates={mergeCandidates.map(serializeMergeCandidate)}
        />
      </div>
    </AppShell>
  );
}
