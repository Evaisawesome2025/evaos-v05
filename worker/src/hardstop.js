/**
 * Dogfood hard-stop bridge for the Ask Worker.
 *
 * Semantics are derived from the 2026-10-02 dogfood policy and the
 * runner_hook preflight/complete JSON contract. This repo cannot import the
 * box Python ledger (guard.py). This module is the product-side allow/deny
 * and hold. It does not charge, capture, or arm payment.
 *
 * Hold quote (billable jobs):
 *   hold_wc = estimated_cogs_usd / wc_usd_value * complexity_multiplier[job_class]
 * ask_reply at the wire-contract sample estimate $0.05 → 0.5 WC.
 *
 * A billable job may start only when all of these hold:
 *   - burned_wc + open holds + this hold <= included * hard_stop_pct - reserve_floor
 *   - the same projection does not cross the hard stop (auto_overage is never a charge path)
 *   - today's CT job count is below daily_max_jobs
 *   - today's CT reserved COGS + this estimate is within daily_max_cogs_usd
 * Period and day boundaries use America/Chicago (calendar_month_ct).
 *
 * Non-billable classes (DEMO, REPLAY, SELFTEST, SAMPLE) or billable:false
 * take no hold and do not move the balance.
 */
export const DOGFOOD_ASK_ESTIMATED_COGS_USD = 0.05;

export const DOGFOOD_POLICY = Object.freeze({
  schema_version: 1,
  as_of_ct: "2026-10-02",
  status: "DOGFOOD_POLICY",
  notes:
    "WCincl is CONSERVATIVE PLACEHOLDER for dogfood only — NOT measured founding WCincl. Do not publish as customer allowance. Quinn illustrative ~300 @ $0.10/WC is E/A stress only.",
  workspace_id_default: "dogfood-glen",
  wc_usd_value: 0.1,
  wc_incl_per_period: 50,
  soft_warn_pct: 0.8,
  hard_stop_pct: 1,
  auto_overage: false,
  daily_max_jobs: 40,
  daily_max_cogs_usd: 5,
  reserve_floor_wc: 1,
  non_billable_classes: Object.freeze(["DEMO", "REPLAY", "SELFTEST", "SAMPLE"]),
  complexity_multipliers: Object.freeze({
    ask_reply: 1,
    objective_cycle: 2,
    audit: 1.5,
    browse: 1.5,
    orchestration: 1,
    other: 1,
  }),
  period: "calendar_month_ct",
});

const JOB_COST_CAP = 500;

export function round6(n) {
  return Math.round(Number(n) * 1e6) / 1e6;
}

