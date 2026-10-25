import { describe, expect, it } from "vitest";

import { mapWeatherToPadi } from "@/lib/padi/enum-map";

describe("mapWeatherToPadi", () => {
  it.each([
    ["Sunny", "Sunny"],
    ["sunny, light chop", "Sunny"],
    ["PARTLY CLOUDY", "Partly Cloudy"],
    ["partly   cloudy, warm", "Partly Cloudy"],
    ["partly-cloudy", "Partly Cloudy"],
    ["cloudy, later partly cloudy", "Cloudy"],
    ["Cloudy", "Cloudy"],
    ["overcast and rainy", "Rainy"],
    ["Windy afternoon", "Windy"],
    ["foggy morning", "Foggy"],
  ])("maps %j to %j", (input, expected) => {
    expect(mapWeatherToPadi(input)).toBe(expected);
  });

  it("picks the keyword that appears first in the text", () => {
    expect(mapWeatherToPadi("Rainy then sunny")).toBe("Rainy");
    expect(mapWeatherToPadi("windy, a bit cloudy")).toBe("Windy");
  });

  it("returns null when no supported keyword is present, or for empty input", () => {
    expect(mapWeatherToPadi("Overcast")).toBeNull();
    expect(mapWeatherToPadi("rain")).toBeNull();
    expect(mapWeatherToPadi("   ")).toBeNull();
    expect(mapWeatherToPadi(null)).toBeNull();
  });

  it("matches whole words only", () => {
    expect(mapWeatherToPadi("sunnyside reef")).toBeNull();
  });
});
