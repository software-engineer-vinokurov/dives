import type { Metadata } from "next";
import Link from "next/link";
import { MapPin, Plus, Tag, Timer, UploadCloud, Waves, Wind } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { DiveActivityCalendar } from "@/components/dive-activity-calendar";
import { DiveRadarCharts } from "@/components/dive-radar-charts";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  formatDiveDate,
  formatMeasurement,
  formatMinutes,
  trimNumeric,
} from "@/lib/dive-format";
import { buildDiveRadarStats } from "@/lib/dive-radar-stats";
import { getDiveActivityByDay, getDiveStats, getEarliestDiveDate, listDives } from "@/lib/dives";
import { getPadiIntegrationStatus } from "@/lib/padi/integrations";
import { average, diveSacRate, percentile } from "@/lib/sac-rate";
import { requireUser } from "@/lib/session";
import { getSuuntoIntegrationStatus } from "@/lib/suunto/integrations";
import { getGarminIntegrationStatus } from "@/lib/garmin/integrations";
import { buildTagCloud, effectiveTags, MISSING_PADI_TAG, MISSING_SUUNTO_TAG } from "@/lib/tags";
import { cn } from "@/lib/utils";

// How many of the user's most-used tags show on the dashboard's compact cloud -- the full cloud
// with every tag lives on /dives, which is also where clicking one of these links to filter.
const MAX_DASHBOARD_TAGS = 12;

function tagBadgeVariant(tag: string): "warning" | "outline" {
  return tag === MISSING_PADI_TAG || tag === MISSING_SUUNTO_TAG ? "warning" : "outline";
}

// How far the "All" option in the calendar's year selector can reach -- past this the dropdown
// would grow unreasonably long for what is still a personal logbook.
const MAX_CALENDAR_YEARS = 10;

// A week of slack past the earliest dive, so the Sunday-aligned grid start (which can land a few
// days before the exact earliest-dive date depending on today's weekday) is never short a row.
function activityRange(earliestDive: Date | null) {
  const to = new Date();
  to.setHours(24, 0, 0, 0);
  const from = new Date(earliestDive ?? to);
  from.setDate(from.getDate() - 7);
  return { from, to };
}

// Matches DiveActivityCalendar's own per-calendar-year row count: current year plus each full
// prior year back through the year of the earliest dive.
function maxCalendarYears(earliestDive: Date | null, today: Date): number {
  if (!earliestDive) return 1;
  const years = today.getFullYear() - earliestDive.getFullYear() + 1;
  return Math.min(MAX_CALENDAR_YEARS, Math.max(1, years));
}

// Rounds to 1 decimal like every other measurement here, then drops a trailing ".0" (trimNumeric)
// so a whole-number rate reads as "20", not "20.0", inside the slash-joined summary below.
function formatSacRateValue(value: number | null): string {
  if (value === null) return "—";
  return trimNumeric(Number(value.toFixed(1))) ?? "—";
}

export const metadata: Metadata = {
  title: "Dashboard · Dives",
};

function Stat({
  icon: Icon,
  label,
  value,
  unit,
  testId,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  unit?: string;
  testId: string;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 px-4">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className="size-3.5" />
          {label}
        </span>
        {/* The value carries its own test id so the e2e spec can assert on the number alone,
            without the unit suffix making the assertion brittle. */}
        <span className="text-2xl font-semibold tabular-nums tracking-tight">
          <span data-testid={testId}>{value}</span>
          {unit ? <span className="ml-1 text-sm font-normal text-muted-foreground">{unit}</span> : null}
        </span>
      </CardContent>
    </Card>
  );
}

