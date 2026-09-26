"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, GitMerge, Loader2, Save, Star } from "lucide-react";
import { toast } from "sonner";

import { createDiveAction, recentCylindersAction, updateDiveAction } from "@/app/actions/dives";
import { createSuuntoDiveImportAction, mergeSuuntoDiveImportAction } from "@/app/actions/suunto";
import { createGarminDiveImportAction, mergeGarminDiveImportAction } from "@/app/actions/garmin";
import { Checkbox } from "@/components/ui/checkbox";
import { DepthProfileField } from "@/components/depth-profile-field";
import {
  DiveSiteField,
  emptyDiveSite,
  toSiteSelection,
  type DiveSiteFieldValue,
} from "@/components/dive-site-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { TagsField } from "@/components/tags-field";
import { parseDepthProfile } from "@/lib/depth-profile";
import { toDateTimeLocalValue, trimNumeric } from "@/lib/dive-format";
import type { DiveInput, DiveRecord, RecentCylinder } from "@/lib/dives";
import { computeGasConsumption } from "@/lib/gas-consumption";
import { pickMergeSource } from "@/lib/merge-fields";
import { cn } from "@/lib/utils";

// Radix's Select has no concept of an empty value (an empty-string SelectItem throws), so
// "not recorded" needs its own sentinel that is mapped back to null on submit.
const NONE = "__none__";
const OTHER = "__other__";

// "Drift" = a drift dive: entered from a moving boat and carried by the current rather than
// anchored/fixed to one spot, so it gets its own entry type rather than folding into "Boat".
const ENTRY_TYPES = ["Shore", "Boat", "Liveaboard", "Pier / jetty", "Drift"];
const SUIT_TYPES = [
  "Skin / rash guard",
  "Shorty",
  "Wetsuit 3mm",
  "Wetsuit 5mm",
  "Wetsuit 7mm",
  "Semi-dry",
  "Drysuit",
];
const INTENSITIES = ["None", "Mild", "Moderate", "Strong"];
const WEIGHT_FEEDBACK = ["Underweight", "Perfect", "Overweight"];
const WATER_TYPES = ["Salt", "Fresh", "Brackish"];
const BODIES_OF_WATER = ["Ocean", "Lake", "Quarry", "River"];

type FormState = {
  title: string;
  occurredAt: string;
  site: DiveSiteFieldValue;
  maxDepth: string;
  avgDepth: string;
  bottomTimeMinutes: string;
  waterTemp: string;
  waterTempLow: string;
  airTemp: string;
  visibility: string;
  gasMix: string;
  tankInfo: string;
  cylinderSize: string;
  startPressure: string;
  endPressure: string;
  weight: string;
  weightFeedback: string;
  suitType: string;
  hood: boolean;
  gloves: boolean;
  boots: boolean;
  buddy: string;
  diveShop: string;
  current: string;
  surge: string;
  waves: string;
  weather: string;
  waterType: string;
  bodyOfWater: string;
  bodyOfWaterOther: string;
  entryType: string;
  notes: string;
  rating: number | null;
  depthProfileRaw: string;
  tags: string[];
};

type MergeSource = "import" | "target";

type MergeFieldKey = keyof FormState;

type SuuntoMergeCandidateValues = FormState & {
  depthProfile: unknown;
};

export type MergeCandidate = {
  id: number;
  title: string | null;
  occurredAt: string;
  maxDepth: string | null;
  bottomTimeMinutes: number | null;
  siteName: string | null;
  values: SuuntoMergeCandidateValues;
};

const mergeFields: Array<{ key: MergeFieldKey; label: string }> = [
  { key: "title", label: "Title" },
  { key: "occurredAt", label: "Date & time" },
  { key: "site", label: "Dive site" },
  { key: "maxDepth", label: "Max depth" },
  { key: "avgDepth", label: "Average depth" },
  { key: "bottomTimeMinutes", label: "Bottom time" },
  { key: "waterTemp", label: "Water temp" },
  { key: "waterTempLow", label: "Lowest temp" },
  { key: "airTemp", label: "Air temp" },
  { key: "visibility", label: "Visibility" },
  { key: "gasMix", label: "Gas mix" },
  { key: "tankInfo", label: "Cylinder" },
  { key: "cylinderSize", label: "Cylinder size" },
  { key: "startPressure", label: "Start pressure" },
  { key: "endPressure", label: "End pressure" },
  { key: "weight", label: "Weight" },
  { key: "weightFeedback", label: "Weighting" },
  { key: "suitType", label: "Suit" },
  { key: "hood", label: "Hood" },
  { key: "gloves", label: "Gloves" },
  { key: "boots", label: "Boots" },
  { key: "buddy", label: "Buddy" },
  { key: "diveShop", label: "Dive shop" },
  { key: "current", label: "Current" },
  { key: "surge", label: "Surge" },
  { key: "waves", label: "Waves" },
  { key: "weather", label: "Weather" },
  { key: "waterType", label: "Water type" },
  { key: "bodyOfWater", label: "Body of water" },
  { key: "entryType", label: "Entry type" },
  { key: "notes", label: "Notes" },
  { key: "rating", label: "Rating" },
  { key: "depthProfileRaw", label: "Depth profile" },
];

