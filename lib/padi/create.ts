import "server-only";

import { getPool } from "@/lib/db";
import type { DiveOwner, DiveRecord } from "@/lib/dives";
import { DiveNotFoundError } from "@/lib/dives";
import { getPadiCredentials } from "./auth";
import { createLogbookDive as defaultCreateLogbookDive, PadiApiError } from "./client";
import {
  PADI_CURRENT_BY_APP_INTENSITY,
  PADI_SUIT_BY_APP_SUIT,
  PADI_SURGE_BY_APP_INTENSITY,
  PADI_WAVES_BY_APP_INTENSITY,
  PADI_WEIGHT_BY_APP_WEIGHT,
  mapWeatherToPadi,
} from "./enum-map";

export type CreatePadiDiveResult =
  | { ok: true; padiDiveId: number }
  | {
      ok: false;
      error: string;
      reason: "not_connected" | "already_linked" | "reconnect_required" | "validation" | "infrastructure";
    };

type PadiCreateClient = {
  createLogbookDive: typeof defaultCreateLogbookDive;
};

const defaultClient: PadiCreateClient = { createLogbookDive: defaultCreateLogbookDive };

const VISIBILITY_BY_DISTANCE = [
  { max: 5, value: "Low" },
  { max: 15, value: "Average" },
  { max: Infinity, value: "High" },
] as const;

type PadiUpdateSection = Record<string, string | number | boolean | null>;

export type PadiUpdatePayload = {
  id: number;
  general: PadiUpdateSection;
  depthTime: PadiUpdateSection;
  conditions: PadiUpdateSection;
  equipment: PadiUpdateSection;
  experience: PadiUpdateSection;
};

const PADI_DIVE_TYPE_BY_ENTRY_TYPE: Record<string, string> = {
  Shore: "BeachShore",
  "Pier / jetty": "BeachShore",
  Boat: "Boat",
  Liveaboard: "Boat",
  Drift: "Boat",
};

const PADI_FEELING_BY_RATING: Record<number, string> = {
  1: "Poor",
  2: "Average",
  3: "Average",
  4: "Good",
  5: "Amazing",
};

function trimString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function toNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPadiNumberString(value: string | number | null, fractionDigits?: number): string | null {
  const parsed = toNumber(value);
  if (parsed === null) return null;
  return fractionDigits === undefined ? String(parsed) : parsed.toFixed(fractionDigits);
}

function toPadiNumber(value: string | number | null): number | null {
  return toNumber(value);
}

function parseCylinderLiters(tankInfo: string | null): number | null {
  const normalized = tankInfo?.replace(/,/g, ".");
  if (!normalized) return null;

  const twinset = normalized.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*l/i);
  if (twinset) {
    const count = Number(twinset[1]);
    const liters = Number(twinset[2]);
    return Number.isFinite(count) && Number.isFinite(liters) ? count * liters : null;
  }

  const single = normalized.match(/(\d+(?:\.\d+)?)\s*l/i);
  if (single) {
    const liters = Number(single[1]);
    return Number.isFinite(liters) ? liters : null;
  }

  return null;
}

function mapCylinderSize(dive: Pick<DiveRecord, "cylinder_size" | "tank_info">): string | null {
  return toPadiNumberString(dive.cylinder_size) ?? toPadiNumberString(parseCylinderLiters(dive.tank_info));
}

function mapCylinderType(dive: Pick<DiveRecord, "cylinder_size" | "tank_info">): string | null {
  const info = dive.tank_info?.toLowerCase() ?? "";
  if (/\b(?:aluminium|aluminum|alu)\b/.test(info)) return "Aluminum";
  if (/\bsteel\b/.test(info)) return "Steel";

  const size = toNumber(dive.cylinder_size) ?? parseCylinderLiters(dive.tank_info);
  if (size === null) return null;

  // PADI's `cylinder_type` is an enum, not the app's free-form cylinder description. For common
  // metric cylinders this app records only size, and the observed PADI enum values are material
  // names (`Steel`/`Aluminum`). Prefer the common European steel default for metric sizes; keep the
  // AL80-ish 11.1L/11L case as Aluminum. Users can still make the mapping explicit by typing
  // "aluminum"/"steel" in the free-form cylinder field.
  return size >= 10.8 && size <= 11.5 ? "Aluminum" : "Steel";
}