export function ctParts(date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hourCycle: "h23",
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return {
    period: `${parts.year}-${parts.month}`,
    day: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function toDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (value) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

export function safeJobId(id) {
  const s = String(id || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(s)) return null;
  return s;
}

export function emptyLedger(workspaceId, now) {
  const { period } = ctParts(toDate(now));
  return {
    schema_version: 1,
    workspace_id: workspaceId,
    period,
    burned_wc: 0,
    open_holds: {},
    daily: {},
    jobs: {},
    job_cost: [],
  };
}

export function quoteHoldWc(policy, jobClass, estimatedCogsUsd) {
  const table = policy.complexity_multipliers || {};
  const key = Object.prototype.hasOwnProperty.call(table, jobClass) ? jobClass : "other";
  const mult = Number(table[key]);
  const safeMult = Number.isFinite(mult) && mult > 0 ? mult : 1;
  const usd = Number(policy.wc_usd_value);
  if (!(usd > 0)) return 0;
  return round6((Number(estimatedCogsUsd) / usd) * safeMult);
}

export function isBillable(policy, req) {
  if (req && req.billable === false) return false;
  const cls = String((req && req.job_class) || "").trim().toUpperCase();
  const list = (policy.non_billable_classes || []).map((c) => String(c).toUpperCase());
  if (list.includes(cls)) return false;
  return true;
}

/**
 * Server-side Ask classification. Client `billable: false` is ignored so a
 * normal owner ask cannot skip the guard. Explicit non-billable classes and
 * the existing selftest kind stay non-billable.
 */
export function classifyAskJob(input) {
  const kind = input && input.kind === "selftest" ? "selftest" : "owner";
  const requested = input && typeof input.job_class === "string" ? input.job_class.trim() : "";
  const upper = requested.toUpperCase();
  const non = DOGFOOD_POLICY.non_billable_classes.map((c) => c.toUpperCase());
  if (kind === "selftest" || upper === "SELFTEST") {
    return { job_class: "SELFTEST", billable: false, non_billable_reason: "selftest" };
  }
  if (non.includes(upper)) {
    return {
      job_class: upper,
      billable: false,
      non_billable_reason: `non_billable_class:${upper}`,
    };
  }
  return { job_class: "ask_reply", billable: true, non_billable_reason: null };
}

function deny(code, message, req) {
  return {
    ok: false,
    denied: true,
    reason: "hard_stop",
    code,
    message,
    job_id: req.job_id,
    workspace_id: req.workspace_id,
  };
}

function sumOpen(ledger) {
  let wc = 0;
  const holds = ledger.open_holds || {};
  for (const key of Object.keys(holds)) {
    if (!Object.prototype.hasOwnProperty.call(holds, key)) continue;
    wc += Number(holds[key] && holds[key].hold_wc) || 0;
  }
  return round6(wc);
}

function rollPeriod(ledger, now) {
  const { period } = ctParts(now);
  const next = structuredClone(ledger);
  if (next.period !== period) {
    next.period = period;
    next.burned_wc = 0;
    next.daily = {};
  }
  return next;
}

function hardCapOf(policy) {
  return round6(Number(policy.wc_incl_per_period) * Number(policy.hard_stop_pct));
}

function spendableOf(policy) {
  const reserve = Math.max(0, Number(policy.reserve_floor_wc) || 0);
  return round6(hardCapOf(policy) - reserve);
}

export function applyPreflight(ledger, req, policy = DOGFOOD_POLICY) {
  const now = toDate(req && req.now);
  const workspace_id = String((req && req.workspace_id) || policy.workspace_id_default);
  const job_id = safeJobId(req && req.job_id);
  if (!job_id) {
    return {
      persist: false,
      ledger,
      result: deny(
        "invalid_job",
        "Hard stop: job id is missing. No job was started.",
        { job_id: req && req.job_id, workspace_id }
      ),
    };
  }
  const job_class = String((req && req.job_class) || "other");
  const billable = isBillable(policy, { ...req, job_class });
  if (!billable) {
    return {
      persist: false,
      ledger,
      result: {
        ok: true,
        denied: false,
        decision: {
          workspace_id,
          job_id,
          job_class,
          billable: false,
          estimated_cogs_usd: 0,
          hold_wc: 0,
          soft_warn: false,
          non_billable_reason: (req && req.non_billable_reason) || "non_billable",
        },
      },
    };
  }

  const estimated = Number(req.estimated_cogs_usd);
  if (!Number.isFinite(estimated) || estimated <= 0) {
    return {
      persist: false,
      ledger,
      result: deny(
        "estimate_missing",
        "Hard stop: billable job has no positive estimated cost. No job was started.",
        { job_id, workspace_id }
      ),
    };
  }

  const view = rollPeriod(ledger || emptyLedger(workspace_id, now), now);
  view.workspace_id = workspace_id;
  const prior = view.jobs && Object.prototype.hasOwnProperty.call(view.jobs, job_id) ? view.jobs[job_id] : null;
  const openHold =
    view.open_holds && Object.prototype.hasOwnProperty.call(view.open_holds, job_id)
      ? view.open_holds[job_id]
      : null;
  if (prior && prior.status === "held" && openHold) {
    return {
      persist: false,
      ledger,
      result: {
        ok: true,
        denied: false,
        decision: { ...openHold, idempotent: true, soft_warn: prior.soft_warn === true },
      },
    };
  }
  if (prior && prior.status === "held" && !openHold) {
    return {
      persist: false,
      ledger,
      result: deny(
        "ledger_corrupt",
        "Hard stop: this job is marked held but has no work-credit hold. No job was started.",
        { job_id, workspace_id }
      ),
    };
  }
  if (prior && prior.status === "complete") {
    return {
      persist: false,
      ledger,
      result: deny(
        "job_already_complete",
        "Hard stop: this job already completed. No new hold was taken.",
        { job_id, workspace_id }
      ),
    };
  }

  const hold_wc = quoteHoldWc(policy, job_class, estimated);
  if (!(hold_wc > 0)) {
    return {
      persist: false,
      ledger,
      result: deny(
        "estimate_missing",
        "Hard stop: billable job quoted a zero work-credit hold. No job was started.",
        { job_id, workspace_id }
      ),
    };
  }

  const hardCap = hardCapOf(policy);
  const spendable = spendableOf(policy);
  const open = sumOpen(view);
  const used = round6(Number(view.burned_wc) + open);
  const projected = round6(used + hold_wc);
  const { day } = ctParts(now);
  const daily =
    view.daily && Object.prototype.hasOwnProperty.call(view.daily, day)
      ? view.daily[day]
      : { jobs: 0, cogs_usd: 0 };

  if (!(hardCap > 0) || used >= hardCap) {
    return {
      persist: false,
      ledger,
      result: deny(
        "hard_stop",
        `Hard stop: workspace ${workspace_id} is at the period hard stop. No job was started.`,
        { job_id, workspace_id }
      ),
    };
  }
  // auto_overage would be a charge path. This bridge never allows it.
  if (projected > hardCap) {
    const message =
      policy.auto_overage === true
        ? `Hard stop: overage is not enabled on this path (${hold_wc} WC). No job was started.`
        : `Hard stop: this job would pass the period hard stop (${hold_wc} WC). No job was started.`;
    return {
      persist: false,
      ledger,
      result: deny("hard_stop", message, { job_id, workspace_id }),
    };
  }
  if (projected > spendable) {
    const remaining = round6(Math.max(0, spendable - used));
    return {
      persist: false,
      ledger,
      result: deny(
        "insufficient_wc",
        `Hard stop: not enough work credits for this ask (need ${hold_wc} WC, spendable remaining ${remaining} WC). No job was started.`,
        { job_id, workspace_id }
      ),
    };
  }
  if (Number(daily.jobs) >= Number(policy.daily_max_jobs)) {
    return {
      persist: false,
      ledger,
      result: deny(
        "daily_job_cap",
        `Hard stop: daily job cap reached (${policy.daily_max_jobs}). No job was started.`,
        { job_id, workspace_id }
      ),
    };
  }
  if (round6(Number(daily.cogs_usd) + estimated) > Number(policy.daily_max_cogs_usd)) {
    return {
      persist: false,
      ledger,
      result: deny(
        "daily_cogs_cap",
        `Hard stop: daily cost cap reached ($${Number(policy.daily_max_cogs_usd).toFixed(2)}). No job was started.`,
        { job_id, workspace_id }
      ),
    };
  }

  const soft_warn = projected >= round6(Number(policy.wc_incl_per_period) * Number(policy.soft_warn_pct));
  const decision = {
    workspace_id,
    job_id,
    job_class,
    billable: true,
    estimated_cogs_usd: estimated,
    hold_wc,
    soft_warn,
    period: view.period,
    day,
  };
  if (!view.open_holds) view.open_holds = {};
  if (!view.daily) view.daily = {};
  if (!view.jobs) view.jobs = {};
  view.open_holds[job_id] = {
    workspace_id,
    job_id,
    job_class,
    billable: true,
    estimated_cogs_usd: estimated,
    hold_wc,
    day,
    period: view.period,
    created_at: now.toISOString(),
  };
  view.daily[day] = {
    jobs: Number(daily.jobs) + 1,
    cogs_usd: round6(Number(daily.cogs_usd) + estimated),
  };
  view.jobs[job_id] = { status: "held", soft_warn, hold_wc };
  return {
    persist: true,
    ledger: view,
    result: { ok: true, denied: false, decision },
  };
}

export function applyComplete(ledger, req, policy = DOGFOOD_POLICY) {
  const now = toDate(req && req.now);
  const workspace_id = String((req && req.workspace_id) || policy.workspace_id_default);
  const job_id = safeJobId(req && req.job_id);
  if (!job_id) {
    return {
      persist: false,
      ledger,
      result: deny("invalid_job", "Job id is missing. Nothing was burned.", {
        job_id: req && req.job_id,
        workspace_id,
      }),
    };
  }
  const view = rollPeriod(ledger || emptyLedger(workspace_id, now), now);
  const prior = view.jobs && Object.prototype.hasOwnProperty.call(view.jobs, job_id) ? view.jobs[job_id] : null;
  if (prior && prior.status === "complete" && prior.result) {
    return {
      persist: false,
      ledger,
      result: { ok: true, result: prior.result, idempotent: true },
    };
  }
  const hold =
    view.open_holds && Object.prototype.hasOwnProperty.call(view.open_holds, job_id)
      ? view.open_holds[job_id]
      : null;
  const job_class = String((hold && hold.job_class) || (req && req.job_class) || "other");
  const billable = hold ? true : isBillable(policy, { ...req, job_class });
  if (billable && !hold) {
    return {
      persist: false,
      ledger,
      result: deny(
        "hold_missing",
        "No open work-credit hold for this job. Nothing was burned.",
        { job_id, workspace_id }
      ),
    };
  }
  let actual = 0;
  if (billable) {
    actual = req.actual_cogs_usd == null ? Number(hold.estimated_cogs_usd) : Number(req.actual_cogs_usd);
    if (!Number.isFinite(actual) || actual < 0) {
      return {
        persist: false,
        ledger,
        result: deny("invalid_actual", "Actual cost must be a non-negative number. Nothing was burned.", {
          job_id,
          workspace_id,
        }),
      };
    }
  }
  const wc_burned = billable ? quoteHoldWc(policy, job_class, actual) : 0;
  if (hold) {
    const bucket =
      view.daily && Object.prototype.hasOwnProperty.call(view.daily, hold.day)
        ? view.daily[hold.day]
        : { jobs: 0, cogs_usd: 0 };
    bucket.cogs_usd = round6(Number(bucket.cogs_usd) + (actual - Number(hold.estimated_cogs_usd)));
    if (!view.daily) view.daily = {};
    view.daily[hold.day] = bucket;
    delete view.open_holds[job_id];
  }
  if (billable) view.burned_wc = round6(Number(view.burned_wc) + wc_burned);
  const { day, period } = ctParts(now);
  const note = String((req && req.units_note) || "").replace(/[\r\n]/g, " ").slice(0, 200);
  const row = {
    type: "JOB_COST",
    workspace_id,
    job_id,
    job_class,
    estimated_cogs_usd: hold ? Number(hold.estimated_cogs_usd) : 0,
    actual_cogs_usd: actual,
    hold_wc: hold ? Number(hold.hold_wc) : 0,
    wc_burned,
    billable,
    units_note: note,
    period,
    day,
    at: now.toISOString(),
  };
  if (!view.job_cost) view.job_cost = [];
  view.job_cost.push(row);
  if (view.job_cost.length > JOB_COST_CAP) {
    view.job_cost.splice(0, view.job_cost.length - JOB_COST_CAP);
  }
  if (!view.jobs) view.jobs = {};
  view.jobs[job_id] = { status: "complete", result: row };
  return { persist: true, ledger: view, result: { ok: true, result: row } };
}

export function applyRelease(ledger, req) {
  if (!ledger) return { persist: false, ledger, result: { ok: true, released: false } };
  const job_id = safeJobId(req && req.job_id);
  if (!job_id) return { persist: false, ledger, result: { ok: true, released: false } };
  const view = structuredClone(ledger);
  const hold =
    view.open_holds && Object.prototype.hasOwnProperty.call(view.open_holds, job_id)
      ? view.open_holds[job_id]
      : null;
  if (!hold) return { persist: false, ledger, result: { ok: true, released: false } };
  const bucket =
    view.daily && Object.prototype.hasOwnProperty.call(view.daily, hold.day) ? view.daily[hold.day] : null;
  if (bucket) {
    bucket.jobs = Math.max(0, Number(bucket.jobs) - 1);
    bucket.cogs_usd = round6(Math.max(0, Number(bucket.cogs_usd) - Number(hold.estimated_cogs_usd)));
    view.daily[hold.day] = bucket;
  }
  delete view.open_holds[job_id];
  if (!view.jobs) view.jobs = {};
  view.jobs[job_id] = { status: "released", reason: String((req && req.reason) || "released").slice(0, 80) };
  return { persist: true, ledger: view, result: { ok: true, released: true, hold_wc: Number(hold.hold_wc) } };
}

function ledgerStore(load, save) {
  return {
    async preflight(req) {
      const loaded = await load(req.workspace_id);
      if (loaded.corrupt) {
        return deny(
          "ledger_corrupt",
          "Hard stop: metering ledger could not be read. No job was started.",
          req
        );
      }
      const applied = applyPreflight(loaded.ledger, req);
      if (!applied.persist) return applied.result;
      try {
        await save(req.workspace_id, applied.ledger);
      } catch {
        return deny(
          "ledger_write_failed",
          "Hard stop: could not record the work-credit hold. No job was started.",
          req
        );
      }
      return applied.result;
    },
    async complete(req) {
      const loaded = await load(req.workspace_id);
      if (loaded.corrupt) {
        return deny("ledger_corrupt", "Metering ledger could not be read. Nothing was burned.", req);
      }
      const applied = applyComplete(loaded.ledger, req);
      if (!applied.persist) return applied.result;
      try {
        await save(req.workspace_id, applied.ledger);
      } catch {
        return deny("ledger_write_failed", "Could not record job completion. The hold was not burned.", req);
      }
      return applied.result;
    },
    async release(req) {
      const loaded = await load(req.workspace_id);
      if (loaded.corrupt || !loaded.ledger) return { ok: true, released: false };
      const applied = applyRelease(loaded.ledger, req);
      if (!applied.persist) return applied.result;
      try {
        await save(req.workspace_id, applied.ledger);
      } catch {
        return { ok: false, released: false, reason: "ledger_write_failed" };
      }
      return applied.result;
    },
  };
}

export function createMemoryLedger(initial) {
  let ledger = initial ? structuredClone(initial) : null;
  const api = ledgerStore(
    async () => ({ ledger: ledger ? structuredClone(ledger) : null, corrupt: false }),
    async (_ws, next) => {
      ledger = structuredClone(next);
    }
  );
  api.snapshot = () => (ledger ? structuredClone(ledger) : null);
  return api;
}

export function meteringKey(workspaceId) {
  return `metering:v1:${workspaceId}`;
}

export function createKvLedger(kv) {
  return ledgerStore(
    async (workspaceId) => {
      const key = meteringKey(workspaceId);
      let raw;
      try {
        raw = await kv.get(key);
      } catch {
        return { ledger: null, corrupt: true };
      }
      if (raw == null) return { ledger: null, corrupt: false };
      if (typeof raw === "object") return { ledger: raw, corrupt: false };
      try {
        return { ledger: JSON.parse(raw), corrupt: false };
      } catch {
        return { ledger: null, corrupt: true };
      }
    },
    async (workspaceId, next) => {
      await kv.put(meteringKey(workspaceId), JSON.stringify(next));
    }
  );
}