function blankState(): FormState {
  return {
    title: "",
    occurredAt: toDateTimeLocalValue(new Date()),
    site: emptyDiveSite,
    maxDepth: "",
    avgDepth: "",
    bottomTimeMinutes: "",
    waterTemp: "",
    waterTempLow: "",
    airTemp: "",
    visibility: "",
    gasMix: "",
    tankInfo: "",
    cylinderSize: "",
    startPressure: "",
    endPressure: "",
    weight: "",
    weightFeedback: NONE,
    suitType: NONE,
    hood: false,
    gloves: false,
    boots: false,
    buddy: "",
    diveShop: "",
    current: NONE,
    surge: NONE,
    waves: NONE,
    weather: "",
    waterType: NONE,
    bodyOfWater: NONE,
    bodyOfWaterOther: "",
    entryType: NONE,
    notes: "",
    rating: null,
    depthProfileRaw: "",
    tags: [],
  };
}

function stateFromDive(dive: DiveRecord): FormState {
  const text = (value: string | null) => value ?? "";
  const choice = (value: string | null) => value ?? NONE;
  // A body of water outside the fixed list (typed as free text last time) round-trips through
  // the "Other" option with its value preserved in the text field, rather than being lost.
  const bodyOfWaterChoice =
    dive.body_of_water && !BODIES_OF_WATER.includes(dive.body_of_water) ? OTHER : choice(dive.body_of_water);

  return {
    title: text(dive.title),
    occurredAt: toDateTimeLocalValue(dive.occurred_at),
    site: {
      siteId: dive.dive_site_id,
      name: text(dive.site_name),
      location: text(dive.site_location),
      lat: dive.site_lat === null ? "" : String(dive.site_lat),
      lng: dive.site_lng === null ? "" : String(dive.site_lng),
    },
    // numeric(5,2) arrives from pg as "12.40"; trimNumeric makes it editable as "12.4".
    maxDepth: trimNumeric(dive.max_depth) ?? "",
    avgDepth: trimNumeric(dive.avg_depth) ?? "",
    bottomTimeMinutes: dive.bottom_time_minutes === null ? "" : String(dive.bottom_time_minutes),
    waterTemp: trimNumeric(dive.water_temp) ?? "",
    waterTempLow: trimNumeric(dive.water_temp_low) ?? "",
    airTemp: trimNumeric(dive.air_temp) ?? "",
    visibility: trimNumeric(dive.visibility) ?? "",
    gasMix: text(dive.gas_mix),
    tankInfo: text(dive.tank_info),
    cylinderSize: trimNumeric(dive.cylinder_size) ?? "",
    startPressure: trimNumeric(dive.start_pressure) ?? "",
    endPressure: trimNumeric(dive.end_pressure) ?? "",
    weight: trimNumeric(dive.weight) ?? "",
    weightFeedback: choice(dive.weight_feedback),
    suitType: choice(dive.suit_type),
    hood: dive.hood ?? false,
    gloves: dive.gloves ?? false,
    boots: dive.boots ?? false,
    buddy: text(dive.buddy),
    diveShop: text(dive.dive_shop),
    current: choice(dive.current),
    surge: choice(dive.surge),
    waves: choice(dive.waves),
    weather: text(dive.weather),
    waterType: choice(dive.water_type),
    bodyOfWater: bodyOfWaterChoice,
    bodyOfWaterOther: bodyOfWaterChoice === OTHER ? (dive.body_of_water ?? "") : "",
    entryType: choice(dive.entry_type),
    notes: text(dive.notes),
    rating: dive.rating,
    depthProfileRaw: text(dive.depth_profile_raw),
    tags: dive.tags,
  };
}


function siteStateFromDraft(site: Partial<DiveInput>["site"] | undefined): DiveSiteFieldValue {
  if (!site) return emptyDiveSite;
  if ("id" in site) {
    return { ...emptyDiveSite, siteId: site.id };
  }

  return {
    siteId: null,
    name: site.name ?? "",
    location: site.location ?? "",
    lat: site.lat === null || site.lat === undefined ? "" : String(site.lat),
    lng: site.lng === null || site.lng === undefined ? "" : String(site.lng),
  };
}

