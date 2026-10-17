import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFactoryQuota, factoryQuotaSchema } from "./quota";

const now = Date.parse("2026-10-17T08:34:02.311Z");
const future = "2026-10-24T06:26:50.784Z";

// Sanitized shape and numeric quota values observed from a real read-only
// Factory billing response. No account identifiers or credentials are stored.
function observed() {
  return {
    limits: {
      standard: {
        fiveHour: { usedPercent: 3, windowEnd: "2026-10-17T09:33:06.215Z", secondsRemaining: 3544 },
        weekly: { usedPercent: 39, windowEnd: "2026-10-19T04:39:23.857Z", secondsRemaining: 158722 },
        monthly: { usedPercent: 37, windowEnd: future, secondsRemaining: 597169 },
      },
      core: {
        fiveHour: { usedPercent: 0, windowEnd: null, secondsRemaining: null },
        weekly: { usedPercent: 0, windowEnd: null, secondsRemaining: null },
        monthly: { usedPercent: 22, windowEnd: "2026-10-30T03:35:38.420Z", secondsRemaining: 1105297 },
      },
    },
    overagePreference: "droidCore", canManageOverage: true,
    extraUsageBalanceCents: 0, extraUsageAllowed: true,
  };
}

test("real Factory quota shape preserves Standard/Core periods, percentages and explicit zero values", () => {
  assert.equal(factoryQuotaSchema.safeParse(observed()).success, true);
  const report = parseFactoryQuota(observed(), now);
  assert.equal(report.status, "available");
  if (report.status !== "available") throw new Error("Expected quota report");
  assert.deepEqual(report.windows.map(({ id, usedPct, remainingPct, summary }) => ({ id, usedPct, remainingPct, summary })), [
    { id: "standard-five-hour", usedPct: 3, remainingPct: 97, summary: true },
    { id: "standard-weekly", usedPct: 39, remainingPct: 61, summary: true },
    { id: "standard-monthly", usedPct: 37, remainingPct: 63, summary: true },
    { id: "core-five-hour", usedPct: 0, remainingPct: 100, summary: undefined },
    { id: "core-weekly", usedPct: 0, remainingPct: 100, summary: undefined },
    { id: "core-monthly", usedPct: 22, remainingPct: 78, summary: undefined },
  ]);
  assert.equal(report.planLabel, undefined, "An overage preference does not establish a subscription plan");
  assert.deepEqual(report.balances, [{ id: "extra-usage", label: "Extra usage balance", remaining: 0, unit: "usd", tone: "danger" }]);
  assert.equal(report.windows.find((window) => window.id === "core-five-hour")?.resetsAt, undefined);
  assert.equal(report.windows.find((window) => window.id === "standard-monthly")?.resetsAt, future);
  assert.ok(report.details?.some(({ id, value }) => id === "overage-preference" && value === "Droid Core"));
  assert.ok(report.details?.some(({ id, label, value }) => id === "extra-usage-allowed" && label === "Extra usage allowed" && value === "Yes"));
});

test("quota identities remain stable as values, reset dates, response order and extra fields change", () => {
  const first = parseFactoryQuota(observed(), now);
  const changed = observed();
  changed.limits.standard.monthly.usedPercent = 78;
  changed.limits.standard.monthly.windowEnd = "2026-11-01T00:00:00Z";
  const second = parseFactoryQuota({ future: { private: "ignored" }, ...changed, limits: { core: changed.limits.core, standard: changed.limits.standard } }, now);
  assert.equal(first.status, "available"); assert.equal(second.status, "available");
  if (first.status !== "available" || second.status !== "available") throw new Error("Expected quota report");
  assert.deepEqual(first.windows.map(({ id }) => id), second.windows.map(({ id }) => id));
  assert.match(second.windows.find(({ id }) => id === "standard-monthly")?.label ?? "", /Monthly/);
  assert.equal(JSON.stringify(second).includes("private"), false);
});

