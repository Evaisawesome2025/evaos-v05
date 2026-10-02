/**
 * Dogfood hard-stop mirror for the Ask Worker.
 *
 * Box path (not importable from a Cloudflare Worker):
 *   architecture/evaos/metering/runner_hook.py
 *   preflight → assert_job_may_start → hold WC, or deny
 *   complete  → record_job_complete → burn + JOB_COST row
 *
 * This module keeps that JSON shape. It is not the file ledger on the box,
 * not a Stripe integration, and not a customer allowance.
 * payment_ready and product Ready stay false — no env var turns them on.
 *
 * Store: env.METERING_KV when bound; otherwise memory in this isolate.
 * Isolate memory resets when the isolate dies. It is not durable billing state.
 */
import { DOGFOOD_POLICY } from "./dogfood_policy.js";

export { DOGFOOD_POLICY };

/** 1 WC = 10_000 micro-WC so holds and burns stay integer. */
export const WC_MICRO = 10000;

export const PAYMENT_READY = false;
export const PRODUCT_READY = false;
export const STRANGER_WRITE = false;

const CT = "America/Chicago";
const DEFAULT_ESTIMATE = 0.05;

export const DEFAULT_ASK_ESTIMATED_COGS_USD = DEFAULT_ESTIMATE;

const DENY_MESSAGE = {
  wc_hard_stop:
    "Dogfood hard-stop: included work credits for this period cannot cover the hold. This Ask was not started. Nothing was written.",
  daily_job_cap:
    "Dogfood hard-stop: daily job cap reached. This Ask was not started. Nothing was written.",
  daily_cogs_cap:
    "Dogfood hard-stop: daily cost cap reached. This Ask was not started. Nothing was written.",
  job_already_complete:
    "Dogfood hard-stop: this job id already finished. Nothing new was written.",
};

export function ctStamp(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) {
    throw new Error("bad_now");
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CT,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const pick = (type) => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error("bad_now");
    return part.value;
  };
  const day = `${pick("year")}-${pick("month")}-${pick("day")}`;
  return { day_id: day, period_id: day.slice(0, 7), timeZone: CT };
}

export function microToWc(micro) {
  return micro / WC_MICRO;
}

function scaleWc(wc) {
  return Math.round(Number(wc) * WC_MICRO);
}

function usdToCents(usd) {
  return Math.round(Number(usd) * 100);
}

function centsToUsd(cents) {
  return cents / 100;
}

function wcMicroFromCogs(usd, multiplier, wcUsd) {
  const micro = (Number(usd) * Number(multiplier) * WC_MICRO) / Number(wcUsd);
  return Math.ceil(micro - 1e-9);
}

function assertPolicy(policy) {
  if (!policy || policy.schema_version !== 1) throw new Error("bad_policy");
  if (policy.status !== "DOGFOOD_POLICY") throw new Error("bad_policy");
  if (policy.auto_overage !== false) throw new Error("auto_overage_not_supported");
  if (policy.period !== "calendar_month_ct") throw new Error("bad_policy");
  const nums = [
    "wc_usd_value",
    "wc_incl_per_period",
    "soft_warn_pct",
    "hard_stop_pct",
    "daily_max_jobs",
    "daily_max_cogs_usd",
    "reserve_floor_wc",
  ];
  for (const key of nums) {
    if (!Number.isFinite(Number(policy[key])) || Number(policy[key]) < 0) {
      throw new Error("bad_policy");
    }
  }
  if (!(Number(policy.wc_usd_value) > 0)) throw new Error("bad_policy");
  if (!(Number(policy.hard_stop_pct) > 0)) throw new Error("bad_policy");
  if (!policy.workspace_id_default) throw new Error("bad_policy");
  if (!Array.isArray(policy.non_billable_classes)) throw new Error("bad_policy");
}

function canonicalClass(policy, jobClass) {
  const raw = String(jobClass || "other");
  const hit = policy.non_billable_classes.find(
    (c) => String(c).toLowerCase() === raw.toLowerCase()
  );
  return hit || raw;
}

function classIsNonBillable(policy, jobClass) {
  const raw = String(jobClass || "");
  return policy.non_billable_classes.some(
    (c) => String(c).toLowerCase() === raw.toLowerCase()
  );
}

function multiplierFor(policy, jobClass) {
  const table = policy.complexity_multipliers || {};
  if (table[jobClass] != null) return Number(table[jobClass]);
  const key = Object.keys(table).find(
    (k) => k.toLowerCase() === String(jobClass).toLowerCase()
  );
  if (key != null) return Number(table[key]);
  if (table.other != null) return Number(table.other);
  return 1;
}

function requestIsBillable(policy, req) {
  if (req.billable === false) return false;
  if (classIsNonBillable(policy, req.job_class)) return false;
  return true;
}

