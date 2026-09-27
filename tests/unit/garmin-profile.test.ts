import { describe, expect, it } from "vitest";
import { compileGarminProfile } from "../../lib/garmin/profile";

describe("Garmin Profile Parser", () => {
  it("compiles a standard Descent dive accurately and rounds depths", () => {
    const mockFitMessages = {
      deviceInfoMesgs: [
        { manufacturer: 1, garminProduct: 3258 } // Garmin Descent Mk2
      ],
      sessionMesgs: [
        {
          subSport: 0, // Generic dive
          startTime: new Date("2026-09-25T10:00:00Z"),
          totalTimerTime: 2705.4, // 45 minutes
          startPositionLat: 50.4501,
          startPositionLong: 30.5234,
          minTemperature: 21,
        }
      ],
      diveSettingsMesgs: [
        { surfaceTemperature: 22.5 }
      ],
      diveGasMesgs: [
        { oxygenContent: 32 }
      ],
      recordMesgs: [
        { timestamp: new Date("2026-09-25T10:00:00Z"), depth: 0, temperature: 22.5 },
        { timestamp: new Date("2026-09-25T10:05:00Z"), depth: 15.3333333, temperature: 18.2 },
        { timestamp: new Date("2026-09-25T10:20:00Z"), depth: 25.1234567, temperature: 15.6 }, // max depth & min temp
        { timestamp: new Date("2026-09-25T10:45:00Z"), depth: 5.1299999, temperature: 19.5 }
      ]
    };

    const result = compileGarminProfile("test_activity_1", mockFitMessages);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok to be true");

    const profile = result.profile;
    
    // Depth rounding checks
    expect(profile.maxDepth).toBe(25.12); // rounded from 25.1234567
    expect(profile.averageDepth).toBe(11.4); // (0 + 15.3333333 + 25.1234567 + 5.1299999) / 4 = 11.396... -> 11.40

    // Gas Mix Extraction
    expect(profile.gasMix).toBe("EAN32");

    // Temperature Extraction
    expect(profile.surfaceTemperature).toBe(22.5);
    expect(profile.waterTemperatureLow).toBe(15.6);
    
    // Duration
    expect(profile.durationMinutes).toBeCloseTo(45.09);

    // Mapped Draft Dive checks
    const draft = result.draftDive;
    expect(draft.maxDepth).toBe(25.12);
    expect(draft.avgDepth).toBe(11.4);
    expect(draft.waterTempLow).toBe(15.6);
    expect(draft.waterTemp).toBe(22.5);
    expect(draft.gasMix).toBe("EAN32");
  });

  it("extracts Air when oxygenContent is 21", () => {
    const mockFitMessages = {
      deviceInfoMesgs: [{ manufacturer: 1, garminProduct: 3258 }],
      sessionMesgs: [{ subSport: 0, startTime: new Date() }],
      diveGasMesgs: [{ oxygenContent: 21 }],
      recordMesgs: []
    };

    const result = compileGarminProfile("test_activity_air", mockFitMessages);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok to be true");

    expect(result.profile.gasMix).toBe("Air");
    expect(result.draftDive.gasMix).toBe("Air");
  });

  it("handles missing temperatures and telemetry gracefully", () => {
    const mockFitMessages = {
      deviceInfoMesgs: [{ manufacturer: 1, garminProduct: 3258 }],
      sessionMesgs: [{ subSport: 0, startTime: new Date(), minTemperature: 24 }],
      recordMesgs: [] // No telemetry
    };

    const result = compileGarminProfile("test_activity_empty", mockFitMessages);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok to be true");

    expect(result.profile.waterTemperatureLow).toBe(24); // Fallback to session min
    expect(result.profile.waterTemperature).toBe(24); // Fallback to session min
    expect(result.profile.gasMix).toBeNull();
    expect(result.profile.maxDepth).toBeNull();
    expect(result.profile.averageDepth).toBeNull();
  });

  it("fails explicitly on apnea dives", () => {
    const mockFitMessages = {
      deviceInfoMesgs: [{ manufacturer: 1, garminProduct: 3258 }],
      sessionMesgs: [{ subSport: 37 }] // SUB_SPORT_APNEA_DIVING
    };

    const result = compileGarminProfile("test_apnea", mockFitMessages);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected ok to be false");
    expect(result.reason).toBe("not_a_dive");
  });
});
