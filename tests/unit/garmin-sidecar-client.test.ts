import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { garminLogin, listGarminActivities, downloadGarminFit } from "../../lib/garmin/sidecar-client";

import { updateGarminTokens } from "../../lib/garmin/integrations";

vi.mock("../../lib/garmin/integrations", () => ({
  updateGarminTokens: vi.fn(),
}));

describe("Garmin Sidecar Client", () => {
  const dummySession = JSON.stringify({ oauth1: { dummy: 1 }, oauth2: { dummy: 2 } });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => vi.unstubAllGlobals());

  const oauth1 = { token: "opaque", extra: { values: [1, null, "value"] } };
  const oauth2 = { access_token: "access", refresh_token: "refresh", expires_in: 3600, extra: { scope: ["dive"] } };

  function respond(payload: unknown, status = 200) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: status < 400, status, text: async () => JSON.stringify(payload),
    }));
  }

  it("round-trips opaque OAuth login fields", async () => {
    respond({ oauth1, oauth2 });
    expect(await garminLogin("test.garmin@aleksandr.vin", "test-password")).toEqual({
      sessionJson: JSON.stringify({ oauth1, oauth2 }),
    });
  });

  it("persists both changed refreshed tokens for the requesting user", async () => {
    const payload = { activities: [], updatedOauth1: oauth1, updatedOauth2: oauth2 };
    respond(payload);
    expect(await listGarminActivities("user-1", dummySession)).toEqual(payload);
    expect(updateGarminTokens).toHaveBeenCalledExactlyOnceWith("user-1", JSON.stringify({ oauth1, oauth2 }));
  });

  it.each([
    {}, { updatedOauth1: oauth1 }, { updatedOauth2: oauth2 },
    { updatedOauth1: null, updatedOauth2: oauth2 },
    { updatedOauth1: oauth1, updatedOauth2: false },
    { updatedOauth1: { dummy: 1 }, updatedOauth2: { dummy: 2 } },
  ])("does not persist missing, falsey, or unchanged refresh: %j", async (refresh) => {
    respond({ activities: [], ...refresh });
    await listGarminActivities("user-1", dummySession);
    expect(updateGarminTokens).not.toHaveBeenCalled();
  });

  it("rejects when refreshed-token persistence fails", async () => {
    respond({ activities: [], updatedOauth1: oauth1, updatedOauth2: oauth2 });
    vi.mocked(updateGarminTokens).mockRejectedValueOnce(new Error("Persistence failed"));
    await expect(listGarminActivities("user-1", dummySession)).rejects.toThrow("Persistence failed");
  });

  it("maps authentication errors and redacts secrets", async () => {
    respond({ error: 'Rejected {"password":"secret","oauth1":{"token":"secret"},"oauth2":"secret","sessionJson":"secret"}' }, 401);
    await expect(listGarminActivities("user-1", dummySession)).rejects.toMatchObject({
      reason: "auth_expired", status: 401,
      message: 'Rejected {"password":"[redacted]","oauth1":[redacted],"oauth2":[redacted],"sessionJson":"[redacted]"}',
    });
  });

  it.each([[0, 1], [101, 100]])("clamps limit %i to %i", async (limit, expected) => {
    respond({ activities: [] });
    await listGarminActivities("user-1", dummySession, { start: 5, limit });
    expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      body: JSON.stringify({ start: 5, limit: expected, activityType: "diving", ...JSON.parse(dummySession) }),
    }));
  });

  it("lists activities successfully", async () => {
    const mockResponse = {
      ok: true,
      text: async () => JSON.stringify({
        activities: [{ activityId: 123, activityName: "Dive" }],
      }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const result = await listGarminActivities("user-1", dummySession, { limit: 20 });
    
    expect(result.activities.length).toBe(1);
    expect(result.activities[0].activityId).toBe(123);
    
    expect(global.fetch).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:4819/activities/list"),
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          start: 0,
          limit: 20,
          activityType: "diving",
          oauth1: { dummy: 1 },
          oauth2: { dummy: 2 }
        })
      })
    );
  });

  it("handles sidecar HTTP errors gracefully", async () => {
    const mockResponse = {
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: "Server exploded" }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    await expect(listGarminActivities("user-1", dummySession, { limit: 30 })).rejects.toThrow("Server exploded");
  });

  it("downloads FIT base64 successfully", async () => {
    const mockResponse = {
      ok: true,
      text: async () => JSON.stringify({
        activityId: 123, fitBase64: "dummybase64zip",
      }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const result = await downloadGarminFit("user-1", dummySession, 123);
    
    expect(result.activityId).toBe(123);
    expect(result.fitBase64).toBe("dummybase64zip");
  });
});