export default async function DashboardPage() {
  const user = await requireUser("/dashboard");
  const earliestDive = await getEarliestDiveDate(user.id);
  const [stats, dives, activity, padiIntegration, suuntoIntegration, garminIntegration] = await Promise.all([
    getDiveStats(user.id),
    listDives(user.id),
    getDiveActivityByDay(user.id, activityRange(earliestDive)),
    getPadiIntegrationStatus(user.id),
    getSuuntoIntegrationStatus(user.id),
    getGarminIntegrationStatus(user.id),
  ]);
  const recent = dives.slice(0, 5);
  const radarStats = buildDiveRadarStats(dives);
  const allSacRates = dives.map(diveSacRate).filter((rate): rate is number => rate !== null);
  const sacRateP50 = percentile(allSacRates, 50);
  const avgSacRateLast5 = average(
    recent.map(diveSacRate).filter((rate): rate is number => rate !== null),
  );
  const sacRateP90 = percentile(allSacRates, 90);
  const avgSacRateLast5Display = formatSacRateValue(avgSacRateLast5);
  const avgSacRateLast5Unit = avgSacRateLast5 === null ? undefined : "L/min";
  // Typical (median) vs. worst-case tail (90th percentile) -- see PROMPTLOG.md for why a raw
  // average alone was misleading and the last-5 average now has its own separate card.
  const sacRatePercentileValues = [sacRateP50, sacRateP90];
  const sacRatePercentileDisplay = sacRatePercentileValues.every((value) => value === null)
    ? "—"
    : sacRatePercentileValues.map(formatSacRateValue).join("/");
  const sacRatePercentileUnit = sacRatePercentileValues.some((value) => value !== null) ? "L/min" : undefined;
  const maxYears = maxCalendarYears(earliestDive, new Date());
  const connections = {
    padiConnected: padiIntegration?.status === "connected",
    suuntoConnected: suuntoIntegration?.status === "connected",
    garminConnected: garminIntegration?.status === "connected",
  };
  const tagCloud = buildTagCloud(dives, connections).slice(0, MAX_DASHBOARD_TAGS);

  return (
    <AppShell email={user.email}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
            <p className="text-sm text-muted-foreground">Your logbook at a glance.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/dives/new" className={cn(buttonVariants(), "no-underline")}>
              <Plus /> Log a dive
            </Link>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Stat
            icon={Waves}
            label="Total dives"
            value={String(stats.totalDives)}
            testId="stat-total-dives"
          />
          <Stat
            icon={Timer}
            label="Total bottom time"
            value={formatMinutes(stats.totalBottomTimeMinutes) ?? "0m"}
            testId="stat-total-bottom-time"
          />
          <Stat
            icon={MapPin}
            label="Sites visited"
            value={String(stats.distinctSites)}
            testId="stat-distinct-sites"
          />
          <Stat
            icon={Wind}
            label="Avg SAC rate (last 5)"
            value={avgSacRateLast5Display}
            unit={avgSacRateLast5Unit}
            testId="stat-avg-sac-rate"
          />
          <Stat
            icon={Wind}
            label="SAC rate (p50 / p90)"
            value={sacRatePercentileDisplay}
            unit={sacRatePercentileUnit}
            testId="stat-sac-rate-percentiles"
          />
        </div>

        <Card>
          <CardContent className="flex flex-col gap-3 px-4">
            <h2 className="text-sm font-medium">Activity</h2>
            <DiveActivityCalendar activity={activity} maxYears={maxYears} />
          </CardContent>
        </Card>

        {dives.length > 0 ? <DiveRadarCharts stats={radarStats} /> : null}

        {tagCloud.length > 0 ? (
          <Card>
            <CardContent className="flex flex-col gap-3 px-4">
              <h2 className="text-sm font-medium">Tags</h2>
              <div className="flex flex-wrap items-center gap-1.5" data-testid="dashboard-tag-cloud">
                {tagCloud.map(({ tag, count }) => (
                  <Link key={tag} href={`/dives?tag=${encodeURIComponent(tag)}`}>
                    <Badge variant={tagBadgeVariant(tag)} className="cursor-pointer">
                      <Tag className="size-3" aria-hidden />
                      {tag}
                      <span className="text-muted-foreground">{count}</span>
                    </Badge>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        ) : null}

        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-sm font-medium">Recent dives</h2>
            {dives.length > recent.length ? (
              <Link href="/dives" className="text-xs text-muted-foreground hover:text-foreground">
                View all {dives.length}
              </Link>
            ) : null}
          </div>

          {recent.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                Nothing logged yet. Your first dive will show up here.
              </CardContent>
            </Card>
          ) : (
            <ol className="flex flex-col gap-2">
              {recent.map((dive) => (
                <li key={dive.id}>
                  <Link
                    href={`/dives/${dive.id}`}
                    className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-lg border border-border bg-card px-4 py-3 no-underline shadow-sm transition-colors hover:bg-accent/50"
                  >
                    <span className="min-w-0 flex-1 basis-48 truncate font-medium">
                      {dive.title ?? dive.site_name ?? "Unnamed site"}
                      {dive.padi_needs_update ? (
                        <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 align-middle text-xs font-normal text-amber-900 dark:bg-amber-950 dark:text-amber-100">
                          <UploadCloud className="size-3" aria-hidden />
                          PADI update available
                        </span>
                      ) : null}
                      {effectiveTags(dive, connections).map((tag) => (
                        <Badge key={tag} variant={tagBadgeVariant(tag)} className="ml-1 align-middle">
                          {tag}
                        </Badge>
                      ))}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatDiveDate(dive.occurred_at)}
                    </span>
                    <span className="w-16 shrink-0 text-right text-sm tabular-nums">
                      {formatMeasurement(dive.max_depth, "m") ?? "—"}
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </AppShell>
  );
}
