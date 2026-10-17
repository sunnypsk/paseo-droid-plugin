import { z } from "zod";
import type { UsageBalance, UsageDetail, UsageReport, UsageWindow } from "@getpaseo/plugin/server/usage";

// Validate individual windows below: a missing/malformed Core bucket must not
// discard a valid Standard quota, and absence never means zero consumption.
export const factoryQuotaSchema = z.object({
  limits: z.object({ standard: z.unknown().optional(), core: z.unknown().optional() }).nullable().optional(),
  extraUsageBalanceCents: z.unknown().optional(),
  overagePreference: z.unknown().optional(),
  extraUsageAllowed: z.unknown().optional(),
  canManageOverage: z.unknown().optional(),
  planLabel: z.unknown().optional(),
});

const bucketSchema = z.object({
  fiveHour: z.unknown().optional(), weekly: z.unknown().optional(), monthly: z.unknown().optional(),
});
const windowSchema = z.object({
  usedPercent: z.number().finite().nonnegative(),
  windowEnd: z.string().nullable().optional(),
});
const isoTimestampSchema = z.iso.datetime({ offset: true });
const periods = [
  { key: "fiveHour", id: "five-hour", label: "5-hour", shortLabel: "5h" },
  { key: "weekly", id: "weekly", label: "Weekly", shortLabel: "wk" },
  // The API calls this monthly. Do not infer a calendar month or derive a
  // window length from secondsRemaining, which is only a reset countdown.
  { key: "monthly", id: "monthly", label: "Monthly", shortLabel: "mo" },
] as const;
const scopes = [
  { key: "standard", label: "Standard", shortLabel: "Std", summary: true },
  { key: "core", label: "Core", shortLabel: "Core", summary: false },
] as const;

function tone(usedPct: number): UsageWindow["tone"] {
  return usedPct > 90 ? "danger" : usedPct >= 70 ? "warning" : "ok";
}

/** Convert the read-only Factory /api/billing/limits response, without credentials or I/O. */
export function parseFactoryQuota(input: unknown, nowMs = Date.now()): UsageReport {
  if (!Number.isFinite(nowMs)) return { status: "error", error: "Cannot determine whether Factory quota windows are current." };
  const parsed = factoryQuotaSchema.safeParse(input);
  if (!parsed.success) return { status: "error", error: "Factory returned an invalid quota response." };
  const data = parsed.data;
  const windows: UsageWindow[] = [];
  const balances: UsageBalance[] = [];
  const details: UsageDetail[] = [];
  let stale = 0;
  let invalid = 0;

  for (const scope of scopes) {
    const rawBucket = data.limits?.[scope.key];
    if (rawBucket === undefined || rawBucket === null) continue;
    const bucket = bucketSchema.safeParse(rawBucket);
    if (!bucket.success) { invalid++; continue; }
    for (const period of periods) {
      const rawWindow = bucket.data[period.key];
      if (rawWindow === undefined || rawWindow === null) continue;
      const parsedWindow = windowSchema.safeParse(rawWindow);
      if (!parsedWindow.success) { invalid++; continue; }
      const reported = parsedWindow.data;
      let resetsAt: string | undefined;
      if (reported.windowEnd !== undefined && reported.windowEnd !== null) {
        const timestamp = isoTimestampSchema.safeParse(reported.windowEnd);
        const resetMs = timestamp.success ? Date.parse(timestamp.data) : NaN;
        if (!Number.isFinite(resetMs)) { invalid++; continue; }
        if (resetMs <= nowMs) { stale++; continue; }
        resetsAt = new Date(resetMs).toISOString();
      } else if (reported.usedPercent !== 0) {
        // The native CLI treats missing/null ends as unstarted or expired. A
        // positive percentage then cannot establish a current quota window.
        stale++;
        continue;
      }
      // Preserve a reported overage above 100%; only the remaining portion is
      // clamped. Negative/non-numeric usage is rejected rather than shown as 0.
      windows.push({
        id: `${scope.key}-${period.id}`,
        label: `${scope.label} · ${period.label}`,
        shortLabel: `${scope.shortLabel} ${period.shortLabel}`,
        ...(scope.summary ? { summary: true } : {}),
        usedPct: reported.usedPercent,
        remainingPct: Math.max(0, 100 - reported.usedPercent),
        ...(resetsAt === undefined ? {} : { resetsAt }),
        tone: tone(reported.usedPercent),
      });
    }
  }

  // Paseo's default bars display usedPct. Also expose the remaining portions
  // explicitly without changing the user's global used/remaining preference.
  const percent = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
  for (const scope of scopes) {
    const remaining = periods.flatMap((period) => {
      const window = windows.find((entry) => entry.id === `${scope.key}-${period.id}`);
      return typeof window?.remainingPct === "number" ? [`${period.label} ${percent.format(window.remainingPct)}%`] : [];
    });
    if (remaining.length) details.push({ id: `${scope.key}-remaining`, label: `${scope.label} remaining`, value: remaining.join(" · ") });
  }

  const cents = data.extraUsageBalanceCents;
  if (typeof cents === "number" && Number.isFinite(cents) && cents >= 0 && cents <= Number.MAX_SAFE_INTEGER) {
    balances.push({
      id: "extra-usage", label: "Extra usage balance", remaining: cents / 100, unit: "usd",
      tone: cents === 0 ? "danger" : "ok",
    });
  } else if (cents !== undefined && cents !== null) invalid++;

  if (typeof data.overagePreference === "string" && data.overagePreference.trim())
    details.push({ id: "overage-preference", label: "Overage preference", value: data.overagePreference === "droidCore" ? "Droid Core" : data.overagePreference });
  if (typeof data.extraUsageAllowed === "boolean")
    details.push({ id: "extra-usage-allowed", label: "Extra usage allowed", value: data.extraUsageAllowed ? "Yes" : "No" });
  if (typeof data.canManageOverage === "boolean")
    details.push({ id: "can-manage-overage", label: "Can manage extra usage", value: data.canManageOverage ? "Yes" : "No" });
  if (stale > 0)
    details.push({ id: "quota-awaiting-refresh", label: "Quota refresh", value: "Factory has not reported current data for every quota window. Expired or inactive usage is omitted." });
  if (invalid > 0)
    details.push({ id: "quota-incomplete", label: "Quota data", value: "Some Factory quota data is missing or invalid and could not be displayed." });

  if (windows.length === 0 && balances.length === 0) return {
    status: "unavailable",
    problem: {
      kind: "no_quota",
      detail: stale > 0
        ? "Factory reported no current quota windows. Expired or inactive data cannot establish remaining account quota."
        : "Factory did not report Standard or Core quota percentages or an extra-usage balance. Account quota is unavailable for this billing response.",
    },
  };
  if (windows.length === 0)
    details.unshift({ id: "quota-unreported", label: "Account quota", value: "Factory did not report current subscription quota percentages. Only the reported extra-usage balance is available." });

  const planLabel = typeof data.planLabel === "string" && data.planLabel.trim() ? data.planLabel.trim() : undefined;
  return {
    status: "available", windows,
    ...(planLabel === undefined ? {} : { planLabel }),
    ...(balances.length === 0 ? {} : { balances }),
    ...(details.length === 0 ? {} : { details }),
  };
}