test("missing or malformed percentages never become zero and do not erase valid independent scopes", () => {
  for (const badWindow of [{}, { usedPercent: undefined }, { usedPercent: null }, { usedPercent: "0" },
    { usedPercent: NaN }, { usedPercent: Infinity }, { usedPercent: -1 }, [], "malformed"]) {
    const report = parseFactoryQuota({ limits: {
      standard: { fiveHour: badWindow }, core: { monthly: { usedPercent: 24, windowEnd: future } },
    } }, now);
    assert.equal(report.status, "available");
    if (report.status !== "available") throw new Error("Expected independent valid Core quota");
    assert.deepEqual(report.windows.map(({ id, usedPct }) => ({ id, usedPct })), [{ id: "core-monthly", usedPct: 24 }]);
    assert.ok(report.details?.some(({ id }) => id === "quota-incomplete"));
  }
  const report = parseFactoryQuota({ limits: { standard: [], core: { monthly: { usedPercent: 24, windowEnd: future } } } }, now);
  assert.equal(report.status, "available");
  if (report.status === "available") assert.deepEqual(report.windows.map(({ id }) => id), ["core-monthly"]);
});

test("expired quota is omitted instead of showing stale consumption or inventing a fresh zero", () => {
  for (const windowEnd of ["2026-10-16T00:00:00Z", new Date(now).toISOString()]) {
    const report = parseFactoryQuota({ limits: {
      standard: { fiveHour: { usedPercent: 96, windowEnd }, weekly: { usedPercent: 42, windowEnd: future } },
    } }, now);
    assert.equal(report.status, "available");
    if (report.status !== "available") throw new Error("Expected valid weekly quota");
    assert.deepEqual(report.windows.map(({ id }) => id), ["standard-weekly"]);
    assert.ok(report.details?.some(({ id }) => id === "quota-awaiting-refresh"));
  }
  const allExpired = parseFactoryQuota({ limits: { standard: { fiveHour: { usedPercent: 96, windowEnd: "2026-10-16T00:00:00Z" } } } }, now);
  assert.equal(allExpired.status, "unavailable");
  if (allExpired.status === "unavailable" && allExpired.problem.kind === "no_quota") assert.match(allExpired.problem.detail, /no current quota/);
});

test("null or missing reset permits only the explicitly reported unstarted zero window", () => {
  for (const windowEnd of [null, undefined]) {
    const report = parseFactoryQuota({ limits: { standard: {
      fiveHour: { usedPercent: 0, windowEnd }, weekly: { usedPercent: 50, windowEnd },
    } } }, now);
    assert.equal(report.status, "available");
    if (report.status !== "available") throw new Error("Expected explicit zero quota");
    assert.deepEqual(report.windows.map(({ id, usedPct, resetsAt }) => ({ id, usedPct, resetsAt })), [
      { id: "standard-five-hour", usedPct: 0, resetsAt: undefined },
    ]);
  }
});

test("resets require valid ISO timestamps and are normalized without deriving window lengths from countdowns", () => {
  const report = parseFactoryQuota({ limits: { standard: {
    fiveHour: { usedPercent: 15, windowEnd: "2026-10-18T08:00:00+08:00", secondsRemaining: 123456789 },
    weekly: { usedPercent: 25, windowEnd: "2026-02-30T00:00:00Z" },
    monthly: { usedPercent: 35, windowEnd: "Oct 24, 2026" },
  } } }, now);
  assert.equal(report.status, "available");
  if (report.status !== "available") throw new Error("Expected valid ISO window");
  assert.deepEqual(report.windows.map(({ id, resetsAt }) => ({ id, resetsAt })), [{ id: "standard-five-hour", resetsAt: "2026-10-18T00:00:00.000Z" }]);
  assert.equal(report.windows[0].label, "Standard · 5-hour");
  for (const windowEnd of [1_800_000_000, "invalid", "2026-13-40T00:00:00Z"]) {
    assert.equal(parseFactoryQuota({ limits: { standard: { weekly: { usedPercent: 0, windowEnd } } } }, now).status, "unavailable");
  }
});

