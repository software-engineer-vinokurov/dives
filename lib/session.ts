import "server-only";

import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getPool, queryRead } from "./db";
import { findActiveUserById, touchUserActivity, type AppUser } from "./users";
import { SESSION_COOKIE_NAME as cookieName, hashSessionToken } from "./auth/session-token";

const sessionDays = 7;

function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    expires: expiresAt,
    path: "/",
  };
}

// Inserts the session row and returns the raw token + cookie options
// without touching next/headers' cookies() jar -- for Route Handlers (the
// OIDC callback) that need to attach the cookie to their own NextResponse
// directly, since mixing cookies() mutations with a manually-constructed
// redirect Response has proven unreliable in practice (see
// AUTHENTIK-OIDC-CUSTOM-APPS.md).
//
// idToken is stored alongside the session (only set for Authentik logins)
// so logoutAction can later use it as the id_token_hint for RP-initiated
// logout -- without it, the app's own logout only clears its local cookie
// and the user stays silently signed in at the Authentik end.
export async function issueSession(userId: string, idToken?: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000);
  const tokenHash = hashSessionToken(token);

  await getPool().query(
    `
      insert into user_sessions (id, user_id, expires_at, id_token)
      values ($1, $2, $3, $4)
    `,
    [tokenHash, userId, expiresAt, idToken ?? null],
  );

  return { cookieName, token, options: sessionCookieOptions(expiresAt) };
}

export async function createSession(userId: string) {
  const { token, options } = await issueSession(userId);

  const cookieStore = await cookies();
  cookieStore.set(cookieName, token, options);
}

// Returns the deleted session's id_token (if it had one), so the caller can use it to also end
// the Authentik-side session -- see logoutAction -- plus the departing user (for logging/metrics),
// resolved from the same deleted row rather than a separate pre-read. A separate getOptionalUser()
// call before this one would race with it: Next's cookies().delete() rewrites the cookie's value
// to "" in the mutable jar rather than removing it, so a subsequent deleteSession() would read
// back an empty token and silently skip both the row deletion and the Authentik logout below.
// Not filtered on expires_at -- logout must reap the row and surface its id_token even for an
// already-expired session, so the Authentik-side session still gets ended too.
export async function deleteSession(): Promise<{ idToken: string | null; user: AppUser | null }> {
  const cookieStore = await cookies();
  const token = cookieStore.get(cookieName)?.value;
  let idToken: string | null = null;
  let user: AppUser | null = null;

  if (token) {
    const tokenHash = hashSessionToken(token);
    const result = await getPool().query<{ id_token: string | null; user_id: string }>(
      "delete from user_sessions where id = $1 returning id_token, user_id",
      [tokenHash],
    );
    idToken = result.rows[0]?.id_token ?? null;
    if (result.rows[0]) {
      // Best-effort: this lookup exists only to label the logout metric, so it must never be able
      // to block the cookie clear or lose the idToken above -- a DB error here (e.g. pool
      // exhaustion) would otherwise strand the Authentik session, and permanently so, since a retry
      // finds the row already deleted and gets no idToken at all.
      try {
        user = await findActiveUserById(result.rows[0].user_id);
      } catch (error) {
        console.error("deleteSession: failed to resolve departing user for metrics", error);
      }
    }
  }

  try { cookieStore.delete(cookieName); } catch (e) {}
  return { idToken, user };
}

async function findSessionUserId(tokenHash: string): Promise<string | null> {
  const result = await queryRead<{ user_id: string }>(
    `
      select user_id
      from user_sessions
      where id = $1
        and expires_at > now()
      limit 1
    `,
    [tokenHash],
  );

  return result.rows[0]?.user_id ?? null;
}

export async function getOptionalUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get(cookieName)?.value;

  if (!token) {
    return null;
  }

  const userId = await findSessionUserId(hashSessionToken(token));

  if (!userId) {
    try { cookieStore.delete(cookieName); } catch (e) {}
    return null;
  }

  const user = await findActiveUserById(userId);

  if (!user) {
    try { await deleteSession(); } catch (e) {}
    return null;
  }

  await touchUserActivity(user.id);
  return user;
}

export async function requireUser(nextPath?: string): Promise<AppUser> {
  const user = await getOptionalUser();

  if (!user) {
    redirect(`/${nextPath ? `?next=${encodeURIComponent(nextPath)}` : ""}`);
  }

  // Deliberately no ToS-acceptance gate here (unlike the upstream template this
  // was scaffolded from): Dives has no ToS-acceptance requirement, the
  // tos_acceptance table/migration was never ported, and leaving the template's
  // hasAcceptedTosVersion() call in would 500 every authenticated page against a
  // table that doesn't exist.
  return user;
}
