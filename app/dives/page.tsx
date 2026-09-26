import type { Metadata } from "next";
import Link from "next/link";
import { Plus, Star, Tag, UploadCloud, Waves, X } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { FetchSuuntoButton, type SuuntoFetchStatus } from "@/components/fetch-suunto-button";
import { FetchGarminButton, type GarminFetchStatus } from "@/components/fetch-garmin-button";
import { SyncPadiButton, type PadiSyncStatus } from "@/components/sync-padi-button";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  formatDiveDate,
  formatDiveTime,
  formatMeasurement,
  formatMinutes,
} from "@/lib/dive-format";
import { listDives } from "@/lib/dives";
import { getPadiIntegrationStatus } from "@/lib/padi/integrations";
import { requireUser } from "@/lib/session";
import { getSuuntoIntegrationStatus } from "@/lib/suunto/integrations";
import { getGarminIntegrationStatus } from "@/lib/garmin/integrations";
import { buildTagCloud, effectiveTags, MISSING_PADI_TAG, MISSING_SUUNTO_TAG } from "@/lib/tags";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Logbook · Dives",
};

function tagBadgeVariant(tag: string): "warning" | "outline" {
  return tag === MISSING_PADI_TAG || tag === MISSING_SUUNTO_TAG ? "warning" : "outline";
}

function Rating({ value }: { value: number | null }) {
  if (value === null) return null;

  return (
    <span className="flex items-center gap-0.5" aria-label={`Rated ${value} out of 5`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          aria-hidden
          className={cn(
            "size-3.5",
            star <= value ? "fill-foreground text-foreground" : "text-muted-foreground/40",
          )}
        />
      ))}
    </span>
  );
}

export default async function DivesPage({
  searchParams,
}: {
  searchParams?: Promise<{ tag?: string | string[] }>;
}) {
  // requireUser redirects unauthenticated visitors to `/?next=/dives` before any query runs, so a
  // logged-out request never reaches listDives and never renders dive data.
  const user = await requireUser("/dives");
  const params = await searchParams;
  const activeTag = Array.isArray(params?.tag) ? params.tag[0] : params?.tag;

  const [dives, padiIntegration, suuntoIntegration, garminIntegration] = await Promise.all([
    listDives(user.id),
    getPadiIntegrationStatus(user.id),
    getSuuntoIntegrationStatus(user.id),
    getGarminIntegrationStatus(user.id),
  ]);
  const connections = {
    padiConnected: padiIntegration?.status === "connected",
    suuntoConnected: suuntoIntegration?.status === "connected",
    garminConnected: garminIntegration?.status === "connected",
  };
  const padiSyncStatus: PadiSyncStatus = padiIntegration ? padiIntegration.status : "not_connected";
  const suuntoFetchStatus: SuuntoFetchStatus = suuntoIntegration ? suuntoIntegration.status : "not_connected";
  const garminFetchStatus: GarminFetchStatus = garminIntegration ? garminIntegration.status : "not_connected";
  const tagCloud = buildTagCloud(dives, connections);

  // Dive numbers (#1, #2, ...) count from the oldest dive across the whole logbook, so filtering
  // by tag must not renumber them -- the original index survives the filter alongside each dive.
  const numbered = dives.map((dive, index) => ({ dive, number: dives.length - index }));
  const visible = activeTag
    ? numbered.filter(({ dive }) => effectiveTags(dive, connections).includes(activeTag))
    : numbered;

  return (
    <AppShell email={user.email}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight">Logbook</h1>
            <p className="text-sm text-muted-foreground">
              {dives.length === 0
                ? "No dives logged yet."
                : `${dives.length} ${dives.length === 1 ? "dive" : "dives"}, most recent first.`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <SyncPadiButton status={padiSyncStatus} />
            <FetchSuuntoButton status={suuntoFetchStatus} />
            <FetchGarminButton status={garminFetchStatus} />
            <Link href="/dives/new" className={cn(buttonVariants(), "no-underline")}>
              <Plus /> Log a dive
            </Link>
          </div>
        </div>

        {tagCloud.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5" data-testid="tag-cloud">
            {tagCloud.map(({ tag, count }) => (
              <Link key={tag} href={activeTag === tag ? "/dives" : `/dives?tag=${encodeURIComponent(tag)}`}>
                <Badge
                  variant={activeTag === tag ? "default" : tagBadgeVariant(tag)}
                  className={cn(
                    "cursor-pointer",
                    activeTag === tag && "ring-2 ring-ring/50",
                  )}
                >
                  <Tag className="size-3" aria-hidden />
                  {tag}
                  <span className="text-muted-foreground">{count}</span>
                  {activeTag === tag ? <X className="size-3" aria-hidden /> : null}
                </Badge>
              </Link>
            ))}
          </div>
        ) : null}

        {dives.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
              <Waves className="size-8 text-muted-foreground" aria-hidden />
              <p className="text-sm text-muted-foreground">
                Your logbook is empty. Log your first dive to start building it.
              </p>
              <Link
                href="/dives/new"
                className={cn(buttonVariants({ variant: "outline" }), "no-underline")}
              >
                <Plus /> Log a dive
              </Link>
            </CardContent>
          </Card>
        ) : visible.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
              <Tag className="size-8 text-muted-foreground" aria-hidden />
              <p className="text-sm text-muted-foreground">No dives tagged &ldquo;{activeTag}&rdquo;.</p>
              <Link href="/dives" className={cn(buttonVariants({ variant: "outline" }), "no-underline")}>
                Clear filter
              </Link>
            </CardContent>
          </Card>
        ) : (
          <ol data-testid="dive-list" className="flex flex-col gap-2">
            {visible.map(({ dive, number }) => (
              <li key={dive.id}>
                <Link
                  href={`/dives/${dive.id}`}
                  className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-lg border border-border bg-card px-4 py-3 no-underline shadow-sm transition-colors hover:bg-accent/50"
                >
                  {/* Dive numbers count up from the oldest dive, the way a paper logbook does, so
                      the newest entry carries the highest number even though it is listed first. */}
                  <span className="w-10 shrink-0 text-xs tabular-nums text-muted-foreground">
                    #{number}
                  </span>

                  <span className="min-w-0 flex-1 basis-48">
                    <span className="block truncate font-medium">
                      {dive.title ?? dive.site_name ?? "Unnamed site"}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {formatDiveDate(dive.occurred_at)} · {formatDiveTime(dive.occurred_at)}
                      {dive.title && dive.site_name ? ` · ${dive.site_name}` : ""}
                      {dive.site_location ? ` · ${dive.site_location}` : ""}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-1">
                      {dive.padi_needs_update ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
                          <UploadCloud className="size-3" aria-hidden />
                          PADI update available
                        </span>
                      ) : null}
                      {effectiveTags(dive, connections).map((tag) => (
                        <Badge key={tag} variant={tagBadgeVariant(tag)}>
                          {tag}
                        </Badge>
                      ))}
                    </span>
                  </span>

                  <span className="w-16 shrink-0 text-right text-sm tabular-nums">
                    {formatMeasurement(dive.max_depth, "m") ?? "—"}
                  </span>
                  <span className="w-16 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
                    {formatMinutes(dive.bottom_time_minutes) ?? "—"}
                  </span>
                  <span className="w-20 shrink-0">
                    <Rating value={dive.rating} />
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </div>
    </AppShell>
  );
}