test("reported overage remains visible and remaining percentage never becomes negative", () => {
  const report = parseFactoryQuota({ limits: { standard: {
    fiveHour: { usedPercent: 125, windowEnd: future }, weekly: { usedPercent: 70, windowEnd: future }, monthly: { usedPercent: 91.25, windowEnd: future },
  } } }, now);
  assert.equal(report.status, "available");
  if (report.status !== "available") throw new Error("Expected quota report");
  assert.deepEqual(report.windows.map(({ usedPct, remainingPct, tone }) => ({ usedPct, remainingPct, tone })), [
    { usedPct: 125, remainingPct: 0, tone: "danger" },
    { usedPct: 70, remainingPct: 30, tone: "warning" },
    { usedPct: 91.25, remainingPct: 8.75, tone: "danger" },
  ]);
  assert.equal(report.details?.find(({ id }) => id === "standard-remaining")?.value, "5-hour 0% · Weekly 30% · Monthly 8.75%");
});

test("cash balance converts cents to USD without inventing purchased credits, consumption or limit", () => {
  const report = parseFactoryQuota({ extraUsageBalanceCents: 12345, extraUsageAllowed: false, canManageOverage: false }, now);
  assert.equal(report.status, "available");
  if (report.status !== "available") throw new Error("Expected reported cash balance");
  assert.deepEqual(report.windows, []);
  assert.deepEqual(report.balances, [{ id: "extra-usage", label: "Extra usage balance", remaining: 123.45, unit: "usd", tone: "ok" }]);
  assert.equal(report.balances?.[0].used, undefined);
  assert.equal(report.balances?.[0].limit, undefined);
  assert.ok(report.details?.some(({ id }) => id === "quota-unreported"));
  assert.ok(report.details?.some(({ id, value }) => id === "extra-usage-allowed" && value === "No"));
  assert.ok(report.details?.some(({ id, value }) => id === "can-manage-overage" && value === "No"));
  const fractional = parseFactoryQuota({ extraUsageBalanceCents: 0.5 }, now);
  assert.equal(fractional.status, "available");
  if (fractional.status === "available") assert.equal(fractional.balances?.[0].remaining, 0.005);
  for (const cents of [undefined, null, -1, "100", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const result = parseFactoryQuota({ extraUsageBalanceCents: cents }, now);
    assert.equal(result.status, "unavailable");
  }
});

test("unsupported or incomplete billing never claims zero quota or assumes a subscription plan", () => {
  for (const input of [{}, { limits: null }, { limits: {} }, { limits: { standard: {}, core: {} } },
    { billingType: "pay-as-you-go", plan: "Enterprise" }, { limits: { futureScope: { monthly: { usedPercent: 0, windowEnd: future } } } }]) {
    const result = parseFactoryQuota(input, now);
    assert.equal(result.status, "unavailable");
    if (result.status !== "unavailable") throw new Error("Expected quota unavailable");
    assert.equal(result.problem.kind, "no_quota");
    if (result.problem.kind === "no_quota") assert.match(result.problem.detail, /Account quota is unavailable/);
  }
  const reportedPlan = parseFactoryQuota({ ...observed(), planLabel: "  Factory Pro  ", unrelated: "private-sentinel" }, now);
  assert.equal(reportedPlan.status, "available");
  if (reportedPlan.status === "available") assert.equal(reportedPlan.planLabel, "Factory Pro");
  assert.equal(JSON.stringify(reportedPlan).includes("private-sentinel"), false);
  const unknownPreference = parseFactoryQuota({ ...observed(), overagePreference: "futurePreference" }, now);
  assert.equal(unknownPreference.status, "available");
  if (unknownPreference.status === "available")
    assert.ok(unknownPreference.details?.some(({ id, value }) => id === "overage-preference" && value === "futurePreference"));
});

test("invalid envelopes and clocks produce sanitized errors with no data inferred", () => {
  for (const input of [null, undefined, 5, "private-sentinel", [], { limits: "private-sentinel" }]) {
    const result = parseFactoryQuota(input, now);
    assert.equal(result.status, "error");
    assert.equal(JSON.stringify(result).includes("private-sentinel"), false);
  }
  assert.equal(parseFactoryQuota(observed(), NaN).status, "error");
});