function stateFromDraft(draft: Partial<DiveInput>): FormState {
  const state = blankState();

  return {
    ...state,
    title: draft.title ?? state.title,
    occurredAt: draft.occurredAt ? toDateTimeLocalValue(new Date(draft.occurredAt)) : state.occurredAt,
    site: siteStateFromDraft(draft.site),
    maxDepth: draft.maxDepth === null || draft.maxDepth === undefined ? "" : String(draft.maxDepth),
    avgDepth: draft.avgDepth === null || draft.avgDepth === undefined ? "" : String(draft.avgDepth),
    bottomTimeMinutes:
      draft.bottomTimeMinutes === null || draft.bottomTimeMinutes === undefined
        ? ""
        : String(draft.bottomTimeMinutes),
    waterTemp: draft.waterTemp === null || draft.waterTemp === undefined ? "" : String(draft.waterTemp),
    waterTempLow:
      draft.waterTempLow === null || draft.waterTempLow === undefined ? "" : String(draft.waterTempLow),
    airTemp: draft.airTemp === null || draft.airTemp === undefined ? "" : String(draft.airTemp),
    visibility: draft.visibility === null || draft.visibility === undefined ? "" : String(draft.visibility),
    gasMix: draft.gasMix ?? "",
    tankInfo: draft.tankInfo ?? "",
    cylinderSize:
      draft.cylinderSize === null || draft.cylinderSize === undefined ? "" : String(draft.cylinderSize),
    startPressure:
      draft.startPressure === null || draft.startPressure === undefined ? "" : String(draft.startPressure),
    endPressure: draft.endPressure === null || draft.endPressure === undefined ? "" : String(draft.endPressure),
    weight: draft.weight === null || draft.weight === undefined ? "" : String(draft.weight),
    weightFeedback: draft.weightFeedback ?? state.weightFeedback,
    suitType: draft.suitType ?? state.suitType,
    hood: draft.hood ?? state.hood,
    gloves: draft.gloves ?? state.gloves,
    boots: draft.boots ?? state.boots,
    buddy: draft.buddy ?? "",
    diveShop: draft.diveShop ?? "",
    current: draft.current ?? state.current,
    surge: draft.surge ?? state.surge,
    waves: draft.waves ?? state.waves,
    weather: draft.weather ?? "",
    waterType: draft.waterType ?? state.waterType,
    bodyOfWater: draft.bodyOfWater ?? state.bodyOfWater,
    entryType: draft.entryType ?? state.entryType,
    notes: draft.notes ?? "",
    rating: draft.rating ?? state.rating,
    depthProfileRaw: draft.depthProfileRaw ?? "",
    tags: draft.tags ?? state.tags,
  };
}

function optionalText(value: string): string | null {
  return value.trim() || null;
}

function optionalChoice(value: string): string | null {
  return value === NONE ? null : value;
}

function optionalNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

// "Other" resolves to whatever was typed in the paired free-text field -- covers any body of
// water the fixed list doesn't name (per the TODO: "other(open text)").
function resolveBodyOfWater(state: FormState): string | null {
  if (state.bodyOfWater === OTHER) return optionalText(state.bodyOfWaterOther);
  return optionalChoice(state.bodyOfWater);
}

function RatingField({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (next: number | null) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-sm leading-none font-medium">Rating</legend>
      <div role="radiogroup" aria-label="Rating" className="flex items-center gap-1 pt-1">
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            type="button"
            role="radio"
            aria-checked={value === star}
            aria-label={`${star} ${star === 1 ? "star" : "stars"}`}
            // Clicking the current rating clears it -- otherwise a mis-click could never be undone
            // back to "unrated".
            onClick={() => onChange(value === star ? null : star)}
            className="rounded-sm p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          >
            <Star
              className={cn(
                "size-5 transition-colors",
                value !== null && star <= value
                  ? "fill-foreground text-foreground"
                  : "text-muted-foreground/50",
              )}
            />
          </button>
        ))}
        <span className="ml-2 text-xs text-muted-foreground">
          {value === null ? "Not rated" : `${value}/5`}
        </span>
      </div>
    </fieldset>
  );
}

