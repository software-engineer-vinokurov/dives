import { describe, expect, it } from "vitest";

import type { DiveRecord } from "@/lib/dives";
import { mapDiveToPadiCreateInput, mapDiveToPadiUpdatePayload, padiCreateValidationError } from "@/lib/padi/create";

const baseDive: DiveRecord = {
  id: 42,
  title: "First time at TODI",
  occurred_at: new Date("2026-03-03T10:30:00.000Z"),
  max_depth: "8.4",
  avg_depth: "5.1",
  bottom_time_minutes: 54,
  water_temp: "24",
  water_temp_low: "24",
  air_temp: "24",
  visibility: "20",
  gas_mix: "Air",
  tank_info: "Steel",
  cylinder_size: "10",
  start_pressure: "189",
  end_pressure: "55",
  weight: "6",
  weight_feedback: "Perfect",
  suit_type: "Wetsuit 7mm",
  hood: true,
  gloves: false,
  boots: true,
  buddy: "Akim",
  dive_shop: null,
  current: "None",
  surge: "Mild",
  waves: "None",
  weather: "Partly Cloudy",
  water_type: "Fresh",
  body_of_water: "Other",
  entry_type: "Shore",
  notes: null,
  rating: 4,
  depth_profile: null,
  depth_profile_raw: null,
  created_at: new Date("2026-03-03T09:00:00.000Z"),
  updated_at: new Date("2026-03-03T09:00:00.000Z"),
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
  site_name: "TODI",
  site_location: "Beringen, Belgium",
  site_lat: 51.047,
  site_lng: 5.219,
  dive_site_id: 7,
};

