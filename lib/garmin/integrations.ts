import "server-only";

import { createHmac } from "node:crypto";
import { getPool, queryRead } from "@/lib/db";
import { decryptSecret, encryptSecret, keyFromEnvValue } from "./crypto";

export type GarminIntegrationStatus = {
  status: "connected" | "needs_reconnect";
  connectedAt: Date;
  lastFetchAt: Date | null;
  needsReconnectAt: Date | null;
  tokenExpiresAt: Date | null;
} | null;

export type GarminSession = {
  oauth1: any;
  oauth2: {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    [key: string]: any;
  };
};

export type SaveGarminIntegrationInput = {
  email: string;
  sessionJson: string;
};

const GARMIN_PEPPER_PLACEHOLDER = "replace-with-garmin-email-hash-pepper";

function configuredSessionKey(): Buffer {
  const value = process.env.GARMIN_SESSION_ENCRYPTION_KEY || process.env.SUUNTO_SESSION_ENCRYPTION_KEY || process.env.PADI_TOKEN_ENCRYPTION_KEY;
  if (!value) throw new Error("GARMIN_SESSION_ENCRYPTION_KEY is not configured");
  return keyFromEnvValue(value);
}

function previousSessionKey(): Buffer | undefined {
  const value = process.env.GARMIN_SESSION_ENCRYPTION_KEY_PREVIOUS;
  return value ? keyFromEnvValue(value) : undefined;
}

function emailHashKey(): string {
  const pepper = process.env.GARMIN_EMAIL_HASH_PEPPER || process.env.SUUNTO_EMAIL_HASH_PEPPER || process.env.PADI_USERNAME_HASH_PEPPER;
  if (!pepper || pepper === GARMIN_PEPPER_PLACEHOLDER) {
    throw new Error("GARMIN_EMAIL_HASH_PEPPER is not configured");
  }
  return pepper;
}

export function hashGarminEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  return createHmac("sha256", emailHashKey()).update(normalized).digest("hex");
}

export function assertGarminIntegrationConfigured(): void {
  configuredSessionKey();
  emailHashKey();
}

export async function getGarminIntegrationStatus(userId: string): Promise<GarminIntegrationStatus> {
  const result = await queryRead<{
    status: string;
    connected_at: Date;
    last_fetch_at: Date | null;
    needs_reconnect_at: Date | null;
    token_expires_at: Date | null;
  }>(
    `
      select status, connected_at, last_fetch_at, needs_reconnect_at, token_expires_at
      from garmin_integrations
      where user_id = $1
    `,
    [userId],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    status: row.status as "connected" | "needs_reconnect",
    connectedAt: row.connected_at,
    lastFetchAt: row.last_fetch_at,
    needsReconnectAt: row.needs_reconnect_at,
    tokenExpiresAt: row.token_expires_at,
  };
}

export async function saveGarminIntegration(
  userId: string,
  input: SaveGarminIntegrationInput,
): Promise<void> {
  const key = configuredSessionKey();
  const sessionEncrypted = encryptSecret(input.sessionJson, key, `${userId}:garmin:session`);
  
  let tokenExpiresAt: Date | null = null;
  try {
    const session = JSON.parse(input.sessionJson) as GarminSession;
    if (session.oauth2?.expires_in) {
      tokenExpiresAt = new Date(Date.now() + session.oauth2.expires_in * 1000);
    }
  } catch (err) {
    // ignore parse error if any
  }

  await getPool().query(
    `
      insert into garmin_integrations
        (user_id, email_hash, session_encrypted, token_expires_at, status, needs_reconnect_at, connected_at, updated_at)
      values ($1, $2, $3, $4, 'connected', null, now(), now())
      on conflict (user_id) do update set
        email_hash = excluded.email_hash,
        session_encrypted = excluded.session_encrypted,
        token_expires_at = excluded.token_expires_at,
        status = 'connected',
        needs_reconnect_at = null,
        connected_at = now(),
        updated_at = now()
    `,
    [userId, hashGarminEmail(input.email), sessionEncrypted, tokenExpiresAt],
  );
}

export async function updateGarminTokens(
  userId: string,
  sessionJson: string,
): Promise<void> {
  const key = configuredSessionKey();
  const sessionEncrypted = encryptSecret(sessionJson, key, `${userId}:garmin:session`);
  
  let tokenExpiresAt: Date | null = null;
  try {
    const session = JSON.parse(sessionJson) as GarminSession;
    if (session.oauth2?.expires_in) {
      tokenExpiresAt = new Date(Date.now() + session.oauth2.expires_in * 1000);
    }
  } catch (err) {
    // ignore parse error if any
  }

  await getPool().query(
    `
      update garmin_integrations
      set session_encrypted = $2, token_expires_at = $3, updated_at = now()
      where user_id = $1
    `,
    [userId, sessionEncrypted, tokenExpiresAt],
  );
}

export async function getGarminSessionJson(userId: string): Promise<string | null> {
  const result = await queryRead<{ session_encrypted: string }>(
    "select session_encrypted from garmin_integrations where user_id = $1 and status = 'connected'",
    [userId],
  );
  const ciphertext = result.rows[0]?.session_encrypted;
  if (!ciphertext) return null;

  return decryptSecret(ciphertext, configuredSessionKey(), `${userId}:garmin:session`, previousSessionKey());
}

export async function markGarminFetched(userId: string): Promise<void> {
  await getPool().query(
    "update garmin_integrations set last_fetch_at = now(), updated_at = now() where user_id = $1",
    [userId],
  );
}

export async function markGarminNeedsReconnect(userId: string): Promise<void> {
  await getPool().query(
    `
      update garmin_integrations
      set status = 'needs_reconnect', needs_reconnect_at = coalesce(needs_reconnect_at, now()), updated_at = now()
      where user_id = $1
    `,
    [userId],
  );
}

export async function deleteGarminIntegration(userId: string): Promise<void> {
  await getPool().query("delete from garmin_integrations where user_id = $1", [userId]);
}
