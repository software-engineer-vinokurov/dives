import { describe, expect, it } from "vitest";

import { buildDiveRadarStats } from "@/lib/dive-radar-stats";
import type { DiveRecord } from "@/lib/dives";

// A minimal, fully-populated dive so each test only needs to override the fields it cares about --
// mirrors the fixture-factory pattern used by tests/unit/merge-fields.test.ts's NONE sentinel, but
// for the wider DiveRecord shape.
function makeDive(overrides: Partial<DiveRecord>): DiveRecord {
  return {
    id: 1,
    title: null,
    occurred_at: new Date("2026-01-15T09:00:00Z"),
    max_depth: null,
    avg_depth: null,
    bottom_time_minutes: null,
    water_temp: null,
    water_temp_low: null,
    air_temp: null,
    visibility: null,
    gas_mix: null,
    tank_info: null,
    cylinder_size: null,
    start_pressure: null,
    end_pressure: null,
    weight: null,
    weight_feedback: null,
    suit_type: null,
    hood: null,
    gloves: null,
    boots: null,
    buddy: null,
    dive_shop: null,
    current: null,
    surge: null,
    waves: null,
    weather: null,
    water_type: null,
    body_of_water: null,
    entry_type: null,
    notes: null,
    rating: null,
    depth_profile: null,
    depth_profile_raw: null,
    created_at: new Date("2026-01-15T09:00:00Z"),
    updated_at: new Date("2026-01-15T09:00:00Z"),
    padi_dive_id: null,
    dive_number: null,
    padi_member_number: null,
    adventure_dive: null,
    dive_type: null,
    log_type: null,
    log_course: null,
    padi_status: null,
    padi_needs_update: false,
    padi_last_compared_at: null,
    suunto_workout_key: null,
    suunto_profile: null,
    garmin_activity_id: null,
    garmin_profile: null,
    tags: [],
    site_name: null,
    site_location: null,
    site_lat: null,
    site_lng: null,
    dive_site_id: null,
    ...overrides,
  };
}

