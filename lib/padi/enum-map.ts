// Shared bidirectional maps between this app's dive-condition/equipment vocabulary and PADI's own
// enum codes (e.g. app "Wetsuit 7mm" <-> PADI "FullSuit_7mm", app "Mild" <-> PADI "SomeCurrent").
// Both `lib/padi/create.ts` (app -> PADI, on create/update) and `lib/padi/field-map.ts` (PADI ->
// app, on import) read from the same source maps so the two directions can't drift apart. See
// issue #20: an unrecognized code on either side falls through as-is rather than being dropped, so
// callers should always fall back to the raw value on a missed lookup (`map[value] ?? value`).

// Throws on a duplicate value rather than silently dropping an entry -- a non-injective source map
// would make the reverse lookup lossy, which defeats the whole point of deriving it instead of
// hand-writing it.
function invert(map: Record<string, string>): Record<string, string> {
  const inverted: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    if (value in inverted) throw new Error(`enum-map: "${value}" is not a unique value, can't invert`);
    inverted[value] = key;
  }
  return inverted;
}

export const PADI_SUIT_BY_APP_SUIT: Record<string, string> = {
  "Skin / rash guard": "SkinSuit",
  Shorty: "Shorty",
  "Wetsuit 3mm": "FullSuit_3mm",
  "Wetsuit 5mm": "FullSuit_5mm",
  "Wetsuit 7mm": "FullSuit_7mm",
  "Semi-dry": "SemiDrySuit",
  Drysuit: "DrySuit",
};
export const APP_SUIT_BY_PADI_SUIT: Record<string, string> = invert(PADI_SUIT_BY_APP_SUIT);

export const PADI_WEIGHT_BY_APP_WEIGHT: Record<string, string> = {
  Underweight: "Light",
  Perfect: "Good",
  Overweight: "Heavy",
};
export const APP_WEIGHT_BY_PADI_WEIGHT: Record<string, string> = invert(PADI_WEIGHT_BY_APP_WEIGHT);

export const PADI_WAVES_BY_APP_INTENSITY: Record<string, string> = {
  None: "NoWaves",
  Mild: "SmallWaves",
  Moderate: "MediumWaves",
  Strong: "LargeWaves",
};
export const APP_WAVES_BY_PADI_WAVES: Record<string, string> = invert(PADI_WAVES_BY_APP_INTENSITY);

export const PADI_CURRENT_BY_APP_INTENSITY: Record<string, string> = {
  None: "NoCurrent",
  Mild: "SomeCurrent",
  Moderate: "MediumCurrent",
  Strong: "StrongCurrent",
};
export const APP_CURRENT_BY_PADI_CURRENT: Record<string, string> = invert(PADI_CURRENT_BY_APP_INTENSITY);

export const PADI_SURGE_BY_APP_INTENSITY: Record<string, string> = {
  None: "NoSurge",
  Mild: "SomeSurge",
  Moderate: "MediumSurge",
  Strong: "StrongSurge",
};
export const APP_SURGE_BY_PADI_SURGE: Record<string, string> = invert(PADI_SURGE_BY_APP_INTENSITY);

// PADI's logbook accepts only these weather values (issue #60). Unlike the maps above, the app side
// is free text, so this is a keyword search rather than an exact lookup. "partly cloudy" maps to Partly Cloudy, not
// Cloudy, because its match starts earlier in the text.
export const PADI_WEATHER_VALUES = ["Sunny", "Partly Cloudy", "Cloudy", "Rainy", "Windy", "Foggy"] as const;

const PADI_WEATHER_PATTERNS = PADI_WEATHER_VALUES.map((value) => ({
  value,
  pattern: new RegExp(`\\b${value.replace(" ", "[\\s-]+")}\\b`, "i"),
}));

// Returns the PADI weather value whose keyword appears earliest in the free-text weather field
// (case-insensitive, whole words), e.g. "light rain, rainy and windy" -> "Rainy". Returns null when
// none of the keywords appear, so PADI never receives a value it doesn't support.
export function mapWeatherToPadi(weather: string | null): string | null {
  if (!weather) return null;
  let best: { value: string; index: number } | null = null;
  for (const { value, pattern } of PADI_WEATHER_PATTERNS) {
    const index = weather.search(pattern);
    if (index !== -1 && (best === null || index < best.index)) best = { value, index };
  }
  return best?.value ?? null;
}
