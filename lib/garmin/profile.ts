import "server-only";

import type { DepthPoint } from "@/lib/depth-profile";
import type { DiveInput } from "@/lib/dives";
import { isDescentDevice } from "./descent-devices";

export type GarminDiveProfilePoint = {
  time: number; // Offset from start in seconds
  timestamp: string; // ISO string
  depth: number | null;
  temperature: number | null;
  tankPressure?: number | null;
  gasConsumption?: number | null;
  gasConsumptionRate?: number | null;
  surfaceConsumptionRate?: number | null;
};

export type GarminDiveProfile = {
  source: "garmin";
  version: 1;
  activityId: string;
  startedAt: string | null;
  durationMinutes: number | null;
  maxDepth: number | null;
  averageDepth: number | null;
  waterTemperature: number | null;
  waterTemperatureLow: number | null;
  surfaceTemperature: number | null;
  tankStartPressure?: number | null;
  tankEndPressure?: number | null;
  tankSizeLitres?: number | null;
  gasMix?: string | null;
  location: { lat: number; lng: number } | null;
  points: GarminDiveProfilePoint[];
  depthProfile: DepthPoint[];
  summary: Record<string, unknown>;
};

export type GarminProfileCompileResult =
  | { ok: true; profile: GarminDiveProfile; draftDive: Partial<DiveInput> }
  | { ok: false; error: string; reason?: "not_a_dive" | "not_descent" };

// Only fields consumed here are constrained; the original session remains the summary.
// Enum fields may be numeric or string-valued depending on FIT decoder options.
type GarminFitMessages = {
  sessionMesgs?: {
    subSport?: number | string;
    startTime?: Date | number | string;
    totalTimerTime?: number | null;
    maxDepth?: number | null;
    avgDepth?: number | null;
    startPositionLat?: number | null;
    startPositionLong?: number | null;
    minTemperature?: number | null;
  }[];
  deviceInfoMesgs?: {
    manufacturer?: number | string;
    product?: number;
    garminProduct?: number | string;
  }[];
  recordMesgs?: {
    timestamp?: Date | number | string;
    depth?: number | null;
    temperature?: number | null;
  }[];
  // `surfaceTemperature` isn't part of the FIT SDK's declared DiveSettingsMesg shape (pre-existing
  // behavior, always undefined via the real decoder) -- kept opaque here and narrowed with a local
  // cast at the read site instead of misdescribing the SDK's actual message shape.
  diveSettingsMesgs?: unknown[];
  diveGasMesgs?: { oxygenContent?: number | null }[];
};

// Sub sport enum for diving
const SUB_SPORT_APNEA_DIVING = 37;
const SUB_SPORT_APNEA_HUNT = 43;


function draftDiveFromGarminProfile(profile: GarminDiveProfile): Partial<DiveInput> {
  return {
    title: "Garmin dive",
    site: profile.location
      ? {
          name: `Garmin GPS ${profile.location.lat.toFixed(4)}, ${profile.location.lng.toFixed(4)}`,
          location: `${profile.location.lat}, ${profile.location.lng}`,
          lat: profile.location.lat,
          lng: profile.location.lng,
        }
      : null,
    occurredAt: profile.startedAt ?? new Date().toISOString(),
    maxDepth: profile.maxDepth ?? undefined,
    avgDepth: profile.averageDepth ?? undefined,
    bottomTimeMinutes: profile.durationMinutes === null ? undefined : Math.round(profile.durationMinutes),
    waterTemp: profile.waterTemperature ?? undefined,
    waterTempLow: profile.waterTemperatureLow ?? undefined,
    gasMix: profile.gasMix ?? undefined,
    startPressure: profile.tankStartPressure ?? undefined,
    endPressure: profile.tankEndPressure ?? undefined,
    cylinderSize: profile.tankSizeLitres ?? undefined,
    depthProfile: profile.depthProfile,
    depthProfileRaw: null,
  };
}