function holdMicroFor(policy, req, billable) {
  if (!billable) return 0;
  const mult = multiplierFor(policy, canonicalClass(policy, req.job_class));
  const raw = wcMicroFromCogs(req.estimated_cogs_usd, mult, policy.wc_usd_value);
  // reserve_floor_wc is the minimum billable hold.
  // $0.05 ask_reply at $0.10/WC is 0.5 WC, so the hold is 1 WC.
  return Math.max(scaleWc(policy.reserve_floor_wc), raw);
}

function burnMicroFor(policy, actualCogs, jobClass, billable) {
  if (!billable) return 0;
  const mult = multiplierFor(policy, jobClass);
  return wcMicroFromCogs(actualCogs, mult, policy.wc_usd_value);
}

function emptyLedger(workspaceId, stamp) {
  return {
    schema_version: 1,
    workspace_id: workspaceId,
    period_id: stamp.period_id,
    consumed_micro: 0,
    open_holds: {},
    jobs: {},
    daily: {},
    job_cost: [],
    payment_ready: PAYMENT_READY,
    ready: PRODUCT_READY,
  };
}

function assertLedger(ledger, workspaceId) {
  if (!ledger || ledger.schema_version !== 1) throw new Error("ledger_schema");
  if (ledger.workspace_id !== workspaceId) throw new Error("ledger_workspace");
  if (!Number.isInteger(ledger.consumed_micro) || ledger.consumed_micro < 0) {
    throw new Error("ledger_corrupt");
  }
  if (!ledger.open_holds || typeof ledger.open_holds !== "object") {
    throw new Error("ledger_corrupt");
  }
  if (!ledger.jobs || typeof ledger.jobs !== "object") throw new Error("ledger_corrupt");
  if (!ledger.daily || typeof ledger.daily !== "object") throw new Error("ledger_corrupt");
  if (!Array.isArray(ledger.job_cost)) throw new Error("ledger_corrupt");
  if (ledger.payment_ready !== false || ledger.ready !== false) {
    throw new Error("ledger_corrupt");
  }
}

function loadWorking(loaded, workspaceId, stamp) {
  if (loaded == null) return emptyLedger(workspaceId, stamp);
  assertLedger(loaded, workspaceId);
  if (loaded.period_id !== stamp.period_id) return emptyLedger(workspaceId, stamp);
  return structuredClone(loaded);
}

function sumOpenMicro(ledger) {
  let total = 0;
  for (const value of Object.values(ledger.open_holds)) {
    if (!Number.isInteger(value) || value < 0) throw new Error("ledger_corrupt");
    total += value;
  }
  return total;
}

function dayBucket(ledger, dayId) {
  if (!ledger.daily[dayId]) ledger.daily[dayId] = { jobs: 0, cogs_cents: 0 };
  const bucket = ledger.daily[dayId];
  if (!Number.isInteger(bucket.jobs) || !Number.isInteger(bucket.cogs_cents)) {
    throw new Error("ledger_corrupt");
  }
  return bucket;
}

function denial(req, code) {
  return {
    ok: false,
    denied: true,
    reason: "hard_stop",
    code,
    message: DENY_MESSAGE[code] || DENY_MESSAGE.wc_hard_stop,
    job_id: req.job_id,
    workspace_id: req.workspace_id,
    spend: false,
    payment_ready: PAYMENT_READY,
    ready: PRODUCT_READY,
  };
}

function decisionFor(policy, ledger, job, req, stamp) {
  const open = sumOpenMicro(ledger);
  const projected = ledger.consumed_micro + open;
  const warnAt = scaleWc(Number(policy.wc_incl_per_period) * Number(policy.soft_warn_pct));
  return {
    workspace_id: req.workspace_id,
    job_id: req.job_id,
    job_class: job.job_class,
    billable: job.billable,
    hold_wc: microToWc(job.hold_micro),
    estimated_cogs_usd: centsToUsd(job.estimated_cents),
    soft_warn: job.billable && projected >= warnAt,
    period_id: stamp.period_id,
    day_id: stamp.day_id,
    consumed_wc: microToWc(ledger.consumed_micro),
    open_hold_wc: microToWc(open),
    included_wc: Number(policy.wc_incl_per_period),
    hard_stop_wc: Number(policy.wc_incl_per_period) * Number(policy.hard_stop_pct),
    payment_ready: PAYMENT_READY,
    ready: PRODUCT_READY,
  };
}

function allow(policy, ledger, job, req, stamp, idempotent) {
  const decision = decisionFor(policy, ledger, job, req, stamp);
  decision.idempotent = !!idempotent;
  return { ok: true, denied: false, decision };
}

