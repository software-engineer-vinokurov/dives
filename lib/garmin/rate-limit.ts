import "server-only";

import { getPool, queryRead } from "@/lib/db";
import { hashGarminEmail } from "./integrations";

const ROLLING_WINDOW_MINUTES = 60;
const USER_ATTEMPT_LIMIT = 5;
const EMAIL_HASH_ATTEMPT_LIMIT = 20;

export type GarminRateLimitCheck = {
  userAttempts: number;
  emailHashAttempts: number;
  exemptFromEmailHashLimit: boolean;
};

export async function checkGarminRateLimit(
  userId: string,
  emailHash: string,
): Promise<GarminRateLimitCheck> {
  const [userAttemptsResult, emailHashAttemptsResult, exemptResult] = await Promise.all([
    queryRead<{ count: string }>(
      "select count(*)::int as count from garmin_login_attempts where user_id = $1 and attempted_at > now() - interval '1 minute' * $2",
      [userId, ROLLING_WINDOW_MINUTES],
    ),
    queryRead<{ count: string }>(
      "select count(*)::int as count from garmin_login_attempts where email_hash = $1 and attempted_at > now() - interval '1 minute' * $2",
      [emailHash, ROLLING_WINDOW_MINUTES],
    ),
    queryRead<{ exists: boolean }>(
      "select exists(select 1 from garmin_integrations where user_id = $1 and email_hash = $2 and status = 'connected') as exists",
      [userId, emailHash],
    ),
  ]);

  return {
    userAttempts: Number(userAttemptsResult.rows[0]?.count ?? 0),
    emailHashAttempts: Number(emailHashAttemptsResult.rows[0]?.count ?? 0),
    exemptFromEmailHashLimit: exemptResult.rows[0]?.exists ?? false,
  };
}

export function isGarminRateLimited(check: GarminRateLimitCheck): boolean {
  if (check.userAttempts >= USER_ATTEMPT_LIMIT) return true;
  if (!check.exemptFromEmailHashLimit && check.emailHashAttempts >= EMAIL_HASH_ATTEMPT_LIMIT) return true;
  return false;
}

export async function recordFailedGarminAttempt(userId: string, email: string): Promise<void> {
  await getPool().query("insert into garmin_login_attempts (user_id, email_hash) values ($1, $2)", [
    userId,
    hashGarminEmail(email),
  ]);
}
