import { describe, expect, it } from "vitest";

import type { DiveRecord } from "@/lib/dives";
import { average, diveSacRate, percentile } from "@/lib/sac-rate";

// A minimal, fully-populated dive so each test only needs to override the fields it cares about --
// mirrors the fixture pattern in tests/unit/dive-radar-stats.test.ts.
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

describe("diveSacRate", () => {
  it("computes the same SAC rate as computeGasConsumption from a dive's own fields", () => {
    const dive = makeDive({
      start_pressure: "200",
      end_pressure: "50",
      cylinder_size: "12",
      avg_depth: "18",
      bottom_time_minutes: 40,
    });

    expect(diveSacRate(dive)).toBeCloseTo(16.0714, 3);
  });

  it("returns null when a required field is missing", () => {
    const dive = makeDive({ start_pressure: "200", end_pressure: "50" });

    expect(diveSacRate(dive)).toBeNull();
  });
});

describe("average", () => {
  it("returns null for an empty array", () => {
    expect(average([])).toBeNull();
  });

  it("returns the arithmetic mean", () => {
    expect(average([10, 20, 30])).toBe(20);
  });
});

describe("percentile", () => {
  it("returns null for an empty array", () => {
    expect(percentile([], 90)).toBeNull();
  });

  it("returns the single value for a one-element array regardless of p", () => {
    expect(percentile([42], 90)).toBe(42);
  });

  it("returns the min/max at p0/p100", () => {
    const values = [5, 1, 4, 2, 3];
    expect(percentile(values, 0)).toBe(1);
    expect(percentile(values, 100)).toBe(5);
  });

  it("linearly interpolates between ranks (numpy-default behavior)", () => {
    // Sorted: [1, 2, 3, 4]. p90 rank = 0.9 * 3 = 2.7 -> interpolate between index 2 (3) and 3 (4).
    expect(percentile([4, 1, 3, 2], 90)).toBeCloseTo(3.7, 5);
    // p50 of an even-length array falls exactly between the two middle values.
    expect(percentile([4, 1, 3, 2], 50)).toBeCloseTo(2.5, 5);
  });
});