function requireIds(req) {
  const workspaceId = req && req.workspace_id != null ? String(req.workspace_id) : "";
  const jobId = req && req.job_id != null ? String(req.job_id) : "";
  if (!workspaceId || !jobId) throw new Error("bad_request");
  if (workspaceId.length > 80 || jobId.length > 80) throw new Error("bad_request");
  return { workspaceId, jobId };
}

function readEstimate(req) {
  const n = Number(req.estimated_cogs_usd);
  if (!Number.isFinite(n) || n < 0) throw new Error("bad_estimate");
  return n;
}

export async function preflight(store, req, policy = DOGFOOD_POLICY, options = {}) {
  assertPolicy(policy);
  const { workspaceId, jobId } = requireIds(req);
  const estimated = readEstimate(req);
  const stamp = ctStamp(options.now || new Date());
  const loaded = await store.load(workspaceId);
  const ledger = loadWorking(loaded, workspaceId, stamp);
  const existing = ledger.jobs[jobId];

  if (existing && (existing.state === "complete" || existing.state === "aborted")) {
    return denial({ workspace_id: workspaceId, job_id: jobId }, "job_already_complete");
  }
  if (existing && existing.state === "open") {
    return allow(policy, ledger, existing, { workspace_id: workspaceId, job_id: jobId }, stamp, true);
  }

  const billable = requestIsBillable(policy, req);
  const jobClass = canonicalClass(policy, req.job_class);
  const normalized = { ...req, estimated_cogs_usd: estimated, job_class: jobClass };
  const holdMicro = holdMicroFor(policy, normalized, billable);
  const estimatedCents = usdToCents(estimated);

  if (billable) {
    const hardStop = scaleWc(Number(policy.wc_incl_per_period) * Number(policy.hard_stop_pct));
    const projected = ledger.consumed_micro + sumOpenMicro(ledger) + holdMicro;
    if (projected > hardStop) {
      return denial({ workspace_id: workspaceId, job_id: jobId }, "wc_hard_stop");
    }
    const bucket = dayBucket(ledger, stamp.day_id);
    if (bucket.jobs + 1 > Number(policy.daily_max_jobs)) {
      return denial({ workspace_id: workspaceId, job_id: jobId }, "daily_job_cap");
    }
    if (bucket.cogs_cents + estimatedCents > usdToCents(policy.daily_max_cogs_usd)) {
      return denial({ workspace_id: workspaceId, job_id: jobId }, "daily_cogs_cap");
    }
    bucket.jobs += 1;
    bucket.cogs_cents += estimatedCents;
  }

  const job = {
    state: "open",
    job_class: jobClass,
    billable,
    hold_micro: holdMicro,
    estimated_cents: estimatedCents,
    day_id: stamp.day_id,
    period_id: stamp.period_id,
    non_billable_reason: billable ? null : req.non_billable_reason || "non_billable",
  };
  ledger.jobs[jobId] = job;
  if (holdMicro > 0) ledger.open_holds[jobId] = holdMicro;
  await store.save(workspaceId, ledger);
  return allow(
    policy,
    ledger,
    job,
    { workspace_id: workspaceId, job_id: jobId },
    stamp,
    false
  );
}

function completionResult(policy, ledger, job, workspaceId, jobId) {
  const done = job.completion;
  const hardStop = scaleWc(Number(policy.wc_incl_per_period) * Number(policy.hard_stop_pct));
  const row = {
    workspace_id: workspaceId,
    job_id: jobId,
    job_class: job.job_class,
    billable: job.billable,
    estimated_cogs_usd: centsToUsd(job.estimated_cents),
    actual_cogs_usd: centsToUsd(done.actual_cents),
    hold_wc: microToWc(job.hold_micro),
    burn_wc: microToWc(done.burn_micro),
    aborted: !!done.aborted,
    non_billable_reason: job.non_billable_reason,
    provider: done.provider,
    model_tier: done.model_tier,
    route_reason: done.route_reason,
    units_note: done.units_note,
    at: done.at,
    payment_ready: PAYMENT_READY,
    ready: PRODUCT_READY,
  };
  return {
    ok: true,
    result: {
      ...row,
      over_hard_stop: ledger.consumed_micro > hardStop,
      job_cost: row,
    },
  };
}