export function compileGarminProfile(
  activityId: string,
  fitMessages: GarminFitMessages,
): GarminProfileCompileResult {
  const sessionMsg = fitMessages.sessionMesgs?.[0];
  if (!sessionMsg) {
    return { ok: false, error: "No session message found in FIT file" };
  }

  // Ensure it's a dive (not apnea)
  const subSport = sessionMsg.subSport;
  if (subSport === SUB_SPORT_APNEA_DIVING || subSport === SUB_SPORT_APNEA_HUNT) {
    return { ok: false, error: "Apnea dives are explicitly excluded", reason: "not_a_dive" };
  }

  // Ensure it's from a Descent device
  const deviceInfoMsgs = fitMessages.deviceInfoMesgs || [];
  let isDescent = false;
  for (const info of deviceInfoMsgs) {
    if (isDescentDevice({
      manufacturer: typeof info.manufacturer === "number" ? info.manufacturer : undefined,
      product: info.product,
      garminProduct: typeof info.garminProduct === "number" ? info.garminProduct : undefined,
    })) {
      isDescent = true;
      break;
    }
  }

  if (!isDescent) {
    console.warn("Activity is from a Garmin device not strictly in the Descent list, but importing anyway.");
  }

  const diveSettingsMsg = fitMessages.diveSettingsMesgs?.[0] as { surfaceTemperature?: number | null } | undefined;
  function parseGarminTimestamp(ts: unknown): number | null {
    if (ts instanceof Date) return ts.getTime();
    if (typeof ts === "number") return ts * 1000 + 631065600000;
    if (typeof ts === "string") return Date.parse(ts);
    return null;
  }
  const startTimeMs = parseGarminTimestamp(sessionMsg.startTime);
  const startedAt = startTimeMs ? new Date(startTimeMs).toISOString() : null;

  // FIT timestamps are usually Date objects if the SDK parsed them
  let durationMinutes: number | null = null;
  if (sessionMsg.totalTimerTime) {
    durationMinutes = sessionMsg.totalTimerTime / 60.0;
  }

  let maxDepth = sessionMsg.maxDepth || null;
  let averageDepth = sessionMsg.avgDepth || null;
  
  let lat: number | null = null;
  let lng: number | null = null;
  if (sessionMsg.startPositionLat && sessionMsg.startPositionLong) {
    lat = sessionMsg.startPositionLat * (180 / Math.pow(2, 31));
    lng = sessionMsg.startPositionLong * (180 / Math.pow(2, 31));
  }

  // Compile points
  const points: GarminDiveProfilePoint[] = [];
  const depthProfile: DepthPoint[] = [];
  const records = fitMessages.recordMesgs || [];
  
  let startTimestampMs = startTimeMs;
  if (!startTimestampMs && records.length > 0) {
    startTimestampMs = parseGarminTimestamp(records[0].timestamp);
  }

  for (const record of records) {
    const recordTsMs = parseGarminTimestamp(record.timestamp);
    if (recordTsMs !== null && startTimestampMs) {
      const timeSecs = (recordTsMs - startTimestampMs) / 1000;
      
      points.push({
        time: timeSecs,
        timestamp: new Date(recordTsMs).toISOString(),
        depth: record.depth ?? null,
        temperature: record.temperature ?? null,
      });

      if (typeof record.depth === "number") {
        depthProfile.push({ time: timeSecs, depth: record.depth });
      }
    }
  }

  if (!durationMinutes && points.length > 0) {
    durationMinutes = points[points.length - 1].time / 60.0;
  }
  if (!maxDepth && depthProfile.length > 0) {
    maxDepth = Math.max(...depthProfile.map(p => p.depth));
  }
  if (!averageDepth && depthProfile.length > 0) {
    averageDepth = depthProfile.reduce((sum, p) => sum + p.depth, 0) / depthProfile.length;
  }

  if (maxDepth !== null) {
    maxDepth = Math.round(maxDepth * 100) / 100;
  }
  if (averageDepth !== null) {
    averageDepth = Math.round(averageDepth * 100) / 100;
  }

  const temps = points.map(p => p.temperature).filter((t): t is number => typeof t === "number");
  const waterTempLow = temps.length > 0 ? Math.round(Math.min(...temps) * 10) / 10 : null;
  const waterTempSurface = diveSettingsMsg?.surfaceTemperature ?? (temps.length > 0 ? temps[0] : null);

  const diveGas = fitMessages.diveGasMesgs?.[0];
  let gasMix: string | null = null;
  if (diveGas?.oxygenContent) {
    gasMix = diveGas.oxygenContent === 21 ? "Air" : `EAN${Math.round(diveGas.oxygenContent)}`;
  }

  const profile: GarminDiveProfile = {
    source: "garmin",
    version: 1,
    activityId,
    startedAt,
    durationMinutes,
    maxDepth,
    averageDepth,
    waterTemperature: waterTempSurface ?? sessionMsg.minTemperature ?? null,
    waterTemperatureLow: waterTempLow ?? sessionMsg.minTemperature ?? null,
    surfaceTemperature: waterTempSurface,
    gasMix,
    location: lat !== null && lng !== null ? { lat, lng } : null,
    points,
    depthProfile,
    summary: sessionMsg,
  };

  return { ok: true, profile, draftDive: draftDiveFromGarminProfile(profile) };
}