describe("buildDiveRadarStats — seasonality", () => {
  it("returns twelve zeroed months and a domain of [0, 1] when there are no dives", () => {
    const stats = buildDiveRadarStats([]);

    expect(stats.seasonality.divesPerMonth.data).toHaveLength(12);
    expect(stats.seasonality.divesPerMonth.data.every((point) => point.value === 0)).toBe(true);
    expect(stats.seasonality.divesPerMonth.domain).toEqual([0, 1]);
    expect(stats.seasonality.depthPerMonth.data.every((point) => point.value === null)).toBe(true);
  });

  it("buckets dives by calendar month regardless of year", () => {
    const stats = buildDiveRadarStats([
      makeDive({ occurred_at: new Date("2023-03-10T00:00:00Z") }),
      makeDive({ occurred_at: new Date("2026-03-20T00:00:00Z") }),
      makeDive({ occurred_at: new Date("2026-07-01T00:00:00Z") }),
    ]);

    const march = stats.seasonality.divesPerMonth.data.find((point) => point.month === "Mar")!;
    const july = stats.seasonality.divesPerMonth.data.find((point) => point.month === "Jul")!;
    const jan = stats.seasonality.divesPerMonth.data.find((point) => point.month === "Jan")!;

    expect(march.value).toBe(2);
    expect(july.value).toBe(1);
    expect(jan.value).toBe(0);
  });

  it("averages numeric properties per month and adds 10% headroom to the domain max", () => {
    const stats = buildDiveRadarStats([
      makeDive({ occurred_at: new Date("2026-01-05T00:00:00Z"), max_depth: "20" }),
      makeDive({ occurred_at: new Date("2026-01-20T00:00:00Z"), max_depth: "30" }),
    ]);

    const jan = stats.seasonality.depthPerMonth.data.find((point) => point.month === "Jan")!;
    expect(jan.value).toBeCloseTo(25, 5);
  });

  it("normalises the depth-by-month domain to exactly the observed max, unlike every other chart", () => {
    const stats = buildDiveRadarStats([makeDive({ max_depth: "18" }), makeDive({ max_depth: "30" })]);
    expect(stats.seasonality.depthPerMonth.domain).toEqual([0, 30]);
  });

  it("falls back to a [0, 1] depth domain when there are no dives", () => {
    expect(buildDiveRadarStats([]).seasonality.depthPerMonth.domain).toEqual([0, 1]);
  });

  it("scales duration as 5 minutes .. longest dive + 15 minutes, per issue #7", () => {
    const stats = buildDiveRadarStats([
      makeDive({ occurred_at: new Date("2026-05-01T00:00:00Z"), bottom_time_minutes: 45 }),
    ]);

    expect(stats.seasonality.durationPerMonth.domain).toEqual([5, 60]);
  });

  it("floors the duration domain at 5 minutes even with no dives", () => {
    const stats = buildDiveRadarStats([]);
    expect(stats.seasonality.durationPerMonth.domain).toEqual([5, 20]);
  });

  it("reports min/max/avg per month for visibility and SAC rate", () => {
    const stats = buildDiveRadarStats([
      makeDive({ occurred_at: new Date("2026-02-01T00:00:00Z"), visibility: "10" }),
      makeDive({ occurred_at: new Date("2026-02-15T00:00:00Z"), visibility: "20" }),
    ]);

    const feb = stats.seasonality.visibilityPerMonth.data.find((point) => point.month === "Feb")!;
    expect(feb.min).toBe(10);
    expect(feb.max).toBe(20);
    expect(feb.avg).toBeCloseTo(15, 5);

    // Never recorded -- min/max/avg all null, not zeroed.
    const jan = stats.seasonality.visibilityPerMonth.data.find((point) => point.month === "Jan")!;
    expect(jan.min).toBeNull();
    expect(jan.max).toBeNull();
    expect(jan.avg).toBeNull();
  });

  it("computes SAC rate per dive before taking the monthly min/max/avg", () => {
    // 200 -> 50 bar on a 12L cylinder at 18m avg depth for 40 min => 16.0714 L/min (see
    // gas-consumption.test.ts for the same worked example).
    const stats = buildDiveRadarStats([
      makeDive({
        occurred_at: new Date("2026-02-01T00:00:00Z"),
        start_pressure: "200",
        end_pressure: "50",
        cylinder_size: "12",
        avg_depth: "18",
        bottom_time_minutes: 40,
      }),
    ]);

    const feb = stats.seasonality.sacRatePerMonth.data.find((point) => point.month === "Feb")!;
    expect(feb.avg).toBeCloseTo(16.0714, 3);
    expect(feb.min).toBeCloseTo(16.0714, 3);
    expect(feb.max).toBeCloseTo(16.0714, 3);
  });

  it("pairs high and low water temperature series by month", () => {
    const stats = buildDiveRadarStats([
      makeDive({
        occurred_at: new Date("2026-08-01T00:00:00Z"),
        water_temp: "28",
        water_temp_low: "24",
      }),
    ]);

    const aug = stats.seasonality.waterTempPerMonth.data.find((point) => point.month === "Aug")!;
    expect(aug.high).toBe(28);
    expect(aug.low).toBe(24);
    expect(stats.seasonality.waterTempPerMonth.domain).toEqual([0, 28 * 1.1]);
  });

  it("ignores dives that never recorded a given property instead of treating them as zero", () => {
    const stats = buildDiveRadarStats([
      makeDive({ occurred_at: new Date("2026-04-01T00:00:00Z"), max_depth: null }),
      makeDive({ occurred_at: new Date("2026-04-02T00:00:00Z"), max_depth: "18" }),
    ]);

    const apr = stats.seasonality.depthPerMonth.data.find((point) => point.month === "Apr")!;
    expect(apr.value).toBe(18);
  });
});