export async function complete(store, req, policy = DOGFOOD_POLICY, options = {}) {
  assertPolicy(policy);
  const { workspaceId, jobId } = requireIds(req);
  const stamp = ctStamp(options.now || new Date());
  const loaded = await store.load(workspaceId);
  if (loaded == null) {
    return { ok: false, error: "job_not_open", job_id: jobId, workspace_id: workspaceId };
  }
  const ledger = loadWorking(loaded, workspaceId, stamp);
  const job = ledger.jobs[jobId];
  if (!job) {
    return { ok: false, error: "job_not_open", job_id: jobId, workspace_id: workspaceId };
  }
  if (job.state === "complete" || job.state === "aborted") {
    return completionResult(policy, ledger, job, workspaceId, jobId);
  }
  if (job.state !== "open") throw new Error("ledger_corrupt");

  const aborted = req.aborted === true;
  const actual = aborted ? 0 : Number(req.actual_cogs_usd);
  if (!Number.isFinite(actual) || actual < 0) throw new Error("bad_actual_cogs");

  const burnMicro = aborted ? 0 : burnMicroFor(policy, actual, job.job_class, job.billable);
  if (job.billable) {
    const bucket = dayBucket(ledger, job.day_id);
    if (aborted) {
      bucket.jobs = Math.max(0, bucket.jobs - 1);
      bucket.cogs_cents = Math.max(0, bucket.cogs_cents - job.estimated_cents);
    } else {
      bucket.cogs_cents = Math.max(0, bucket.cogs_cents - job.estimated_cents + usdToCents(actual));
    }
  }

  delete ledger.open_holds[jobId];
  ledger.consumed_micro += burnMicro;

  const noteFallback = aborted
    ? "aborted: hold released; no burn"
    : job.billable
      ? "dogfood complete"
      : "non-billable; no work-credit burn";
  const unitsNote = String(req.units_note == null ? noteFallback : req.units_note).slice(0, 500);

  job.state = aborted ? "aborted" : "complete";
  const at = (options.now ? new Date(options.now) : new Date()).toISOString();
  job.completion = {
    burn_micro: burnMicro,
    actual_cents: usdToCents(actual),
    aborted,
    units_note: unitsNote,
    at,
    provider: req.provider || "evaos-dogfood",
    model_tier: req.model_tier || (job.billable ? "cheap" : "none"),
    route_reason: req.route_reason || (job.billable ? "cheap_first_default" : "non_billable"),
  };

  ledger.job_cost.push({
    job_id: jobId,
    job_class: job.job_class,
    billable: job.billable,
    hold_wc: microToWc(job.hold_micro),
    burn_wc: microToWc(burnMicro),
    estimated_cogs_usd: centsToUsd(job.estimated_cents),
    actual_cogs_usd: centsToUsd(job.completion.actual_cents),
    aborted,
    units_note: unitsNote,
    at: job.completion.at,
    payment_ready: PAYMENT_READY,
  });
  if (ledger.job_cost.length > 500) {
    ledger.job_cost.splice(0, ledger.job_cost.length - 500);
  }

  await store.save(workspaceId, ledger);
  return completionResult(policy, ledger, job, workspaceId, jobId);
}

export function memoryStore(seed = null) {
  const byWorkspace = new Map();
  if (seed) {
    if (!seed.workspace_id) throw new Error("ledger_workspace");
    byWorkspace.set(seed.workspace_id, structuredClone(seed));
  }
  return {
    kind: "isolate_memory",
    async load(workspaceId) {
      const row = byWorkspace.get(workspaceId);
      return row ? structuredClone(row) : null;
    },
    async save(workspaceId, ledger) {
      if (!ledger || ledger.workspace_id !== workspaceId) throw new Error("ledger_workspace");
      byWorkspace.set(workspaceId, structuredClone(ledger));
    },
    async peek(workspaceId) {
      const row = byWorkspace.get(workspaceId);
      return row ? structuredClone(row) : null;
    },
    reset() {
      byWorkspace.clear();
    },
  };
}

export function kvStore(kv) {
  if (!kv || typeof kv.get !== "function" || typeof kv.put !== "function") {
    throw new Error("bad_kv");
  }
  return {
    kind: "kv",
    async load(workspaceId) {
      const raw = await kv.get(kvKey(workspaceId), "json");
      if (raw == null) return null;
      if (typeof raw === "string") return JSON.parse(raw);
      return raw;
    },
    async save(workspaceId, ledger) {
      if (!ledger || ledger.workspace_id !== workspaceId) throw new Error("ledger_workspace");
      await kv.put(kvKey(workspaceId), JSON.stringify(ledger));
    },
  };
}

function kvKey(workspaceId) {
  return `dogfood-ledger:v1:${workspaceId}`;
}

const isolate = memoryStore();

export function storeForEnv(env) {
  if (env && env.METERING_KV) return kvStore(env.METERING_KV);
  return isolate;
}

export function resetIsolateStoreForTests() {
  isolate.reset();
}

export function readEstimatedCogs(env) {
  if (!env || env.ASK_ESTIMATED_COGS_USD == null || env.ASK_ESTIMATED_COGS_USD === "") {
    return DEFAULT_ASK_ESTIMATED_COGS_USD;
  }
  const n = Number(env.ASK_ESTIMATED_COGS_USD);
  if (!Number.isFinite(n) || n < 0) throw new Error("bad_estimate");
  return n;
}
