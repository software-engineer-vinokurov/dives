import { describe, expect, it, vi, beforeEach } from "vitest";
import { listGarminActivities, downloadGarminFit } from "../../lib/garmin/sidecar-client";

vi.mock("../../lib/garmin/integrations", () => ({
  updateGarminTokens: vi.fn(),
}));

describe("Garmin Sidecar Client", () => {
  const dummySession = JSON.stringify({ oauth1: { dummy: 1 }, oauth2: { dummy: 2 } });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("lists activities successfully", async () => {
    const mockResponse = {
      ok: true,
      text: async () => JSON.stringify({
        activities: [{ activityId: 123, activityName: "Dive" }],
      }),
    };
    global.fetch = vi.fn().mockResolvedValue(mockResponse);

    const result = await listGarminActivities("user-1", dummySession, { limit: 20 });
    
    expect(result.activities.length).toBe(1);
    expect(result.activities[0].activityId).toBe(123);
    
    expect(global.fetch).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:4818/activities/list"),
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
    global.fetch = vi.fn().mockResolvedValue(mockResponse);

    await expect(listGarminActivities("user-1", dummySession, { limit: 30 })).rejects.toThrow("Server exploded");
  });

  it("downloads FIT base64 successfully", async () => {
    const mockResponse = {
      ok: true,
      text: async () => JSON.stringify({
        activityId: 123, fitBase64: "dummybase64zip",
      }),
    };
    global.fetch = vi.fn().mockResolvedValue(mockResponse);

    const result = await downloadGarminFit("user-1", dummySession, 123);
    
    expect(result.activityId).toBe(123);
    expect(result.fitBase64).toBe("dummybase64zip");
  });
});