describe("buildDiveRadarStats — distributions", () => {
  it("buckets depth into 5m steps, labelled by each bucket's lower bound", () => {
    const stats = buildDiveRadarStats([
      makeDive({ max_depth: "3" }),
      makeDive({ max_depth: "12" }),
      makeDive({ max_depth: "14" }),
      makeDive({ max_depth: "31" }),
    ]);

    const byBucket = Object.fromEntries(stats.distributions.depth.data.map((p) => [p.bucket, p.count]));
    expect(byBucket["0"]).toBe(1); // 3m
    expect(byBucket["10"]).toBe(2); // 12m, 14m
    expect(byBucket["30"]).toBe(1); // 31m
    // Highest bucket is the one containing the largest value -- no empty trailing buckets.
    expect(Math.max(...stats.distributions.depth.data.map((p) => Number(p.bucket)))).toBe(30);
  });

  it("buckets duration into 5-minute steps (2x finer than the original 10min step)", () => {
    const stats = buildDiveRadarStats([makeDive({ bottom_time_minutes: 25 }), makeDive({ bottom_time_minutes: 27 })]);
    const byBucket = Object.fromEntries(stats.distributions.duration.data.map((p) => [p.bucket, p.count]));
    expect(byBucket["25"]).toBe(2);
  });

  it("buckets visibility into 2.5m steps (2x finer than the original 5m step)", () => {
    const stats = buildDiveRadarStats([makeDive({ visibility: "6" }), makeDive({ visibility: "7" })]);
    const byBucket = Object.fromEntries(stats.distributions.visibility.data.map((p) => [p.bucket, p.count]));
    // Both fall in [5, 7.5) -> the bucket labelled "5".
    expect(byBucket["5"]).toBe(2);
  });

  it("returns a single zeroed bucket when no dives have the property recorded", () => {
    const stats = buildDiveRadarStats([makeDive({})]);
    expect(stats.distributions.depth.data).toEqual([{ bucket: "0", count: 0 }]);
    expect(stats.distributions.depth.domain).toEqual([0, 1]);
  });

  it("counts SAC rate distribution in 5/3 L/min steps (3x finer than the original 5 L/min step)", () => {
    const stats = buildDiveRadarStats([
      makeDive({
        start_pressure: "200",
        end_pressure: "50",
        cylinder_size: "12",
        avg_depth: "18",
        bottom_time_minutes: 40,
      }),
    ]);

    // 16.0714 L/min / (5/3) = 9.64 -> bucket index 9 -> label 9 * 5/3 = 15.
    const byBucket = Object.fromEntries(stats.distributions.sacRate.data.map((p) => [p.bucket, p.count]));
    expect(byBucket["15"]).toBe(1);
  });

  it("formats fractional bucket labels as clean decimals, not floating-point tails", () => {
    const stats = buildDiveRadarStats([
      makeDive({
        start_pressure: "200",
        end_pressure: "40",
        cylinder_size: "12",
        avg_depth: "10",
        bottom_time_minutes: 30,
      }),
    ]);

    // index * (5/3) produces tails like 3.3333333333333335 without formatBucketLabel's rounding.
    for (const point of stats.distributions.sacRate.data) {
      expect(point.bucket).toMatch(/^\d+(\.\d{1,2})?$/);
    }
  });

  it("plots current/surge/waves as three series on one intensity-level radar", () => {
    const stats = buildDiveRadarStats([
      makeDive({ current: "Strong", surge: "None", waves: "Mild" }),
      makeDive({ current: "Strong", surge: "Moderate", waves: null }),
    ]);

    const byLevel = Object.fromEntries(stats.distributions.conditions.data.map((p) => [p.level, p]));
    expect(byLevel["Strong"].current).toBe(2);
    expect(byLevel["None"].current).toBe(0);
    expect(byLevel["None"].surge).toBe(1);
    expect(byLevel["Moderate"].surge).toBe(1);
    // The dive with waves: null is excluded entirely, not folded into "None".
    expect(byLevel["Mild"].waves).toBe(1);
    expect(byLevel["None"].waves).toBe(0);
  });

  it("always reports all four intensity levels even when none were recorded", () => {
    const stats = buildDiveRadarStats([makeDive({})]);
    expect(stats.distributions.conditions.data.map((p) => p.level)).toEqual(["None", "Mild", "Moderate", "Strong"]);
    expect(stats.distributions.conditions.data.every((p) => p.current === 0 && p.surge === 0 && p.waves === 0)).toBe(
      true,
    );
    expect(stats.distributions.conditions.domain).toEqual([0, 1]);
  });
});
