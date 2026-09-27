import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPool, getTestPool } from "./helpers/pg";

type CookieStore = Map<string, { value: string }>;
const cookieStore: CookieStore = new Map();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => cookieStore.get(name),
    set: (name: string, value: string) => { cookieStore.set(name, { value }); },
    delete: (name: string) => { cookieStore.delete(name); },
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error(`REDIRECT:${url}`);
    (error as Error & { digest: string }).digest = `NEXT_REDIRECT;${url}`;
    throw error;
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

vi.mock("@/lib/garmin/sidecar-client", () => ({
  listGarminActivities: vi.fn(),
  downloadGarminFit: vi.fn(),
}));

vi.mock("@/lib/garmin/raw-fit", () => ({
  extractFitFromZip: vi.fn().mockResolvedValue(new Uint8Array()),
  parseFitBuffer: vi.fn().mockReturnValue({})
}));

vi.mock("@/lib/garmin/profile", () => ({
  compileGarminProfile: vi.fn().mockReturnValue({
    ok: true,
    profile: { source: "garmin", maxDepth: 10 },
    draftDive: { maxDepth: 10 }
  })
}));

import { listGarminActivities, downloadGarminFit } from "../../lib/garmin/sidecar-client";
import { createSession } from "../../lib/session";
import { saveGarminIntegration } from "../../lib/garmin/integrations";
import { fetchGarminActivitiesAction, deleteGarminImportAction } from "../../app/actions/garmin";

describe("Garmin Actions Integration", () => {
  const pool = getTestPool();
  
  beforeEach(async () => {
    cookieStore.clear();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  async function createTestUser() {
    const email = `test-${randomUUID()}@aleksandr.vin`;
    const result = await pool.query("INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id", [email]);
    const id = String(result.rows[0].id);
    await createSession(id);
    
    process.env.GARMIN_SESSION_ENCRYPTION_KEY = "ch0Ih4TeQGrdx3siP4c7FAk6XSYoyMHZT27w0qOoI5E=";
    process.env.GARMIN_EMAIL_HASH_PEPPER = "dummy-pepper-for-tests-that-needs-to-exist";
    const dummySession = JSON.stringify({ oauth1: { dummy: 1 }, oauth2: { dummy: 2 } });
    await saveGarminIntegration(id, { email, sessionJson: dummySession });
    
    return id;
  }

  it("fetches activities and inserts into garmin_imports", async () => {
    const userId = await createTestUser();
    
    // Mock the sidecar
    vi.mocked(listGarminActivities).mockResolvedValue({
      activities: [{ activityId: 101, activityName: "Dive 101", startTimeLocal: "2026-09-26 10:00", activityType: { typeId: 1, typeKey: "diving", parentTypeId: 0 } }]
    });
    
    vi.mocked(downloadGarminFit).mockResolvedValue({
      activityId: 101,
      fitBase64: "dummybase64" // mocked away anyway
    });

    const result = await fetchGarminActivitiesAction({ mode: "days", daysBack: 30 });
    expect(result.ok).toBe(true);

    const { rows } = await pool.query("SELECT * FROM garmin_imports WHERE user_id = $1", [userId]);
    expect(rows.length).toBe(1);
    expect(rows[0].activity_id).toBe("101");
    expect(rows[0].draft_dive.maxDepth).toBe(10);
  });
  
  it("skips duplicates already in garmin_imports", async () => {
    const userId = await createTestUser();
    await pool.query(
      "INSERT INTO garmin_imports (user_id, activity_id, original_fit, compiled_profile, draft_dive) VALUES ($1, $2, $3, $4, $5)",
      [userId, "101", "\\x00", "{}", "{}"]
    );

    vi.mocked(listGarminActivities).mockResolvedValue({
      activities: [{ activityId: 101, activityName: "Dive 101", startTimeLocal: "2026-09-26 10:00", activityType: { typeId: 1, typeKey: "diving", parentTypeId: 0 } }]
    });

    const result = await fetchGarminActivitiesAction({ mode: "days", daysBack: 30 });
    expect(result.ok).toBe(true);

    // downloadGarminFit should NOT have been called because it was deduplicated
    expect(downloadGarminFit).not.toHaveBeenCalled();
  });
  
  it("deletes a staged garmin import", async () => {
    const userId = await createTestUser();
    
    const { rows } = await pool.query(
      "INSERT INTO garmin_imports (user_id, activity_id, original_fit, compiled_profile, draft_dive) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [userId, "202", "\\x00", "{}", "{}"]
    );
    const importId = rows[0].id;
    
    const result = await deleteGarminImportAction(importId);
    expect(result.ok).toBe(true);
    
    const check = await pool.query("SELECT count(*) FROM garmin_imports WHERE id = $1", [importId]);
    expect(Number(check.rows[0].count)).toBe(0);
  });
});
