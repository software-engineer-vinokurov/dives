import "server-only";
import { updateGarminTokens } from "./integrations";

export type GarminSidecarErrorReason =
  | "bad_request"
  | "auth_expired"
  | "network"
  | "rate_limited"
  | "server"
  | "timeout"
  | "not_found";

export class GarminSidecarError extends Error {
  constructor(
    message: string,
    public readonly reason: GarminSidecarErrorReason,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "GarminSidecarError";
  }
}

export type GarminActivitySummary = {
  activityId: number;
  activityName: string;
  startTimeLocal: string;
  activityType: {
    typeId: number;
    typeKey: string;
    parentTypeId: number;
  };
  [key: string]: unknown;
};

export type GarminDownloadResponse = {
  activityId: number;
  fitBase64: string; // ZIP containing the FIT, or the FIT itself depending on GC response
};

export type GarminLoginResponse = {
  sessionJson: string;
};

export function redactGarminSecret(value: string): string {
  return value
    .replace(/("password"\s*:\s*")([^"]+)(")/gi, "$1[redacted]$3")
    .replace(/("sessionJson"\s*:\s*")([^"]+)(")/gi, "$1[redacted]$3")
    .replace(/("oauth1"\s*:\s*)(\{[^}]*\}|"[^"]+")/gi, "$1[redacted]")
    .replace(/("oauth2"\s*:\s*)(\{[^}]*\}|"[^"]+")/gi, "$1[redacted]");
}

function sidecarBaseUrl(): URL {
  const raw = process.env.GARMIN_SIDECAR_URL ?? "http://127.0.0.1:4818";
  const url = new URL(raw);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new GarminSidecarError("GARMIN_SIDECAR_URL must be an http localhost URL.", "bad_request");
  }
  return url;
}

function reasonFromStatus(status: number): GarminSidecarErrorReason {
  if (status === 401) return "auth_expired";
  if (status === 404) return "not_found";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "server";
}

async function callSidecar<T>(path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
  const url = new URL(path, sidecarBaseUrl());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    const payload = text ? (JSON.parse(text) as unknown) : null;
    if (!response.ok) {
      const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
      const reason =
        typeof record.reason === "string" ? (record.reason as GarminSidecarErrorReason) : reasonFromStatus(response.status);
      const message = typeof record.error === "string" ? record.error : `Garmin sidecar request failed (${response.status}).`;
      throw new GarminSidecarError(redactGarminSecret(message), reason, response.status);
    }
    return payload as T;
  } catch (error) {
    if (error instanceof GarminSidecarError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new GarminSidecarError("Garmin sidecar request timed out.", "timeout", 408);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new GarminSidecarError(redactGarminSecret(message), "network");
  } finally {
    clearTimeout(timer);
  }
}

export async function garminLogin(email: string, password: string): Promise<GarminLoginResponse> {
  const payload = await callSidecar<{ oauth1: any; oauth2: any }>("/login", { email, password });
  return { sessionJson: JSON.stringify({ oauth1: payload.oauth1, oauth2: payload.oauth2 }) };
}

async function callWithSession<T>(
  userId: string,
  sessionJson: string,
  path: string,
  body: Record<string, unknown>,
  timeoutMs = 60_000
): Promise<T> {
  const session = JSON.parse(sessionJson);
  const result = await callSidecar<T & { updatedOauth1?: any; updatedOauth2?: any }>(
    path,
    { ...body, oauth1: session.oauth1, oauth2: session.oauth2 },
    timeoutMs
  );

  if (result.updatedOauth1 && result.updatedOauth2) {
    // If the sidecar refreshed the tokens, update them in the database!
    const newSession = JSON.stringify({ oauth1: result.updatedOauth1, oauth2: result.updatedOauth2 });
    if (newSession !== sessionJson) {
      await updateGarminTokens(userId, newSession);
    }
  }

  return result;
}

export async function listGarminActivities(
  userId: string,
  sessionJson: string,
  options: { start?: number; limit?: number } = {},
): Promise<{ activities: GarminActivitySummary[] }> {
  const start = options.start ?? 0;
  const limit = Math.max(1, Math.min(100, options.limit ?? 20));
  return callWithSession(userId, sessionJson, "/activities/list", { start, limit, activityType: "diving" });
}

export async function downloadGarminFit(
  userId: string,
  sessionJson: string,
  activityId: number | string,
): Promise<GarminDownloadResponse> {
  return callWithSession(userId, sessionJson, "/activities/download-fit", { activityId: Number(activityId) }, 180_000);
}