function formatPadiDate(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${month}/${day}/${date.getUTCFullYear()}`;
}

function formatPadiTimestamp(date = new Date()): string {
  return date.toISOString().slice(0, 19);
}

function mapVisibility(distance: string | null): string | null {
  const meters = toNumber(distance);
  if (meters === null) return null;
  return VISIBILITY_BY_DISTANCE.find((entry) => meters <= entry.max)?.value ?? null;
}

function mapAdditionalEquipment(dive: Pick<DiveRecord, "hood" | "gloves" | "boots">): string | null {
  const values = [dive.hood ? "Hood" : null, dive.gloves ? "Gloves" : null, dive.boots ? "Boots" : null].filter(
    (value): value is string => value !== null,
  );
  return values.length > 0 ? `{${values.join(",")}}` : null;
}

function parseGas(gasMix: string | null): { mixture: string | null; oxygen: string | null; nitrogen: string | null; helium: string | null } {
  const normalized = gasMix?.trim();
  if (!normalized) return { mixture: null, oxygen: null, nitrogen: null, helium: null };
  if (/^air$/i.test(normalized)) return { mixture: "Air", oxygen: "21", nitrogen: "79", helium: "0" };

  const ean = normalized.match(/^EAN\s*(\d{1,2})$/i) ?? normalized.match(/^(\d{1,2})%?\s*(?:O2|oxygen)$/i);
  if (ean) {
    const oxygen = Number(ean[1]);
    if (oxygen > 0 && oxygen < 100) {
      return { mixture: "Nitrox", oxygen: String(oxygen), nitrogen: String(100 - oxygen), helium: "0" };
    }
  }

  return { mixture: normalized, oxygen: null, nitrogen: null, helium: null };
}

export function mapDiveToPadiCreateInput(dive: DiveRecord, affiliateId: string | number, now = new Date()) {
  const timestamp = formatPadiTimestamp(now);
  const gas = parseGas(dive.gas_mix);

  return {
    affiliate_id: String(affiliateId),
    log_type: "Recreational",
    log_course: null,
    log_number: null,
    created_date: timestamp,
    update_date: timestamp,
    dive_type: dive.entry_type ? (PADI_DIVE_TYPE_BY_ENTRY_TYPE[dive.entry_type] ?? dive.entry_type) : null,
    dive_title: trimString(dive.title),
    dive_location: trimString(dive.site_name),
    dive_date: formatPadiDate(dive.occurred_at),
    status: "Publish",
    depth_times: {
      data: {
        bottom_time: toPadiNumberString(dive.bottom_time_minutes),
        max_depth: toPadiNumberString(dive.max_depth),
      },
    },
    conditions: {
      data: {
        water_type: trimString(dive.water_type),
        body_of_water: trimString(dive.body_of_water) ?? "Other",
        weather: mapWeatherToPadi(dive.weather),
        air_temp: toPadiNumberString(dive.air_temp, 3),
        surface_water_temp: toPadiNumberString(dive.water_temp, 3),
        bottom_water_temp: toPadiNumberString(dive.water_temp_low, 3),
        visibility: mapVisibility(dive.visibility),
        visibility_distance: toPadiNumberString(dive.visibility, 3),
        wave_condition: dive.waves ? (PADI_WAVES_BY_APP_INTENSITY[dive.waves] ?? dive.waves) : null,
        current: dive.current ? (PADI_CURRENT_BY_APP_INTENSITY[dive.current] ?? dive.current) : null,
        surge: dive.surge ? (PADI_SURGE_BY_APP_INTENSITY[dive.surge] ?? dive.surge) : null,
      },
    },
    equipment: {
      data: {
        starting_pressure: toPadiNumberString(dive.start_pressure),
        ending_pressure: toPadiNumberString(dive.end_pressure),
        suit_type: dive.suit_type ? (PADI_SUIT_BY_APP_SUIT[dive.suit_type] ?? dive.suit_type) : null,
        weight: toPadiNumberString(dive.weight),
        weight_type: dive.weight_feedback ? (PADI_WEIGHT_BY_APP_WEIGHT[dive.weight_feedback] ?? dive.weight_feedback) : null,
        additional_equipment: mapAdditionalEquipment(dive),
        cylinder_type: mapCylinderType(dive),
        cylinder_size: mapCylinderSize(dive),
        gas_mixture: gas.mixture,
        oxygen: gas.oxygen,
        nitrogen: gas.nitrogen,
        helium: gas.helium,
      },
    },
    experiences: {
      data: {
        feeling: dive.rating === null ? null : (PADI_FEELING_BY_RATING[dive.rating] ?? null),
        notes: trimString(dive.notes),
        buddies: trimString(dive.buddy),
        dive_center: trimString(dive.dive_shop),
      },
    },
  };
}

export function mapDiveToPadiUpdatePayload(
  dive: DiveRecord,
  affiliateId: string | number,
  now = new Date(),
): PadiUpdatePayload | null {
  if (dive.padi_dive_id === null) return null;

  const gas = parseGas(dive.gas_mix);

  return {
    id: dive.padi_dive_id,
    general: {
      affiliate_id: String(affiliateId),
      log_type: "Recreational",
      log_course: null,
      log_number: dive.dive_number,
      update_date: formatPadiTimestamp(now),
      dive_type: dive.entry_type ? (PADI_DIVE_TYPE_BY_ENTRY_TYPE[dive.entry_type] ?? dive.entry_type) : null,
      dive_title: trimString(dive.title),
      dive_location: trimString(dive.site_name),
      dive_date: formatPadiDate(dive.occurred_at),
      status: dive.padi_status ?? "Publish",
      memsys_member_number: dive.padi_member_number,
      adventure_dive: dive.adventure_dive ? true : null,
    },
    depthTime: {
      bottom_time: dive.bottom_time_minutes,
      max_depth: toPadiNumber(dive.max_depth),
    },
    conditions: {
      water_type: trimString(dive.water_type),
      body_of_water: trimString(dive.body_of_water) ?? "Other",
      weather: mapWeatherToPadi(dive.weather),
      air_temp: toPadiNumber(dive.air_temp),
      surface_water_temp: toPadiNumber(dive.water_temp),
      bottom_water_temp: toPadiNumber(dive.water_temp_low),
      visibility: mapVisibility(dive.visibility),
      visibility_distance: toPadiNumber(dive.visibility),
      wave_condition: dive.waves ? (PADI_WAVES_BY_APP_INTENSITY[dive.waves] ?? dive.waves) : null,
      current: dive.current ? (PADI_CURRENT_BY_APP_INTENSITY[dive.current] ?? dive.current) : null,
      surge: dive.surge ? (PADI_SURGE_BY_APP_INTENSITY[dive.surge] ?? dive.surge) : null,
    },
    equipment: {
      starting_pressure: toPadiNumber(dive.start_pressure),
      ending_pressure: toPadiNumber(dive.end_pressure),
      suit_type: dive.suit_type ? (PADI_SUIT_BY_APP_SUIT[dive.suit_type] ?? dive.suit_type) : null,
      weight: toPadiNumber(dive.weight),
      weight_type: dive.weight_feedback ? (PADI_WEIGHT_BY_APP_WEIGHT[dive.weight_feedback] ?? dive.weight_feedback) : null,
      additional_equipment: mapAdditionalEquipment(dive),
      cylinder_type: mapCylinderType(dive),
      cylinder_size: toPadiNumber(mapCylinderSize(dive)),
      gas_mixture: gas.mixture,
      oxygen: toPadiNumber(gas.oxygen),
      nitrogen: toPadiNumber(gas.nitrogen),
      helium: toPadiNumber(gas.helium),
    },
    experience: {
      feeling: dive.rating === null ? null : (PADI_FEELING_BY_RATING[dive.rating] ?? null),
      notes: trimString(dive.notes),
      buddies: trimString(dive.buddy),
      dive_center: trimString(dive.dive_shop),
    },
  };
}

export function padiCreateValidationError(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const errors = (response as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return null;

  const messages = errors
    .map((error) => (error && typeof error === "object" ? (error as { message?: unknown }).message : null))
    .filter((message): message is string => typeof message === "string" && message.trim().length > 0);

  const invalidInput = messages.find((message) => /invalid input value for enum/i.test(message));
  if (invalidInput) return `PADI rejected one of this dive's field values: ${invalidInput}. Edit the dive and try again.`;

  return null;
}