function Field({
  id,
  label,
  hint,
  children,
  className,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

type ChoiceOption = string | { value: string; label: string };

function ChoiceField({
  id,
  label,
  value,
  options,
  placeholder,
  onChange,
  warnUnrecognized,
}: {
  id: string;
  label: string;
  value: string;
  options: ChoiceOption[];
  placeholder: string;
  onChange: (next: string) => void;
  // Set for fields where import (PADI, or any future source) can store a value outside this
  // dropdown's own vocabulary -- e.g. a PADI enum code with no entry in lib/padi/field-map.ts's
  // reverse map (issue #20). A value that isn't one of `options`, isn't NONE, and isn't blank is
  // shown as-is with a warning instead of silently blanking the selector.
  warnUnrecognized?: boolean;
}) {
  const warningId = `${id}-unrecognized-warning`;
  const isUnrecognized =
    warnUnrecognized &&
    value !== NONE &&
    value !== "" &&
    !options.some((option) => (typeof option === "string" ? option : option.value) === value);

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} aria-label={label} aria-describedby={isUnrecognized ? warningId : undefined}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Not recorded</SelectItem>
          {isUnrecognized ? <SelectItem value={value}>{value}</SelectItem> : null}
          {options.map((option) => {
            const { value: optionValue, label: optionLabel } =
              typeof option === "string" ? { value: option, label: option } : option;

            return (
              <SelectItem key={optionValue} value={optionValue}>
                {optionLabel}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      {isUnrecognized ? (
        <p id={warningId} className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Unrecognized value, shown as-is
        </p>
      ) : null}
    </div>
  );
}

function formatCylinderOption(option: RecentCylinder): string {
  const size = option.cylinderSize ? `${trimNumeric(option.cylinderSize)} L` : null;
  return [option.tankInfo, size].filter(Boolean).join(" · ") || "—";
}

function formatCandidate(candidate: MergeCandidate): string {
  const date = new Date(candidate.occurredAt);
  const when = Number.isFinite(date.getTime()) ? date.toLocaleString() : candidate.occurredAt;
  const details = [
    candidate.siteName,
    candidate.maxDepth ? `${trimNumeric(candidate.maxDepth)} m` : null,
    candidate.bottomTimeMinutes === null ? null : `${candidate.bottomTimeMinutes} min`,
  ].filter(Boolean);

  return `${when}${details.length ? ` · ${details.join(" · ")}` : ""}`;
}

function formatMergeValue(value: FormState[MergeFieldKey]): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (value === null) return "--";
  if (typeof value === "string") return value === NONE ? "--" : value.trim() || "--";

  const site = value as DiveSiteFieldValue;
  return [site.name, site.location, site.lat && site.lng ? `${site.lat}, ${site.lng}` : null]
    .filter(Boolean)
    .join(" · ") || "--";
}

const PRECISION_MERGE_FIELDS = new Set<MergeFieldKey>([
  "maxDepth",
  "avgDepth",
  "waterTemp",
  "waterTempLow",
  "airTemp",
  "visibility",
  "cylinderSize",
  "startPressure",
  "endPressure",
  "weight",
]);

function computeSmartMergeChoices(
  imported: FormState,
  target: SuuntoMergeCandidateValues,
): Record<MergeFieldKey, MergeSource> {
  return Object.fromEntries(
    mergeFields.map((field) => [
      field.key,
      pickMergeSource(imported[field.key], target[field.key], {
        emptyChoiceValue: NONE,
        comparePrecision: PRECISION_MERGE_FIELDS.has(field.key),
      }),
    ]),
  ) as Record<MergeFieldKey, MergeSource>;
}

function mergeStates(
  imported: FormState,
  target: SuuntoMergeCandidateValues,
  choices: Record<MergeFieldKey, MergeSource>,
): FormState {
  const merged = { ...imported };
  for (const field of mergeFields) {
    if (choices[field.key] === "target") {
      merged[field.key] = target[field.key] as never;
    }
  }
  // Not one of mergeFields: a reviewed Suunto import never carries tags, so there is nothing to
  // choose between -- the target dive's own tags always survive the merge instead of being wiped.
  merged.tags = target.tags;
  return merged;
}

// Optional convenience, not a bound form field -- deliberately uncontrolled, so after a pick the
// trigger just shows that option's own label rather than needing to reset back to a placeholder.
function RecentCylinderPicker({
  onPick,
}: {
  onPick: (option: RecentCylinder) => void;
}) {
  const [options, setOptions] = useState<RecentCylinder[] | null>(null);

  useEffect(() => {
    let cancelled = false;

    recentCylindersAction()
      .then((result) => {
        if (!cancelled) setOptions(result);
      })
      .catch(() => {
        if (!cancelled) setOptions([]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!options || options.length === 0) return null;

  return (
    <div className="flex items-center gap-2">
      <Select
        onValueChange={(index) => {
          const option = options[Number(index)];
          if (option) onPick(option);
        }}
      >
        <SelectTrigger aria-label="Use a recent cylinder" className="h-8 w-auto text-xs">
          <SelectValue placeholder="Use a recent cylinder" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option, index) => (
            <SelectItem key={index} value={String(index)}>
              {formatCylinderOption(option)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function CheckField({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="group/field flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(next) => onChange(next === true)} />
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
    </div>
  );
}

export function DiveForm({
  dive,
  draftDive,
  suuntoImportId,
  suuntoMergeCandidates = [],
  garminImportId,
  garminMergeCandidates = [],
  cancelHref,
  submitLabel,
}: {
  dive?: DiveRecord;
  draftDive?: Partial<DiveInput>;
  suuntoImportId?: number;
  suuntoMergeCandidates?: MergeCandidate[];
  garminImportId?: number;
  garminMergeCandidates?: MergeCandidate[];
  cancelHref?: string;
  submitLabel?: string;
}) {
  const router = useRouter();
  const initialDepthProfile = dive?.depth_profile ?? draftDive?.depthProfile ?? null;
  const [state, setState] = useState<FormState>(() =>
    dive ? stateFromDive(dive) : draftDive ? stateFromDraft(draftDive) : blankState(),
  );
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeStep, setMergeStep] = useState<"target" | "fields">("target");
  const initialMergeTargetId = suuntoImportId !== undefined ? suuntoMergeCandidates[0]?.id : garminImportId !== undefined ? garminMergeCandidates[0]?.id : null;
  const [mergeTargetId, setMergeTargetId] = useState<number | null>(initialMergeTargetId ?? null);
  const activeMergeCandidates = suuntoImportId !== undefined ? suuntoMergeCandidates : garminMergeCandidates;
  const [mergeChoices, setMergeChoices] = useState<Record<MergeFieldKey, MergeSource>>(() =>
    Object.fromEntries(mergeFields.map((field) => [field.key, "import"])) as Record<MergeFieldKey, MergeSource>,
  );
  const [isPending, startTransition] = useTransition();
  const neutralPlaceholder = (example: string) => (dive ? "--" : example);
  const selectedMergeTarget = activeMergeCandidates.find((candidate) => candidate.id === mergeTargetId) ?? null;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setState((previous) => ({ ...previous, [key]: value }));

  // Parsed on every keystroke so the error (and the preview chart) track the textarea live, and so
  // `canSubmit` below can refuse a malformed profile before the action is ever called.
  const profileResult = useMemo(
    () => (state.depthProfileRaw.trim() ? parseDepthProfile(state.depthProfileRaw) : null),
    [state.depthProfileRaw],
  );

  // Live preview only -- the rate itself is never stored, it's re-derived from the stored
  // pressures/cylinder/depth/time every time it's shown (form and detail page alike).
  const gasConsumption = useMemo(
    () =>
      computeGasConsumption({
        startPressure: optionalNumber(state.startPressure),
        endPressure: optionalNumber(state.endPressure),
        cylinderSize: optionalNumber(state.cylinderSize),
        avgDepth: optionalNumber(state.avgDepth),
        bottomTimeMinutes: optionalNumber(state.bottomTimeMinutes),
      }),
    [state.startPressure, state.endPressure, state.cylinderSize, state.avgDepth, state.bottomTimeMinutes],
  );

  const profileIsInvalid = profileResult !== null && !profileResult.ok;
  const canSubmit = Boolean(state.occurredAt) && !profileIsInvalid && !isPending;

  function validateProfile() {
    // Belt and braces: submit/merge buttons are already disabled in this state, but keyboard Enter
    // and dialog buttons must not slip past it. A malformed profile never reaches the server, so
    // `depth_profile` is never partially written.
    if (!profileIsInvalid) return true;
    toast.error(profileResult.error);
    return false;
  }

  function buildInputFromState(source: FormState, fallbackDepthProfile: unknown): DiveInput {
    const sourceProfileResult = source.depthProfileRaw.trim() ? parseDepthProfile(source.depthProfileRaw) : null;

    return {
      site: toSiteSelection(source.site),
      title: optionalText(source.title),
      occurredAt: new Date(source.occurredAt),
      maxDepth: optionalNumber(source.maxDepth),
      avgDepth: optionalNumber(source.avgDepth),
      bottomTimeMinutes: optionalNumber(source.bottomTimeMinutes),
      waterTemp: optionalNumber(source.waterTemp),
      waterTempLow: optionalNumber(source.waterTempLow),
      airTemp: optionalNumber(source.airTemp),
      visibility: optionalNumber(source.visibility),
      gasMix: optionalText(source.gasMix),
      tankInfo: optionalText(source.tankInfo),
      cylinderSize: optionalNumber(source.cylinderSize),
      startPressure: optionalNumber(source.startPressure),
      endPressure: optionalNumber(source.endPressure),
      weight: optionalNumber(source.weight),
      weightFeedback: optionalChoice(source.weightFeedback),
      suitType: optionalChoice(source.suitType),
      hood: source.hood,
      gloves: source.gloves,
      boots: source.boots,
      buddy: optionalText(source.buddy),
      diveShop: optionalText(source.diveShop),
      current: optionalChoice(source.current),
      surge: optionalChoice(source.surge),
      waves: optionalChoice(source.waves),
      weather: optionalText(source.weather),
      waterType: optionalChoice(source.waterType),
      bodyOfWater: resolveBodyOfWater(source),
      entryType: optionalChoice(source.entryType),
      notes: optionalText(source.notes),
      rating: source.rating,
      depthProfile: sourceProfileResult?.ok
        ? sourceProfileResult.points
        : source.depthProfileRaw.trim()
          ? null
          : fallbackDepthProfile,
      depthProfileRaw: optionalText(source.depthProfileRaw),
      tags: source.tags,
    };
  }

  function buildInput(): DiveInput {
    return buildInputFromState(state, initialDepthProfile);
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validateProfile()) return;

    const input = buildInput();

    startTransition(async () => {
      const result =
        suuntoImportId !== undefined
          ? await createSuuntoDiveImportAction(suuntoImportId, input)
          : garminImportId !== undefined
            ? await createGarminDiveImportAction(garminImportId, input)
          : dive
            ? await updateDiveAction(dive.id, input)
            : await createDiveAction(input);

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      toast.success(suuntoImportId !== undefined ? "Suunto dive saved." : garminImportId !== undefined ? "Garmin dive saved." : dive ? "Dive updated." : "Dive logged.");
      // refresh() must come BEFORE push(): it invalidates the client Router Cache, so the
      // navigation that follows is forced to fetch fresh data instead of serving a snapshot of
      // this route already cached from earlier in the session (push-then-refresh raced on this --
      // push could resolve from the stale cache before refresh got a chance to invalidate it).
      router.refresh();
      if (garminImportId !== undefined && "nextImportId" in result && result.nextImportId !== null) {
        router.push(`/settings/integrations/garmin/imports/${result.nextImportId}`);
        return;
      }
      if (suuntoImportId !== undefined && "nextImportId" in result && result.nextImportId !== null) {
        router.push(`/settings/integrations/suunto/imports/${result.nextImportId}`);
      } else {
        router.push(`/dives/${result.id}`);
      }
    });
  }

  function mergeIntoExistingDive() {
    if ((suuntoImportId === undefined && garminImportId === undefined) || mergeTargetId === null) return;
    if (!validateProfile()) return;

    const target = activeMergeCandidates.find((candidate) => candidate.id === mergeTargetId);
    if (!target) return;

    const mergedState = mergeStates(state, target.values, mergeChoices);
    const input = buildInputFromState(
      mergedState,
      mergeChoices.depthProfileRaw === "target" ? target.values.depthProfile : initialDepthProfile,
    );

    startTransition(async () => {
      const result = suuntoImportId !== undefined
          ? await mergeSuuntoDiveImportAction(suuntoImportId, mergeTargetId, input)
          : await mergeGarminDiveImportAction(garminImportId!, mergeTargetId!, input);

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      toast.success("Suunto dive merged into existing dive.");
      setMergeOpen(false);
      setMergeStep("target");
      router.refresh();
      if ("nextImportId" in result && result.nextImportId !== null) {
        if (garminImportId !== undefined) {
          router.push(`/settings/integrations/garmin/imports/${result.nextImportId}`);
        } else {
          router.push(`/settings/integrations/suunto/imports/${result.nextImportId}`);
        }
      } else {
        router.push(`/dives/${result.id}`);
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>When &amp; where</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <Field id="title" label="Title" hint="Optional -- defaults to the site name and date.">
            <Input
              id="title"
              placeholder={neutralPlaceholder("Night dive with the reef sharks")}
              value={state.title}
              onChange={(event) => set("title", event.target.value)}
            />
          </Field>

          <Field id="occurredAt" label="Date & time">
            <Input
              id="occurredAt"
              type="datetime-local"
              required
              value={state.occurredAt}
              onChange={(event) => set("occurredAt", event.target.value)}
            />
          </Field>

          <DiveSiteField value={state.site} onChange={(next) => set("site", next)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <Field id="maxDepth" label="Max depth (m)">
            <Input
              id="maxDepth"
              inputMode="decimal"
              placeholder={neutralPlaceholder("27.4")}
              value={state.maxDepth}
              onChange={(event) => set("maxDepth", event.target.value)}
            />
          </Field>
          <Field id="avgDepth" label="Average depth (m)">
            <Input
              id="avgDepth"
              inputMode="decimal"
              placeholder={neutralPlaceholder("14.8")}
              value={state.avgDepth}
              onChange={(event) => set("avgDepth", event.target.value)}
            />
          </Field>
          <Field id="bottomTimeMinutes" label="Bottom time (min)">
            <Input
              id="bottomTimeMinutes"
              inputMode="numeric"
              placeholder={neutralPlaceholder("48")}
              value={state.bottomTimeMinutes}
              onChange={(event) => set("bottomTimeMinutes", event.target.value)}
            />
          </Field>
          <Field id="waterTemp" label="Water temp — surface (°C)">
            <Input
              id="waterTemp"
              inputMode="decimal"
              placeholder={neutralPlaceholder("24.5")}
              value={state.waterTemp}
              onChange={(event) => set("waterTemp", event.target.value)}
            />
          </Field>
          <Field id="waterTempLow" label="Water temp — lowest (°C)">
            <Input
              id="waterTempLow"
              inputMode="decimal"
              placeholder={neutralPlaceholder("21.0")}
              value={state.waterTempLow}
              onChange={(event) => set("waterTempLow", event.target.value)}
            />
          </Field>
          <Field id="visibility" label="Visibility (m)">
            <Input
              id="visibility"
              inputMode="decimal"
              placeholder={neutralPlaceholder("18")}
              value={state.visibility}
              onChange={(event) => set("visibility", event.target.value)}
            />
          </Field>
          <ChoiceField
            id="entryType"
            label="Entry type"
            value={state.entryType}
            options={ENTRY_TYPES}
            placeholder="Not recorded"
            onChange={(next) => set("entryType", next)}
            warnUnrecognized
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Gear &amp; gas</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <Field id="gasMix" label="Gas mix">
              <Input
                id="gasMix"
                placeholder={neutralPlaceholder("EAN32")}
                value={state.gasMix}
                onChange={(event) => set("gasMix", event.target.value)}
              />
            </Field>
            <Field id="tankInfo" label="Cylinder">
              <Input
                id="tankInfo"
                placeholder={neutralPlaceholder("12L steel, 200 bar")}
                value={state.tankInfo}
                onChange={(event) => set("tankInfo", event.target.value)}
              />
            </Field>
            <Field id="cylinderSize" label="Cylinder size (L)">
              <Input
                id="cylinderSize"
                inputMode="decimal"
                placeholder={neutralPlaceholder("12")}
                value={state.cylinderSize}
                onChange={(event) => set("cylinderSize", event.target.value)}
              />
            </Field>
            <div className="flex flex-col justify-end gap-1.5 sm:col-span-2 lg:col-span-1">
              <RecentCylinderPicker
                onPick={(option) => {
                  setState((previous) => ({
                    ...previous,
                    tankInfo: option.tankInfo ?? previous.tankInfo,
                    cylinderSize: trimNumeric(option.cylinderSize) ?? previous.cylinderSize,
                  }));
                }}
              />
            </div>
            <Field id="startPressure" label="Start pressure (bar)">
              <Input
                id="startPressure"
                inputMode="decimal"
                placeholder={neutralPlaceholder("200")}
                value={state.startPressure}
                onChange={(event) => set("startPressure", event.target.value)}
              />
            </Field>
            <Field id="endPressure" label="End pressure (bar)">
              <Input
                id="endPressure"
                inputMode="decimal"
                placeholder={neutralPlaceholder("50")}
                value={state.endPressure}
                onChange={(event) => set("endPressure", event.target.value)}
              />
            </Field>
            <Field id="weight" label="Weight (kg)">
              <Input
                id="weight"
                inputMode="decimal"
                placeholder={neutralPlaceholder("6")}
                value={state.weight}
                onChange={(event) => set("weight", event.target.value)}
              />
            </Field>
            <ChoiceField
              id="weightFeedback"
              label="Weighting"
              value={state.weightFeedback}
              options={WEIGHT_FEEDBACK}
              placeholder="Not recorded"
              onChange={(next) => set("weightFeedback", next)}
              warnUnrecognized
            />
            <ChoiceField
              id="suitType"
              label="Suit"
              value={state.suitType}
              options={SUIT_TYPES}
              placeholder="Not recorded"
              onChange={(next) => set("suitType", next)}
              warnUnrecognized
            />
          </div>

          {gasConsumption ? (
            <p className="text-xs text-muted-foreground" data-testid="gas-consumption-preview">
              {gasConsumption.gasUsedLiters.toFixed(0)} L / {gasConsumption.startLiters.toFixed(0)} L used
              · SAC rate {gasConsumption.sacRateLitersPerMin.toFixed(1)} L/min
            </p>
          ) : null}

          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <CheckField id="hood" label="Hood" checked={state.hood} onChange={(next) => set("hood", next)} />
            <CheckField
              id="gloves"
              label="Gloves"
              checked={state.gloves}
              onChange={(next) => set("gloves", next)}
            />
            <CheckField id="boots" label="Boots" checked={state.boots} onChange={(next) => set("boots", next)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Conditions &amp; company</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <ChoiceField
            id="current"
            label="Current"
            value={state.current}
            options={INTENSITIES}
            placeholder="Not recorded"
            onChange={(next) => set("current", next)}
            warnUnrecognized
          />
          <ChoiceField
            id="surge"
            label="Surge"
            value={state.surge}
            options={INTENSITIES}
            placeholder="Not recorded"
            onChange={(next) => set("surge", next)}
            warnUnrecognized
          />
          <ChoiceField
            id="waves"
            label="Waves"
            value={state.waves}
            options={INTENSITIES}
            placeholder="Not recorded"
            onChange={(next) => set("waves", next)}
            warnUnrecognized
          />
          <Field id="weather" label="Weather">
            <Input
              id="weather"
              placeholder={neutralPlaceholder("Sunny, light chop")}
              value={state.weather}
              onChange={(event) => set("weather", event.target.value)}
            />
          </Field>
          <Field id="airTemp" label="Air temp (°C)">
            <Input
              id="airTemp"
              inputMode="decimal"
              placeholder={neutralPlaceholder("29")}
              value={state.airTemp}
              onChange={(event) => set("airTemp", event.target.value)}
            />
          </Field>
          <ChoiceField
            id="waterType"
            label="Water type"
            value={state.waterType}
            options={WATER_TYPES}
            placeholder="Not recorded"
            onChange={(next) => set("waterType", next)}
          />
          <ChoiceField
            id="bodyOfWater"
            label="Body of water"
            value={state.bodyOfWater}
            options={[...BODIES_OF_WATER, { value: OTHER, label: "Other" }]}
            placeholder="Not recorded"
            onChange={(next) => set("bodyOfWater", next)}
          />
          {state.bodyOfWater === OTHER ? (
            <Field id="bodyOfWaterOther" label="Body of water — other">
              <Input
                id="bodyOfWaterOther"
                placeholder={neutralPlaceholder("Cenote")}
                value={state.bodyOfWaterOther}
                onChange={(event) => set("bodyOfWaterOther", event.target.value)}
              />
            </Field>
          ) : null}
          <Field id="buddy" label="Buddy / dive guide">
            <Input
              id="buddy"
              placeholder={neutralPlaceholder("Sam Okafor")}
              value={state.buddy}
              onChange={(event) => set("buddy", event.target.value)}
            />
          </Field>
          <Field id="diveShop" label="Dive shop / operator">
            <Input
              id="diveShop"
              placeholder={neutralPlaceholder("Blue Hole Divers")}
              value={state.diveShop}
              onChange={(event) => set("diveShop", event.target.value)}
            />
          </Field>
          <RatingField value={state.rating} onChange={(next) => set("rating", next)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Log</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <Field id="notes" label="Notes">
            <Textarea
              id="notes"
              rows={4}
              placeholder={neutralPlaceholder("Turtles on the shallow shelf, thermocline at 18m.")}
              value={state.notes}
              onChange={(event) => set("notes", event.target.value)}
            />
          </Field>

          <TagsField value={state.tags} onChange={(next) => set("tags", next)} />

          <DepthProfileField
            value={state.depthProfileRaw}
            onChange={(next) => set("depthProfileRaw", next)}
            result={profileResult}
            placeholder={neutralPlaceholder("Paste CSV or UDDF, e.g.\n0:00, 0\n3:00, 12.4\n18:00, 27.1")}
          />
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!canSubmit}>
          {isPending ? <Loader2 className="animate-spin" /> : <Save />}
          {submitLabel ?? (dive ? "Save changes" : "Log dive")}
        </Button>
        {(suuntoImportId !== undefined || garminImportId !== undefined) && activeMergeCandidates.length > 0 ? (
          <Button
            type="button"
            variant="outline"
            disabled={!canSubmit}
            onClick={() => {
              setMergeStep("target");
              setMergeOpen(true);
            }}
          >
            <GitMerge />
            Merge into existing dive
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          disabled={isPending}
          onClick={() => router.push(cancelHref ?? (dive ? `/dives/${dive.id}` : "/dives"))}
        >
          Cancel
        </Button>
      </div>

      <Dialog
        open={mergeOpen}
        onOpenChange={(open) => {
          if (isPending) return;
          setMergeOpen(open);
          if (!open) setMergeStep("target");
        }}
      >
        <DialogContent className={mergeStep === "fields" ? "max-w-4xl" : "max-w-2xl"}>
          {mergeStep === "target" ? (
            <>
              <DialogHeader>
                <DialogTitle>Merge Suunto import into existing dive</DialogTitle>
                <DialogDescription>
                  Pick the existing dive to update. You will choose which fields survive on the next step.
                </DialogDescription>
              </DialogHeader>

              <div className="flex max-h-[30rem] flex-col gap-3 overflow-y-auto pr-1">
                {activeMergeCandidates.map((candidate, index) => (
                  <label key={candidate.id} className="flex cursor-pointer gap-3 rounded-md border p-3 text-sm">
                    <input
                      type="radio"
                      name="import-merge-target"
                      checked={mergeTargetId === candidate.id}
                      onChange={() => setMergeTargetId(candidate.id)}
                      disabled={isPending}
                    />
                    <span className="flex flex-col gap-1">
                      <span className="font-medium">
                        {candidate.title || candidate.siteName || `Dive #${candidate.id}`}
                        {index === 0 ? <span className="ml-2 text-xs text-muted-foreground">closest by date</span> : null}
                      </span>
                      <span className="text-xs text-muted-foreground">{formatCandidate(candidate)}</span>
                    </span>
                  </label>
                ))}
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" disabled={isPending} onClick={() => setMergeOpen(false)}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  disabled={!canSubmit || selectedMergeTarget === null}
                  onClick={() => {
                    if (selectedMergeTarget) {
                      setMergeChoices(computeSmartMergeChoices(state, selectedMergeTarget.values));
                    }
                    setMergeStep("fields");
                  }}
                >
                  Choose surviving fields
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Choose surviving fields</DialogTitle>
                <DialogDescription>
                  For each property, choose whether the reviewed Suunto import or the existing dive value should be
                  kept. The Suunto workout id, chart data, and original bundle will be attached to the selected dive.
                </DialogDescription>
              </DialogHeader>

              {selectedMergeTarget ? (
                <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto pr-1">
                  <div className="rounded-md border bg-muted/30 p-3 text-sm">
                    Merging into{" "}
                    <span className="font-medium">
                      {selectedMergeTarget.title || selectedMergeTarget.siteName || `Dive #${selectedMergeTarget.id}`}
                    </span>
                    <span className="block text-xs text-muted-foreground">{formatCandidate(selectedMergeTarget)}</span>
                  </div>

                  <div className="rounded-md border">
                    <div className="grid grid-cols-[8rem_1fr_1fr] border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
                      <span>Property</span>
                      <span>Reviewed Suunto import</span>
                      <span>Existing dive</span>
                    </div>
                    {mergeFields.map((field) => (
                      <div
                        key={field.key}
                        className="grid grid-cols-[8rem_1fr_1fr] items-center gap-2 border-b px-3 py-2 last:border-b-0"
                      >
                        <span className="text-xs font-medium">{field.label}</span>
                        <label className="flex min-w-0 cursor-pointer items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name={`import-merge-${field.key}`}
                            checked={mergeChoices[field.key] === "import"}
                            onChange={() => setMergeChoices((current) => ({ ...current, [field.key]: "import" }))}
                            disabled={isPending}
                          />
                          <span className="truncate">{formatMergeValue(state[field.key])}</span>
                        </label>
                        <label className="flex min-w-0 cursor-pointer items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name={`import-merge-${field.key}`}
                            checked={mergeChoices[field.key] === "target"}
                            onChange={() => setMergeChoices((current) => ({ ...current, [field.key]: "target" }))}
                            disabled={isPending}
                          />
                          <span className="truncate">{formatMergeValue(selectedMergeTarget.values[field.key])}</span>
                        </label>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <DialogFooter>
                <Button type="button" variant="outline" disabled={isPending} onClick={() => setMergeStep("target")}>
                  Back
                </Button>
                <Button type="button" disabled={!canSubmit || selectedMergeTarget === null} onClick={mergeIntoExistingDive}>
                  {isPending ? <Loader2 className="animate-spin" /> : null}
                  Merge selected fields
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </form>
  );
}
