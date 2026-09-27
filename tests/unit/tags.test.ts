import { describe, expect, it } from "vitest";

import { buildTagCloud, effectiveTags, MISSING_PADI_TAG, MISSING_SUUNTO_TAG, MISSING_GARMIN_TAG } from "@/lib/tags";

function dive(overrides: { tags?: string[]; padi_dive_id?: number | null; suunto_workout_key?: string | null; garmin_activity_id?: string | null } = {}) {
  return {
    tags: overrides.tags ?? [],
    padi_dive_id: overrides.padi_dive_id ?? null,
    suunto_workout_key: overrides.suunto_workout_key ?? null,
    garmin_activity_id: overrides.garmin_activity_id ?? null,
  };
}

describe("effectiveTags", () => {
  it("returns only the stored tags when neither integration is connected", () => {
    expect(effectiveTags(dive({ tags: ["wreck"] }), { padiConnected: false, suuntoConnected: false, garminConnected: false })).toEqual([
      "wreck",
    ]);
  });

  it("adds missing-padi only for a PADI-connected user whose dive has no padi_dive_id", () => {
    expect(effectiveTags(dive(), { padiConnected: true, suuntoConnected: false, garminConnected: false })).toEqual([MISSING_PADI_TAG]);
    expect(
      effectiveTags(dive({ padi_dive_id: 42 }), { padiConnected: true, suuntoConnected: false, garminConnected: false }),
    ).toEqual([]);
  });

  it("adds missing-suunto only for a Suunto-connected user whose dive has no suunto_workout_key", () => {
    expect(effectiveTags(dive(), { padiConnected: false, suuntoConnected: true, garminConnected: false })).toEqual([MISSING_SUUNTO_TAG]);
    expect(
      effectiveTags(dive({ suunto_workout_key: "abc" }), { padiConnected: false, suuntoConnected: true, garminConnected: false }),
    ).toEqual([]);
  });


  it("adds missing-garmin only for a Garmin-connected user whose dive has no garmin_activity_id", () => {
    expect(effectiveTags(dive(), { padiConnected: false, suuntoConnected: false, garminConnected: true })).toEqual(["missing-garmin"]);
    expect(
      effectiveTags(dive({ garmin_activity_id: "12345" }), { padiConnected: false, suuntoConnected: false, garminConnected: true }),
    ).toEqual([]);
  });

  it("combines stored tags with both virtual tags", () => {
    expect(effectiveTags(dive({ tags: ["wreck"] }), { padiConnected: true, suuntoConnected: true, garminConnected: true })).toEqual([
      "wreck",
      MISSING_PADI_TAG,
      MISSING_SUUNTO_TAG,
      MISSING_GARMIN_TAG,
    ]);
  });
});

describe("buildTagCloud", () => {
  it("counts real and virtual tags across dives and sorts by count desc, then name asc", () => {
    const dives = [
      dive({ tags: ["wreck"] }),
      dive({ tags: ["wreck", "night-dive"] }),
      dive({ tags: ["shark"] }),
    ];

    expect(buildTagCloud(dives, { padiConnected: false, suuntoConnected: false, garminConnected: false })).toEqual([
      { tag: "wreck", count: 2 },
      { tag: "night-dive", count: 1 },
      { tag: "shark", count: 1 },
    ]);
  });

  it("folds missing-padi/missing-suunto into the same cloud when connected", () => {
    const dives = [dive({ padi_dive_id: null }), dive({ padi_dive_id: 1 })];

    expect(buildTagCloud(dives, { padiConnected: true, suuntoConnected: false, garminConnected: false })).toEqual([
      { tag: MISSING_PADI_TAG, count: 1 },
    ]);
  });
  it("folds missing-garmin into the same cloud when connected", () => {
    const dives = [dive({ garmin_activity_id: null }), dive({ garmin_activity_id: "1" })];

    expect(buildTagCloud(dives, { padiConnected: false, suuntoConnected: false, garminConnected: true })).toEqual([
      { tag: MISSING_GARMIN_TAG, count: 1 },
    ]);
  });
});