describe("mapDiveToPadiCreateInput", () => {
  it("builds the PADI create payload from a local dive using the scratch request shape", () => {
    const result = mapDiveToPadiCreateInput(baseDive, "29837190", new Date("2026-09-05T13:17:42.123Z"));

    expect(result).toMatchObject({
      affiliate_id: "29837190",
      log_type: "Recreational",
      log_course: null,
      log_number: null,
      created_date: "2026-09-05T13:17:42",
      update_date: "2026-09-05T13:17:42",
      dive_type: "BeachShore",
      dive_title: "First time at TODI",
      dive_location: "TODI",
      dive_date: "03/03/2026",
      status: "Publish",
      depth_times: { data: { bottom_time: "54", max_depth: "8.4" } },
      conditions: {
        data: {
          water_type: "Fresh",
          body_of_water: "Other",
          weather: "Partly Cloudy",
          air_temp: "24.000",
          surface_water_temp: "24.000",
          bottom_water_temp: "24.000",
          visibility: "High",
          visibility_distance: "20.000",
          wave_condition: "NoWaves",
          current: "NoCurrent",
          surge: "SomeSurge",
        },
      },
      equipment: {
        data: {
          starting_pressure: "189",
          ending_pressure: "55",
          suit_type: "FullSuit_7mm",
          weight: "6",
          weight_type: "Good",
          additional_equipment: "{Hood,Boots}",
          cylinder_type: "Steel",
          cylinder_size: "10",
          gas_mixture: "Air",
          oxygen: "21",
          nitrogen: "79",
          helium: "0",
        },
      },
      experiences: { data: { feeling: "Good", notes: null, buddies: "Akim", dive_center: null } },
    });
  });

  it("maps visibility distance into PADI's observed Low/Average/High visibility enum", () => {
    expect(
      mapDiveToPadiCreateInput(
        { ...baseDive, visibility: "5" },
        "29837190",
        new Date("2026-09-05T13:17:42.000Z"),
      ),
    ).toMatchObject({ conditions: { data: { visibility: "Low", visibility_distance: "5.000" } } });

    expect(
      mapDiveToPadiCreateInput(
        { ...baseDive, visibility: "8" },
        "29837190",
        new Date("2026-09-05T13:17:42.000Z"),
      ),
    ).toMatchObject({ conditions: { data: { visibility: "Average", visibility_distance: "8.000" } } });

    expect(
      mapDiveToPadiCreateInput(
        { ...baseDive, visibility: "20" },
        "29837190",
        new Date("2026-09-05T13:17:42.000Z"),
      ),
    ).toMatchObject({ conditions: { data: { visibility: "High", visibility_distance: "20.000" } } });
  });

  it("builds the captured PADI recreational update payload using numbers for set inputs", () => {
    const result = mapDiveToPadiUpdatePayload(
      {
        ...baseDive,
        padi_dive_id: 22238544,
        padi_member_number: 0,
        log_type: "Recreational",
        padi_status: "Publish",
        visibility: "8",
      },
      "29837190",
      new Date("2026-09-05T13:24:20.123Z"),
    );

    expect(result).toMatchObject({
      id: 22238544,
      general: {
        affiliate_id: "29837190",
        log_type: "Recreational",
        log_course: null,
        update_date: "2026-09-05T13:24:20",
        dive_type: "BeachShore",
        dive_title: "First time at TODI",
        dive_location: "TODI",
        dive_date: "03/03/2026",
        status: "Publish",
        memsys_member_number: 0,
        adventure_dive: null,
      },
      depthTime: { bottom_time: 54, max_depth: 8.4 },
      conditions: { visibility: "Average", visibility_distance: 8 },
      equipment: {
        starting_pressure: 189,
        ending_pressure: 55,
        cylinder_type: "Steel",
        cylinder_size: 10,
        gas_mixture: "Air",
        oxygen: 21,
        nitrogen: 79,
        helium: 0,
      },
      experience: { feeling: "Good", buddies: "Akim" },
    });
  });

  it("maps nitrox gas and blank optional strings without guessing missing numeric values", () => {
    const result = mapDiveToPadiCreateInput(
      {
        ...baseDive,
        gas_mix: "EAN32",
        title: "   ",
        site_name: "  Blue Hole  ",
        visibility: null,
        hood: false,
        boots: false,
        rating: null,
      },
      29837190,
      new Date("2026-09-05T13:17:42.000Z"),
    );

    expect(result).toMatchObject({
      affiliate_id: "29837190",
      dive_title: null,
      dive_location: "Blue Hole",
      conditions: { data: { visibility: null, visibility_distance: null } },
      equipment: {
        data: {
          additional_equipment: null,
          gas_mixture: "Nitrox",
          oxygen: "32",
          nitrogen: "68",
          helium: "0",
        },
      },
      experiences: { data: { feeling: null } },
    });
  });
  it("maps custom cylinder descriptions to PADI cylinder enums and derived size", () => {
    const result = mapDiveToPadiCreateInput(
      {
        ...baseDive,
        tank_info: "2x7L, Steel 232bar",
        cylinder_size: null,
      },
      "29837190",
      new Date("2026-09-05T13:17:42.000Z"),
    );

    expect(result).toMatchObject({
      equipment: { data: { cylinder_type: "Steel", cylinder_size: "14" } },
    });
  });

  it("uses the size fallback for material-only PADI cylinder enums", () => {
    expect(
      mapDiveToPadiCreateInput(
        { ...baseDive, tank_info: "Custom twinset", cylinder_size: "14" },
        "29837190",
        new Date("2026-09-05T13:17:42.000Z"),
      ),
    ).toMatchObject({ equipment: { data: { cylinder_type: "Steel", cylinder_size: "14" } } });

    expect(
      mapDiveToPadiCreateInput(
        { ...baseDive, tank_info: "AL80", cylinder_size: "11.1" },
        "29837190",
        new Date("2026-09-05T13:17:42.000Z"),
      ),
    ).toMatchObject({ equipment: { data: { cylinder_type: "Aluminum", cylinder_size: "11.1" } } });
  });

  it("turns user-fixable PADI enum errors into UI-safe action text", () => {
    expect(
      padiCreateValidationError({
        errors: [{ message: 'invalid input value for enum cylinder: "2x7L, Steel 232bar"' }],
      }),
    ).toBe(
      `PADI rejected one of this dive's field values: invalid input value for enum cylinder: "2x7L, Steel 232bar". Edit the dive and try again.`,
    );

    expect(padiCreateValidationError({ errors: [{ message: "internal execution error" }] })).toBeNull();
  });

});