async function markDiveCreatedInPadi(owner: DiveOwner, diveId: number, padiDive: Record<string, unknown>) {
  const result = await getPool().query<{ id: number }>(
    `
      update dives
      set padi_dive_id = $3,
          dive_number = null,
          padi_member_number = null,
          adventure_dive = $4,
          dive_type = $5,
          log_type = $6,
          log_course = $7,
          padi_status = $8,
          updated_at = now()
      where id = $1 and user_id = $2 and padi_dive_id is null
      returning id
    `,
    [
      diveId,
      owner.id,
      Number(padiDive.id),
      Boolean(padiDive.adventure_dive),
      trimString(padiDive.dive_type as string | null),
      trimString(padiDive.log_type as string | null),
      trimString(padiDive.log_course as string | null),
      trimString(padiDive.status as string | null),
    ],
  );

  if (result.rowCount === 0) throw new DiveNotFoundError();
}

export async function createDiveInPadi(
  owner: DiveOwner,
  dive: DiveRecord,
  { padiClient = defaultClient }: { padiClient?: PadiCreateClient } = {},
): Promise<CreatePadiDiveResult> {
  if (dive.padi_dive_id !== null) {
    return { ok: false, error: "This dive already exists in PADI.", reason: "already_linked" };
  }

  const credentials = await getPadiCredentials(owner.id);
  if (!credentials.ok) return credentials;
  const { bearerToken, affiliateId } = credentials;

  let response;
  try {
    response = await padiClient.createLogbookDive(bearerToken, affiliateId, mapDiveToPadiCreateInput(dive, affiliateId));
  } catch (error) {
    if (error instanceof PadiApiError && error.status === 401) {
      return { ok: false, error: "PADI needs to be reconnected", reason: "reconnect_required" };
    }
    console.error("PADI create failed", error);
    return { ok: false, error: "Could not create this dive in PADI", reason: "infrastructure" };
  }

  const created = response?.data?.insert_logbook_logs?.returning?.[0];
  const padiDiveId = Number(created?.id);
  if (!Number.isInteger(padiDiveId)) {
    const validationError = padiCreateValidationError(response);
    console.error("PADI create returned no dive id", response);
    return {
      ok: false,
      error: validationError ?? "PADI did not return a created dive id",
      reason: validationError ? "validation" : "infrastructure",
    };
  }

  try {
    await markDiveCreatedInPadi(owner, dive.id, { ...created, id: padiDiveId });
  } catch (error) {
    console.error("PADI create succeeded but local dive could not be marked", error);
    return { ok: false, error: "PADI created the dive, but local status could not be updated", reason: "infrastructure" };
  }

  return { ok: true, padiDiveId };
}
