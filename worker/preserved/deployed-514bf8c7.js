var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/hardstop.js
var DOGFOOD_ASK_ESTIMATED_COGS_USD = 0.05;
var DOGFOOD_POLICY = Object.freeze({
  schema_version: 1,
  as_of_ct: "2026-10-02",
  status: "DOGFOOD_POLICY",
  notes: "WCincl is CONSERVATIVE PLACEHOLDER for dogfood only \u2014 NOT measured founding WCincl. Do not publish as customer allowance. Quinn illustrative ~300 @ $0.10/WC is E/A stress only.",
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
    other: 1
  }),
  period: "calendar_month_ct"
});
var JOB_COST_CAP = 500;
function round6(n) {
  return Math.round(Number(n) * 1e6) / 1e6;
}
__name(round6, "round6");
function ctParts(date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hourCycle: "h23"
  });
  const parts = {};
  for (const p of fmt.formatToParts(date))
    parts[p.type] = p.value;
  return {
    period: `${parts.year}-${parts.month}`,
    day: `${parts.year}-${parts.month}-${parts.day}`
  };
}
__name(ctParts, "ctParts");
function toDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime()))
    return value;
  if (value) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime()))
      return d;
  }
  return /* @__PURE__ */ new Date();
}
__name(toDate, "toDate");
function safeJobId(id) {
  const s = String(id || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(s))
    return null;
  return s;
}
__name(safeJobId, "safeJobId");
function emptyLedger(workspaceId2, now) {
  const { period } = ctParts(toDate(now));
  return {
    schema_version: 1,
    workspace_id: workspaceId2,
    period,
    burned_wc: 0,
    open_holds: {},
    daily: {},
    jobs: {},
    job_cost: []
  };
}
__name(emptyLedger, "emptyLedger");
function quoteHoldWc(policy, jobClass, estimatedCogsUsd2) {
  const table = policy.complexity_multipliers || {};
  const key = Object.prototype.hasOwnProperty.call(table, jobClass) ? jobClass : "other";
  const mult = Number(table[key]);
  const safeMult = Number.isFinite(mult) && mult > 0 ? mult : 1;
  const usd = Number(policy.wc_usd_value);
  if (!(usd > 0))
    return 0;
  return round6(Number(estimatedCogsUsd2) / usd * safeMult);
}
__name(quoteHoldWc, "quoteHoldWc");
function isBillable(policy, req) {
  if (req && req.billable === false)
    return false;
  const cls = String(req && req.job_class || "").trim().toUpperCase();
  const list = (policy.non_billable_classes || []).map((c) => String(c).toUpperCase());
  if (list.includes(cls))
    return false;
  return true;
}
__name(isBillable, "isBillable");
function classifyAskJob(input) {
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
      non_billable_reason: `non_billable_class:${upper}`
    };
  }
  return { job_class: "ask_reply", billable: true, non_billable_reason: null };
}
__name(classifyAskJob, "classifyAskJob");
function deny(code, message, req) {
  return {
    ok: false,
    denied: true,
    reason: "hard_stop",
    code,
    message,
    job_id: req.job_id,
    workspace_id: req.workspace_id
  };
}
__name(deny, "deny");
function sumOpen(ledger) {
  let wc = 0;
  const holds = ledger.open_holds || {};
  for (const key of Object.keys(holds)) {
    if (!Object.prototype.hasOwnProperty.call(holds, key))
      continue;
    wc += Number(holds[key] && holds[key].hold_wc) || 0;
  }
  return round6(wc);
}
__name(sumOpen, "sumOpen");
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
__name(rollPeriod, "rollPeriod");
function hardCapOf(policy) {
  return round6(Number(policy.wc_incl_per_period) * Number(policy.hard_stop_pct));
}
__name(hardCapOf, "hardCapOf");
function spendableOf(policy) {
  const reserve = Math.max(0, Number(policy.reserve_floor_wc) || 0);
  return round6(hardCapOf(policy) - reserve);
}
__name(spendableOf, "spendableOf");
function applyPreflight(ledger, req, policy = DOGFOOD_POLICY) {
  const now = toDate(req && req.now);
  const workspace_id = String(req && req.workspace_id || policy.workspace_id_default);
  const job_id = safeJobId(req && req.job_id);
  if (!job_id) {
    return {
      persist: false,
      ledger,
      result: deny(
        "invalid_job",
        "Hard stop: job id is missing. No job was started.",
        { job_id: req && req.job_id, workspace_id }
      )
    };
  }
  const job_class = String(req && req.job_class || "other");
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
          non_billable_reason: req && req.non_billable_reason || "non_billable"
        }
      }
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
      )
    };
  }
  const view = rollPeriod(ledger || emptyLedger(workspace_id, now), now);
  view.workspace_id = workspace_id;
  const prior = view.jobs && Object.prototype.hasOwnProperty.call(view.jobs, job_id) ? view.jobs[job_id] : null;
  const openHold = view.open_holds && Object.prototype.hasOwnProperty.call(view.open_holds, job_id) ? view.open_holds[job_id] : null;
  if (prior && prior.status === "held" && openHold) {
    return {
      persist: false,
      ledger,
      result: {
        ok: true,
        denied: false,
        decision: { ...openHold, idempotent: true, soft_warn: prior.soft_warn === true }
      }
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
      )
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
      )
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
      )
    };
  }
  const hardCap = hardCapOf(policy);
  const spendable = spendableOf(policy);
  const open = sumOpen(view);
  const used = round6(Number(view.burned_wc) + open);
  const projected = round6(used + hold_wc);
  const { day } = ctParts(now);
  const daily = view.daily && Object.prototype.hasOwnProperty.call(view.daily, day) ? view.daily[day] : { jobs: 0, cogs_usd: 0 };
  if (!(hardCap > 0) || used >= hardCap) {
    return {
      persist: false,
      ledger,
      result: deny(
        "hard_stop",
        `Hard stop: workspace ${workspace_id} is at the period hard stop. No job was started.`,
        { job_id, workspace_id }
      )
    };
  }
  if (projected > hardCap) {
    const message = policy.auto_overage === true ? `Hard stop: overage is not enabled on this path (${hold_wc} WC). No job was started.` : `Hard stop: this job would pass the period hard stop (${hold_wc} WC). No job was started.`;
    return {
      persist: false,
      ledger,
      result: deny("hard_stop", message, { job_id, workspace_id })
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
      )
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
      )
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
      )
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
    day
  };
  if (!view.open_holds)
    view.open_holds = {};
  if (!view.daily)
    view.daily = {};
  if (!view.jobs)
    view.jobs = {};
  view.open_holds[job_id] = {
    workspace_id,
    job_id,
    job_class,
    billable: true,
    estimated_cogs_usd: estimated,
    hold_wc,
    day,
    period: view.period,
    created_at: now.toISOString()
  };
  view.daily[day] = {
    jobs: Number(daily.jobs) + 1,
    cogs_usd: round6(Number(daily.cogs_usd) + estimated)
  };
  view.jobs[job_id] = { status: "held", soft_warn, hold_wc };
  return {
    persist: true,
    ledger: view,
    result: { ok: true, denied: false, decision }
  };
}
__name(applyPreflight, "applyPreflight");
function applyComplete(ledger, req, policy = DOGFOOD_POLICY) {
  const now = toDate(req && req.now);
  const workspace_id = String(req && req.workspace_id || policy.workspace_id_default);
  const job_id = safeJobId(req && req.job_id);
  if (!job_id) {
    return {
      persist: false,
      ledger,
      result: deny("invalid_job", "Job id is missing. Nothing was burned.", {
        job_id: req && req.job_id,
        workspace_id
      })
    };
  }
  const view = rollPeriod(ledger || emptyLedger(workspace_id, now), now);
  const prior = view.jobs && Object.prototype.hasOwnProperty.call(view.jobs, job_id) ? view.jobs[job_id] : null;
  if (prior && prior.status === "complete" && prior.result) {
    return {
      persist: false,
      ledger,
      result: { ok: true, result: prior.result, idempotent: true }
    };
  }
  const hold = view.open_holds && Object.prototype.hasOwnProperty.call(view.open_holds, job_id) ? view.open_holds[job_id] : null;
  const job_class = String(hold && hold.job_class || req && req.job_class || "other");
  const billable = hold ? true : isBillable(policy, { ...req, job_class });
  if (billable && !hold) {
    return {
      persist: false,
      ledger,
      result: deny(
        "hold_missing",
        "No open work-credit hold for this job. Nothing was burned.",
        { job_id, workspace_id }
      )
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
          workspace_id
        })
      };
    }
  }
  const wc_burned = billable ? quoteHoldWc(policy, job_class, actual) : 0;
  if (hold) {
    const bucket = view.daily && Object.prototype.hasOwnProperty.call(view.daily, hold.day) ? view.daily[hold.day] : { jobs: 0, cogs_usd: 0 };
    bucket.cogs_usd = round6(Number(bucket.cogs_usd) + (actual - Number(hold.estimated_cogs_usd)));
    if (!view.daily)
      view.daily = {};
    view.daily[hold.day] = bucket;
    delete view.open_holds[job_id];
  }
  if (billable)
    view.burned_wc = round6(Number(view.burned_wc) + wc_burned);
  const { day, period } = ctParts(now);
  const note = String(req && req.units_note || "").replace(/[\r\n]/g, " ").slice(0, 200);
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
    at: now.toISOString()
  };
  if (!view.job_cost)
    view.job_cost = [];
  view.job_cost.push(row);
  if (view.job_cost.length > JOB_COST_CAP) {
    view.job_cost.splice(0, view.job_cost.length - JOB_COST_CAP);
  }
  if (!view.jobs)
    view.jobs = {};
  view.jobs[job_id] = { status: "complete", result: row };
  return { persist: true, ledger: view, result: { ok: true, result: row } };
}
__name(applyComplete, "applyComplete");
function applyRelease(ledger, req) {
  if (!ledger)
    return { persist: false, ledger, result: { ok: true, released: false } };
  const job_id = safeJobId(req && req.job_id);
  if (!job_id)
    return { persist: false, ledger, result: { ok: true, released: false } };
  const view = structuredClone(ledger);
  const hold = view.open_holds && Object.prototype.hasOwnProperty.call(view.open_holds, job_id) ? view.open_holds[job_id] : null;
  if (!hold)
    return { persist: false, ledger, result: { ok: true, released: false } };
  const bucket = view.daily && Object.prototype.hasOwnProperty.call(view.daily, hold.day) ? view.daily[hold.day] : null;
  if (bucket) {
    bucket.jobs = Math.max(0, Number(bucket.jobs) - 1);
    bucket.cogs_usd = round6(Math.max(0, Number(bucket.cogs_usd) - Number(hold.estimated_cogs_usd)));
    view.daily[hold.day] = bucket;
  }
  delete view.open_holds[job_id];
  if (!view.jobs)
    view.jobs = {};
  view.jobs[job_id] = { status: "released", reason: String(req && req.reason || "released").slice(0, 80) };
  return { persist: true, ledger: view, result: { ok: true, released: true, hold_wc: Number(hold.hold_wc) } };
}
__name(applyRelease, "applyRelease");
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
      if (!applied.persist)
        return applied.result;
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
      if (!applied.persist)
        return applied.result;
      try {
        await save(req.workspace_id, applied.ledger);
      } catch {
        return deny("ledger_write_failed", "Could not record job completion. The hold was not burned.", req);
      }
      return applied.result;
    },
    async release(req) {
      const loaded = await load(req.workspace_id);
      if (loaded.corrupt || !loaded.ledger)
        return { ok: true, released: false };
      const applied = applyRelease(loaded.ledger, req);
      if (!applied.persist)
        return applied.result;
      try {
        await save(req.workspace_id, applied.ledger);
      } catch {
        return { ok: false, released: false, reason: "ledger_write_failed" };
      }
      return applied.result;
    }
  };
}
__name(ledgerStore, "ledgerStore");
function meteringKey(workspaceId2) {
  return `metering:v1:${workspaceId2}`;
}
__name(meteringKey, "meteringKey");
function createKvLedger(kv) {
  return ledgerStore(
    async (workspaceId2) => {
      const key = meteringKey(workspaceId2);
      let raw;
      try {
        raw = await kv.get(key);
      } catch {
        return { ledger: null, corrupt: true };
      }
      if (raw == null)
        return { ledger: null, corrupt: false };
      if (typeof raw === "object")
        return { ledger: raw, corrupt: false };
      try {
        return { ledger: JSON.parse(raw), corrupt: false };
      } catch {
        return { ledger: null, corrupt: true };
      }
    },
    async (workspaceId2, next) => {
      await kv.put(meteringKey(workspaceId2), JSON.stringify(next));
    }
  );
}
__name(createKvLedger, "createKvLedger");

// src/disposable_act.js
var FROZEN = /* @__PURE__ */ new Set([
  "dca70509780aa2891c9dce962166eae2",
  "run-66e8d7a16d6e2bf07b15eb14",
  "stranger-objective"
]);
var COMMAND = "outside-counter";
function json(status, data, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": origin || "https://joinermill.com"
    }
  });
}
__name(json, "json");
function pathOf(pathname, suffix) {
  const match = new RegExp(`^/objective/([^/]+)/${suffix}$`).exec(pathname);
  if (!match)
    return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}
__name(pathOf, "pathOf");
function disposableActPath(pathname) {
  return pathOf(pathname, "act");
}
__name(disposableActPath, "disposableActPath");
function disposableClaimPath(pathname) {
  return pathOf(pathname, "claim");
}
__name(disposableClaimPath, "disposableClaimPath");
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex, "sha256Hex");
function prefixEvents(events) {
  return (Array.isArray(events) ? events : []).filter((event) => {
    if (!event || typeof event !== "object")
      return false;
    return event.name !== "attempt" && event.name !== "result" && event.name !== "entry";
  });
}
__name(prefixEvents, "prefixEvents");
async function actionDigest(record) {
  const canon = JSON.stringify({
    objective_id: record.objective_id,
    run_id: record.run_id,
    disposition: "CONTINUE",
    command: COMMAND,
    events: prefixEvents(record.events)
  });
  return sha256Hex(canon);
}
__name(actionDigest, "actionDigest");
function refused(origin, reason) {
  return json(409, { started: false, outside_called: false, reason, ready: false }, origin);
}
__name(refused, "refused");
async function readOwnRun(kv, runId) {
  if (!kv || typeof kv.get !== "function")
    return { error: "objective_store_unbound" };
  if (FROZEN.has(runId) || runId.startsWith("objective/"))
    return { error: "frozen_run" };
  const raw = await kv.get(runId);
  if (raw == null)
    return { error: "not_found" };
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return { error: "not_found" };
  }
  if (!record || record.run_id !== runId)
    return { error: "not_found" };
  if (FROZEN.has(record.run_id))
    return { error: "frozen_run" };
  return { record };
}
__name(readOwnRun, "readOwnRun");
async function putOwnRun(kv, runId, record) {
  if (FROZEN.has(runId) || runId === "stranger-objective" || runId.startsWith("objective/")) {
    throw new Error("refused key");
  }
  await kv.put(runId, JSON.stringify(record));
}
__name(putOwnRun, "putOwnRun");
async function callBoundary(env, path, init) {
  const origin = env && env.BOUNDARY_ORIGIN;
  if (typeof origin !== "string" || !origin.startsWith("https://"))
    return null;
  const req = new Request(`${origin.replace(/\/$/, "")}${path}`, init);
  if (env.BOUNDARY && typeof env.BOUNDARY.fetch === "function")
    return env.BOUNDARY.fetch(req);
  return fetch(req);
}
__name(callBoundary, "callBoundary");
async function readGrant(env, runId) {
  const res = await callBoundary(env, `/grant?run_id=${encodeURIComponent(runId)}`, {
    method: "GET",
    headers: { Accept: "application/json" }
  });
  if (!res)
    return null;
  if (!res.ok)
    return null;
  let body;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (!body || !body.grant || typeof body.grant.action_digest !== "string")
    return null;
  return body.grant;
}
__name(readGrant, "readGrant");
async function handleDisposableAct(request, env, origin, runId) {
  if (FROZEN.has(runId))
    return refused(origin, "frozen_run");
  const kv = env && env.OBJECTIVE;
  if (!kv || typeof kv.get !== "function") {
    return json(503, { started: false, outside_called: false, reason: "objective_store_unbound", ready: false }, origin);
  }
  const grant = await readGrant(env, runId);
  if (!grant)
    return refused(origin, "no_grant");
  const loaded = await readOwnRun(kv, runId);
  if (loaded.error === "objective_store_unbound") {
    return json(503, { started: false, outside_called: false, reason: loaded.error, ready: false }, origin);
  }
  if (loaded.error)
    return refused(origin, loaded.error === "not_found" ? "not_found" : loaded.error);
  const record = loaded.record;
  const events = Array.isArray(record.events) ? record.events : [];
  if (events.some((event) => event && event.name === "attempt")) {
    return json(200, { started: false, outside_called: false, reason: "attempt_exists", ready: false }, origin);
  }
  const digest = await actionDigest(record);
  if (grant.action_digest !== digest || grant.run_id !== record.run_id) {
    return refused(origin, "grant_mismatch");
  }
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    body = {};
  const next = {
    ...record,
    events: events.concat([{ name: "attempt", action_digest: digest, command: COMMAND }])
  };
  await putOwnRun(kv, runId, next);
  const effect = await callBoundary(env, "/effect", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      run_id: record.run_id,
      objective_id: record.objective_id,
      action_digest: digest,
      lose_ack: body.lose_ack === true
    })
  });
  let effectBody = null;
  try {
    effectBody = await effect.json();
  } catch {
    effectBody = null;
  }
  return json(
    effect.ok ? 200 : 502,
    {
      started: true,
      outside_called: true,
      effect_status: effect.status,
      effect: effectBody,
      ready: false
    },
    origin
  );
}
__name(handleDisposableAct, "handleDisposableAct");
async function handleDisposableClaim(request, env, origin, runId) {
  if (FROZEN.has(runId))
    return refused(origin, "frozen_run");
  const kv = env && env.OBJECTIVE;
  const loaded = await readOwnRun(kv, runId);
  if (loaded.error === "objective_store_unbound") {
    return json(503, { started: false, outside_called: false, reason: loaded.error, ready: false }, origin);
  }
  if (loaded.error)
    return refused(origin, loaded.error === "not_found" ? "not_found" : loaded.error);
  const record = loaded.record;
  const digest = await actionDigest(record);
  const events = Array.isArray(record.events) ? record.events : [];
  const next = {
    ...record,
    events: events.concat([{ name: "result", action_digest: digest, claim: "success" }])
  };
  await putOwnRun(kv, runId, next);
  return json(
    200,
    {
      claimed: true,
      on_run_log: true,
      wrote_receipt: false,
      outside_called: false,
      ready: false
    },
    origin
  );
}
__name(handleDisposableClaim, "handleDisposableClaim");

// src/index.js
var ALLOWED_ORIGINS = [
  "https://evaisawesome2025.github.io",
  "https://joinermill.com",
  "https://www.joinermill.com",
  "http://127.0.0.1:8765",
  "http://localhost:8765"
];
var MAX_BODY = 240;
var STRANGER_OBJECTIVE_KEY = "stranger-objective";
var OBJECTIVE_ORIGINS = Object.freeze([
  "https://joinermill.com",
  "https://www.joinermill.com"
]);
var PAID_RESEARCH_UNKNOWN_NOTES = "Paid research call blocked. Unknown: what this objective would find, what it would cost, and what result would follow. No result was written.";
var OBJECTIVE_NEXT_STEP = "paid_research (does not run)";
var PAGE_READ_UNKNOWN_NOTES = "Unknown: the page named in the sentence could not be read, or the first paragraph after the h1 was missing. The hero sentence was not written.";
var PAGE_READ_NOTES = "Paid research was not called. Ready is false. No approval was claimed. The artifact quotes the fetched page.";
var MAX_PER_WINDOW = 10;
var WINDOW_MS = 60 * 60 * 1e3;
var REPO = "Evaisawesome2025/evaos-v05";
var CRED_RE = /\b(password|api[\s_-]?key|secret|token|credit[\s_-]?card|cvv|ssn)\b/i;
var rateBucket = { resetsAt: 0, count: 0 };
function resetIngressForTests() {
  rateBucket.resetsAt = 0;
  rateBucket.count = 0;
}
__name(resetIngressForTests, "resetIngressForTests");
function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}
__name(corsHeaders, "corsHeaders");
function json2(status, data, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(origin || ALLOWED_ORIGINS[0])
    }
  });
}
__name(json2, "json");
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string")
    return false;
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  if (ba.length !== bb.length) {
    let x = 0;
    for (let i = 0; i < ba.length; i++)
      x |= ba[i] ^ ba[i];
    return false;
  }
  let diff = 0;
  for (let i = 0; i < ba.length; i++)
    diff |= ba[i] ^ bb[i];
  return diff === 0;
}
__name(timingSafeEqual, "timingSafeEqual");
function checkRate() {
  const now = Date.now();
  if (now > rateBucket.resetsAt) {
    rateBucket.resetsAt = now + WINDOW_MS;
    rateBucket.count = 0;
  }
  rateBucket.count += 1;
  return rateBucket.count <= MAX_PER_WINDOW;
}
__name(checkRate, "checkRate");
function newIntentId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
__name(newIntentId, "newIntentId");
function workspaceId(env) {
  const raw = env && env.WORKSPACE_ID;
  if (typeof raw === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(raw))
    return raw;
  return DOGFOOD_POLICY.workspace_id_default;
}
__name(workspaceId, "workspaceId");
function estimatedCogsUsd(env) {
  const raw = env && env.ASK_ESTIMATED_COGS_USD;
  if (raw == null || raw === "")
    return DOGFOOD_ASK_ESTIMATED_COGS_USD;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DOGFOOD_ASK_ESTIMATED_COGS_USD;
}
__name(estimatedCogsUsd, "estimatedCogsUsd");
function resolveLedger(env) {
  if (env && env.METERING_LEDGER && typeof env.METERING_LEDGER.preflight === "function") {
    return env.METERING_LEDGER;
  }
  if (env && env.METERING_KV && typeof env.METERING_KV.get === "function" && typeof env.METERING_KV.put === "function") {
    return createKvLedger(env.METERING_KV);
  }
  return null;
}
__name(resolveLedger, "resolveLedger");
function unboundBillableDeny(req) {
  return {
    ok: false,
    denied: true,
    reason: "hard_stop",
    code: "metering_unconfigured",
    message: "Hard stop: billable jobs are refused until the metering ledger is bound. No job was started.",
    job_id: req.job_id,
    workspace_id: req.workspace_id
  };
}
__name(unboundBillableDeny, "unboundBillableDeny");
async function preflightJob(env, req) {
  const ledger = resolveLedger(env);
  if (!req.billable) {
    if (!ledger) {
      return {
        ok: true,
        denied: false,
        decision: {
          workspace_id: req.workspace_id,
          job_id: req.job_id,
          job_class: req.job_class,
          billable: false,
          estimated_cogs_usd: 0,
          hold_wc: 0,
          soft_warn: false,
          non_billable_reason: req.non_billable_reason || "non_billable"
        }
      };
    }
    return ledger.preflight(req);
  }
  if (!ledger)
    return unboundBillableDeny(req);
  return ledger.preflight(req);
}
__name(preflightJob, "preflightJob");
function hardStopBody(gate, intentId) {
  return {
    status: "FAILED",
    error: "hard_stop",
    reason: gate && gate.reason || "hard_stop",
    code: gate && gate.code || "hard_stop",
    message: gate && gate.message || "Hard stop: this ask was not started.",
    intent_id: intentId || gate && gate.job_id || void 0,
    denied: true
  };
}
__name(hardStopBody, "hardStopBody");
function meteringComment(decision) {
  if (!decision)
    return "";
  const jobClass = String(decision.job_class || "").replace(/[^A-Za-z0-9._-]/g, "");
  const workspace = String(decision.workspace_id || "").replace(/[^A-Za-z0-9._-]/g, "");
  const hold = Number(decision.hold_wc);
  const estimated = Number(decision.estimated_cogs_usd);
  return [
    "<!-- evaos-metering",
    `billable=${decision.billable ? "1" : "0"}`,
    `hold_wc=${Number.isFinite(hold) ? hold : 0}`,
    `job_class=${jobClass}`,
    `workspace_id=${workspace}`,
    `estimated_cogs_usd=${Number.isFinite(estimated) ? estimated : 0}`,
    "-->"
  ].join(" ");
}
__name(meteringComment, "meteringComment");
async function createIssue(pat, intentId, body, kind, decision) {
  const title = (kind === "selftest" ? "Owner ask SELFTEST: " : "Owner ask: ") + body.slice(0, 80);
  const issueBody = [
    "## Owner question",
    "",
    body,
    "",
    "---",
    `<!-- evaos-v05 owner-ask intent_id=${intentId} -->`,
    meteringComment(decision),
    `**intent_id:** \`${intentId}\``,
    "**Source:** EvaOS v0.5 in-product Ask (Worker ingress)",
    "**Rules:** Public channel. No passwords, cards, private emails, or secrets.",
    "**Label:** owner-ask",
    kind === "selftest" ? "**Kind:** selftest" : "**Kind:** owner"
  ].join("\n");
  const labels = ["owner-ask"];
  if (kind === "selftest")
    labels.push("loop-selftest");
  const res = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "evaos-v05-ask-worker",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: JSON.stringify({ title, body: issueBody, labels })
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text.slice(0, 200) };
  }
  if (!res.ok) {
    const err = new Error("upstream_write_failed");
    err.status = res.status >= 500 ? 502 : 502;
    err.detail = "GitHub write failed";
    throw err;
  }
  return { number: data.number, html_url: data.html_url };
}
__name(createIssue, "createIssue");
function ownerBoundary(request, env, origin) {
  if (!env.OWNER_BEARER || !env.GH_PAT) {
    return json2(503, { status: "FAILED", error: "ingress_not_configured" }, origin);
  }
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return json2(403, { status: "FAILED", error: "origin_denied" }, origin);
  }
  const auth = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  const presented = m ? m[1].trim() : "";
  if (!presented || !timingSafeEqual(presented, env.OWNER_BEARER)) {
    return json2(401, { status: "FAILED", error: "unauthorized" }, origin);
  }
  return null;
}
__name(ownerBoundary, "ownerBoundary");
async function readJson(request) {
  try {
    return { payload: await request.json() };
  } catch {
    return { payload: null, invalid: true };
  }
}
__name(readJson, "readJson");
async function handleIntent(request, env, origin) {
  const blocked = ownerBoundary(request, env, origin);
  if (blocked)
    return blocked;
  if (!checkRate()) {
    return json2(429, { status: "FAILED", error: "rate_limited" }, origin);
  }
  const { payload, invalid } = await readJson(request);
  if (invalid)
    return json2(400, { status: "FAILED", error: "invalid_json" }, origin);
  const type = payload && payload.type || "ask";
  if (type !== "ask") {
    return json2(400, { status: "FAILED", error: "unsupported_type" }, origin);
  }
  const body = String(payload && payload.body || "").trim();
  if (!body) {
    return json2(400, { status: "FAILED", error: "empty_body" }, origin);
  }
  if (body.length > MAX_BODY) {
    return json2(400, { status: "FAILED", error: "body_too_long" }, origin);
  }
  if (CRED_RE.test(body)) {
    return json2(
      400,
      {
        status: "FAILED",
        error: "refused_credential_keywords",
        message: "Public channel \u2014 do not put passwords, tokens, or card data in Asks."
      },
      origin
    );
  }
  const kind = /\b(selftest|loop check)\b/i.test(body) || payload.selftest === true ? "selftest" : "owner";
  const intentId = newIntentId();
  const cls = classifyAskJob({ kind, job_class: payload && payload.job_class });
  const meteringReq = {
    workspace_id: workspaceId(env),
    job_id: intentId,
    job_class: cls.job_class,
    estimated_cogs_usd: cls.billable ? estimatedCogsUsd(env) : 0,
    billable: cls.billable,
    non_billable_reason: cls.non_billable_reason,
    now: /* @__PURE__ */ new Date()
  };
  const gate = await preflightJob(env, meteringReq);
  if (!gate || gate.denied || gate.ok === false) {
    return json2(403, hardStopBody(gate, intentId), origin);
  }
  const decision = gate.decision || {};
  try {
    await createIssue(env.GH_PAT, intentId, body, kind, decision);
  } catch {
    if (decision.billable && Number(decision.hold_wc) > 0) {
      const ledger = resolveLedger(env);
      if (ledger && typeof ledger.release === "function") {
        try {
          await ledger.release({
            workspace_id: meteringReq.workspace_id,
            job_id: intentId,
            reason: "write_failed"
          });
        } catch {
        }
      }
    }
    return json2(502, { status: "FAILED", error: "write_failed", intent_id: intentId }, origin);
  }
  return json2(
    201,
    {
      status: "SENT",
      intent_id: intentId,
      type: "ask",
      kind,
      billable: decision.billable === true,
      hold_wc: Number(decision.hold_wc) || 0,
      job_class: decision.job_class || cls.job_class,
      soft_warn: decision.soft_warn === true,
      message: "Ask accepted. Eva will process on the box; reply appears in EvaOS outbox."
    },
    origin
  );
}
__name(handleIntent, "handleIntent");
async function handleComplete(request, env, origin) {
  const blocked = ownerBoundary(request, env, origin);
  if (blocked)
    return blocked;
  if (!checkRate()) {
    return json2(429, { status: "FAILED", error: "rate_limited" }, origin);
  }
  const { payload, invalid } = await readJson(request);
  if (invalid || !payload || typeof payload !== "object") {
    return json2(400, { status: "FAILED", error: "invalid_json" }, origin);
  }
  const ledger = resolveLedger(env);
  if (!ledger) {
    return json2(503, hardStopBody(unboundBillableDeny({ workspace_id: workspaceId(env) })), origin);
  }
  const result = await ledger.complete({
    workspace_id: workspaceId(env),
    job_id: payload.job_id,
    job_class: payload.job_class,
    actual_cogs_usd: payload.actual_cogs_usd,
    billable: payload.billable,
    non_billable_reason: payload.non_billable_reason,
    units_note: payload.units_note,
    now: /* @__PURE__ */ new Date()
  });
  if (!result || result.ok === false || result.denied) {
    const status = result && (result.code === "invalid_job" || result.code === "invalid_actual") ? 400 : 403;
    return json2(status, hardStopBody(result), origin);
  }
  return json2(200, { ok: true, settled: true, capture: false, result: result.result }, origin);
}
__name(handleComplete, "handleComplete");
function hasText(value) {
  return typeof value === "string" && value.trim() !== "";
}
__name(hasText, "hasText");
function objectiveKv(env) {
  const kv = env && env.OBJECTIVE;
  if (!kv || kv === env.METERING_KV)
    return null;
  if (typeof kv.get !== "function" || typeof kv.put !== "function")
    return null;
  return kv;
}
__name(objectiveKv, "objectiveKv");
function applyStrangerObjective(existing, input = {}) {
  if (existing && typeof existing === "object" && hasText(existing.sentence)) {
    const record2 = { ...existing, sentence: existing.sentence };
    let changed = false;
    if (hasText(input.notes)) {
      const addition = input.notes.trim();
      const prior = hasText(record2.notes) ? record2.notes.trim() : "";
      if (!prior) {
        record2.notes = addition;
        changed = true;
      } else if (!prior.split("\n").includes(addition)) {
        record2.notes = `${prior}
${addition}`;
        changed = true;
      }
    } else if (!hasText(record2.notes)) {
      record2.notes = PAID_RESEARCH_UNKNOWN_NOTES;
      changed = true;
    }
    if (input.artifactProduced === true && hasText(input.artifact)) {
      const produced = input.artifact.trim();
      if (record2.artifact !== produced) {
        record2.artifact = produced;
        changed = true;
      }
    }
    return { record: record2, created: false, changed, run_id: record2.run_id };
  }
  const sentence = hasText(input.sentence) ? input.sentence.trim() : "";
  if (!sentence)
    return { error: "empty_sentence" };
  const time = typeof input.time === "string" && input.time ? input.time : (/* @__PURE__ */ new Date()).toISOString();
  const record = {
    sentence,
    run_id: newIntentId(),
    status: "SAVED",
    notes: PAID_RESEARCH_UNKNOWN_NOTES,
    artifact: "",
    time,
    next_step: OBJECTIVE_NEXT_STEP
  };
  return { record, created: true, changed: true, run_id: record.run_id };
}
__name(applyStrangerObjective, "applyStrangerObjective");
async function readStrangerObjective(kv) {
  const raw = await kv.get(STRANGER_OBJECTIVE_KEY);
  if (raw == null)
    return { state: "missing" };
  let parsed = raw;
  if (typeof raw === "string") {
    if (raw.trim() === "")
      return { state: "missing" };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { state: "held" };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.sentence !== "string" || parsed.sentence.trim() === "") {
    return { state: "held" };
  }
  return { state: "objective", record: parsed };
}
__name(readStrangerObjective, "readStrangerObjective");
function passFalseFailedPair(events) {
  if (!Array.isArray(events) || events.length < 2)
    return false;
  const terminal = events[events.length - 1];
  const audit = events[events.length - 2];
  if (!terminal || !audit || terminal.name !== "failed" || audit.name !== "audit")
    return false;
  if (!audit.after_state || audit.after_state.pass !== false)
    return false;
  let terminals = 0;
  let audits = 0;
  for (const event of events) {
    if (!event)
      continue;
    if (event.name === "failed" || event.name === "completed")
      terminals += 1;
    if (event.name === "audit")
      audits += 1;
  }
  return terminals === 1 && audits === 1;
}
__name(passFalseFailedPair, "passFalseFailedPair");
function projectObjectiveStatus(record) {
  const events = Array.isArray(record.events) ? record.events : [];
  if (passFalseFailedPair(events))
    return "failed";
  for (let i = events.length - 1; i >= 0; i--) {
    const status = events[i] && events[i].after_state && events[i].after_state.status;
    if (typeof status === "string" && status)
      return status;
  }
  return typeof record.status === "string" ? record.status : "";
}
__name(projectObjectiveStatus, "projectObjectiveStatus");
function objectiveFields(record) {
  return {
    sentence: record.sentence,
    run_id: record.run_id,
    status: projectObjectiveStatus(record),
    notes: record.notes,
    artifact: typeof record.artifact === "string" ? record.artifact : "",
    time: record.time,
    next_step: record.next_step,
    events: Array.isArray(record.events) ? record.events : [],
    ready: false,
    payment_fail: "not_lifted"
  };
}
__name(objectiveFields, "objectiveFields");
function objectiveBody(record, saved) {
  return { ...objectiveFields(record), saved };
}
__name(objectiveBody, "objectiveBody");
function objectiveError(status, error, origin) {
  return json2(status, { status: "FAILED", error, ready: false, payment_fail: "not_lifted" }, origin);
}
__name(objectiveError, "objectiveError");
async function handleObjective(request, env, origin) {
  if (!OBJECTIVE_ORIGINS.includes(origin)) {
    return objectiveError(403, "origin_denied", origin);
  }
  const kv = objectiveKv(env);
  if (!kv)
    return objectiveError(503, "objective_store_unbound", origin);
  const current = await readStrangerObjective(kv);
  if (current.state === "held") {
    return objectiveError(409, "objective_record_held", origin);
  }
  if (current.state === "objective") {
    return json2(200, objectiveBody(current.record, false), origin);
  }
  return objectiveError(404, "not_found", origin);
}
__name(handleObjective, "handleObjective");
function decodeHtml(text) {
  const fromCode = /* @__PURE__ */ __name((code) => {
    if (!Number.isInteger(code) || code < 0 || code > 1114111)
      return "";
    return String.fromCodePoint(code);
  }, "fromCode");
  return String(text).replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&apos;/gi, "'").replace(/&nbsp;/gi, " ").replace(/&#(\d+);/g, (all, n) => fromCode(Number(n)) || all).replace(/&#x([0-9a-f]+);/gi, (all, n) => fromCode(parseInt(n, 16)) || all);
}
__name(decodeHtml, "decodeHtml");
function elementText(fragment) {
  return decodeHtml(String(fragment).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
__name(elementText, "elementText");
function pageNamedInSentence(sentence) {
  const match = String(sentence || "").match(/https:\/\/[^\s<>"']+/i);
  if (!match)
    return "";
  let url;
  try {
    url = new URL(match[0]);
  } catch {
    return "";
  }
  if (url.protocol !== "https:")
    return "";
  if (url.username || url.password || url.port)
    return "";
  const host = url.hostname.toLowerCase();
  if (host !== "joinermill.com" && host !== "www.joinermill.com")
    return "";
  return url.href;
}
__name(pageNamedInSentence, "pageNamedInSentence");
function readObjectivePage(html) {
  const source = String(html || "");
  const h1 = /<h1\b[^>]*>[\s\S]*?<\/h1>/i.exec(source);
  if (!h1)
    return { ok: false, hero: "", saleQuote: "", notForSale: false };
  const after = source.slice(h1.index + h1[0].length);
  const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(after);
  const hero = paragraph ? elementText(paragraph[1]) : "";
  if (!hero)
    return { ok: false, hero: "", saleQuote: "", notForSale: false };
  let saleQuote = "";
  let notForSale = false;
  const blocks = source.matchAll(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi);
  for (const block of blocks) {
    const text = elementText(block[2]);
    if (!text)
      continue;
    if (/not for sale/i.test(text)) {
      saleQuote = text;
      notForSale = true;
      break;
    }
  }
  if (!saleQuote) {
    for (const block of source.matchAll(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
      const text = elementText(block[2]);
      if (text && /\bfor sale\b/i.test(text)) {
        saleQuote = text;
        break;
      }
    }
  }
  return { ok: true, hero, saleQuote, notForSale };
}
__name(readObjectivePage, "readObjectivePage");
function composeObjectiveArtifact(page, runId) {
  if (!page || !hasText(page.hero) || !hasText(runId))
    return "";
  const parts = [page.hero.trim()];
  if (hasText(page.saleQuote)) {
    parts.push(
      page.notForSale ? `Not for sale. "${page.saleQuote.trim()}"` : `"${page.saleQuote.trim()}"`
    );
  }
  parts.push(String(runId));
  return parts.join("\n\n");
}
__name(composeObjectiveArtifact, "composeObjectiveArtifact");
function artifactTextToStore(text, runId) {
  if (!hasText(text) || !hasText(runId) || !String(text).includes(runId))
    return "";
  return text;
}
__name(artifactTextToStore, "artifactTextToStore");
function objectiveReadPath(pathname) {
  if (pathname === "/objective")
    return { kind: "record" };
  const match = /^\/objective\/([^/]+)$/.exec(pathname);
  if (!match)
    return null;
  let run_id = match[1];
  try {
    run_id = decodeURIComponent(match[1]);
  } catch {
    run_id = match[1];
  }
  return { kind: "run", run_id };
}
__name(objectiveReadPath, "objectiveReadPath");
function objectiveClosePath(pathname) {
  const match = /^\/objective\/([^/]+)\/close$/.exec(pathname);
  if (!match)
    return null;
  let run_id = match[1];
  try {
    run_id = decodeURIComponent(match[1]);
  } catch {
    run_id = match[1];
  }
  if (!run_id)
    return null;
  return { run_id };
}
__name(objectiveClosePath, "objectiveClosePath");
function hasTerminalEvent(events) {
  return events.some((event) => event && (event.name === "completed" || event.name === "failed"));
}
__name(hasTerminalEvent, "hasTerminalEvent");
function validStoreId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value);
}
__name(validStoreId, "validStoreId");
function objectivePointerKey(objectiveId) {
  return `objective/${objectiveId}`;
}
__name(objectivePointerKey, "objectivePointerKey");
function parseStoredJson(raw) {
  if (raw == null)
    return null;
  let parsed = raw;
  if (typeof raw === "string") {
    if (raw.trim() === "")
      return null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  return parsed;
}
__name(parseStoredJson, "parseStoredJson");
function runEvents(record) {
  return Array.isArray(record && record.events) ? record.events : [];
}
__name(runEvents, "runEvents");
function snapshotJson(value) {
  if (value === void 0)
    return null;
  return JSON.parse(JSON.stringify(value));
}
__name(snapshotJson, "snapshotJson");
function openRunIds(records) {
  const ids = [];
  const seen = /* @__PURE__ */ new Set();
  for (const record of records) {
    if (!record || typeof record.run_id !== "string" || record.run_id === "" || seen.has(record.run_id)) {
      continue;
    }
    seen.add(record.run_id);
    if (!hasTerminalEvent(runEvents(record)))
      ids.push(record.run_id);
  }
  return ids;
}
__name(openRunIds, "openRunIds");
function pointerNames(pointer, objectiveId, runId) {
  return !!pointer && pointer.objective_id === objectiveId && pointer.open_run_id === runId;
}
__name(pointerNames, "pointerNames");
function viewObjectiveRun(record) {
  return {
    ...record,
    events: runEvents(record),
    status: projectObjectiveStatus(record)
  };
}
__name(viewObjectiveRun, "viewObjectiveRun");
function refusedRunWrite() {
  return { ok: false, error: "refused" };
}
__name(refusedRunWrite, "refusedRunWrite");
async function putRunStoreKey(kv, key, value) {
  if (key === STRANGER_OBJECTIVE_KEY) {
    throw new Error("stranger-objective is not written");
  }
  await kv.put(key, value);
}
__name(putRunStoreKey, "putRunStoreKey");
async function readObjectiveRun(kv, runId) {
  if (!validStoreId(runId) || runId === STRANGER_OBJECTIVE_KEY)
    return null;
  const run1 = parseStoredJson(await kv.get(STRANGER_OBJECTIVE_KEY));
  if (run1 && run1.run_id === runId)
    return viewObjectiveRun(run1);
  const own = parseStoredJson(await kv.get(runId));
  if (!own || own.run_id !== runId)
    return null;
  return viewObjectiveRun(own);
}
__name(readObjectiveRun, "readObjectiveRun");
async function writeObjectiveRun(kv, input) {
  const objectiveId = input && input.objective_id;
  const runId = input && input.run_id;
  const incoming = input && input.events;
  if (!validStoreId(objectiveId) || !validStoreId(runId))
    return refusedRunWrite();
  if (objectiveId === runId || runId === STRANGER_OBJECTIVE_KEY)
    return refusedRunWrite();
  if (!Array.isArray(incoming))
    return refusedRunWrite();
  const pointerKey = objectivePointerKey(objectiveId);
  if (pointerKey === STRANGER_OBJECTIVE_KEY || pointerKey === runId)
    return refusedRunWrite();
  const run1 = parseStoredJson(await kv.get(STRANGER_OBJECTIVE_KEY));
  if (run1 && run1.run_id === runId)
    return refusedRunWrite();
  const pointer = parseStoredJson(await kv.get(pointerKey));
  const existing = parseStoredJson(await kv.get(runId));
  if (existing && (existing.run_id !== runId || existing.objective_id !== objectiveId)) {
    return refusedRunWrite();
  }
  if (existing && hasTerminalEvent(runEvents(existing)))
    return refusedRunWrite();
  const added = snapshotJson(incoming);
  const prior = existing ? runEvents(existing) : [];
  const nextEvents = prior.concat(added);
  if (!existing && hasTerminalEvent(nextEvents))
    return refusedRunWrite();
  const evidence = input.evidence === void 0 ? existing ? existing.evidence ?? null : null : snapshotJson(input.evidence);
  const verdict = input.verdict === void 0 ? existing ? existing.verdict ?? null : null : snapshotJson(input.verdict);
  const next = {
    run_id: runId,
    objective_id: objectiveId,
    events: nextEvents,
    evidence,
    verdict
  };
  const known = [];
  if (run1 && typeof run1.run_id === "string")
    known.push(run1);
  if (existing)
    known.push(existing);
  if (pointer && typeof pointer.open_run_id === "string" && pointer.open_run_id !== runId && (!run1 || pointer.open_run_id !== run1.run_id)) {
    const pointed = parseStoredJson(await kv.get(pointer.open_run_id));
    if (pointed && pointed.run_id === pointer.open_run_id)
      known.push(pointed);
  }
  const currentOpen = openRunIds(known);
  if (currentOpen.length > 1)
    return refusedRunWrite();
  if (currentOpen.length === 1 && !pointerNames(pointer, objectiveId, currentOpen[0])) {
    return refusedRunWrite();
  }
  const resulting = currentOpen.filter((id) => id !== runId);
  if (!hasTerminalEvent(nextEvents))
    resulting.push(runId);
  if (new Set(resulting).size > 1)
    return refusedRunWrite();
  const runJson = JSON.stringify(next);
  await putRunStoreKey(kv, runId, runJson);
  if (!existing) {
    await putRunStoreKey(
      kv,
      pointerKey,
      JSON.stringify({ objective_id: objectiveId, open_run_id: runId })
    );
  }
  return { ok: true };
}
__name(writeObjectiveRun, "writeObjectiveRun");
async function handleObjectiveClose(request, env, origin, path) {
  const blocked = ownerBoundary(request, env, origin);
  if (blocked)
    return blocked;
  if (!checkRate()) {
    return json2(429, { status: "FAILED", error: "rate_limited" }, origin);
  }
  const kv = objectiveKv(env);
  if (!kv)
    return objectiveError(503, "objective_store_unbound", origin);
  const current = await readStrangerObjective(kv);
  if (current.state === "held") {
    return objectiveError(409, "objective_record_held", origin);
  }
  if (current.state !== "objective") {
    return objectiveError(404, "not_found", origin);
  }
  if (current.state === "objective" && path.run_id === current.record.run_id) {
    return objectiveError(409, "terminal_exists", origin);
  }
  const other = await readObjectiveRun(kv, path.run_id);
  if (!other)
    return objectiveError(404, "not_found", origin);
  return objectiveError(409, "terminal_exists", origin);
}
__name(handleObjectiveClose, "handleObjectiveClose");
function httpObjectiveView(record) {
  return {
    ...viewObjectiveRun(record),
    ready: false,
    payment_fail: "not_lifted"
  };
}
__name(httpObjectiveView, "httpObjectiveView");
function pointerRecord(raw, key) {
  const parsed = parseStoredJson(raw);
  if (!parsed)
    return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !keys.includes("objective_id") || !keys.includes("open_run_id"))
    return null;
  if (typeof parsed.objective_id !== "string" || typeof parsed.open_run_id !== "string")
    return null;
  if (!validStoreId(parsed.objective_id) || !validStoreId(parsed.open_run_id))
    return null;
  if (parsed.objective_id === parsed.open_run_id)
    return null;
  if (key !== objectivePointerKey(parsed.objective_id))
    return null;
  return { objective_id: parsed.objective_id, open_run_id: parsed.open_run_id };
}
__name(pointerRecord, "pointerRecord");
async function listObjectivePointerKeys(kv) {
  if (!kv || typeof kv.list !== "function")
    return [];
  const found = [];
  let cursor;
  for (let page = 0; page < 5; page++) {
    const listed = await kv.list(cursor ? { prefix: "objective/", cursor } : { prefix: "objective/" });
    const keys = listed && Array.isArray(listed.keys) ? listed.keys : [];
    for (const item of keys) {
      const name = typeof item === "string" ? item : item && item.name;
      if (typeof name === "string" && name.startsWith("objective/"))
        found.push(name);
    }
    if (!listed || listed.list_complete !== false || !listed.cursor)
      break;
    cursor = listed.cursor;
  }
  return found;
}
__name(listObjectivePointerKeys, "listObjectivePointerKeys");
async function readAgreedOpenRun(kv) {
  const run1 = parseStoredJson(await kv.get(STRANGER_OBJECTIVE_KEY));
  const run1Record = run1 && typeof run1.run_id === "string" && run1.run_id ? run1 : null;
  const pointerKeys = await listObjectivePointerKeys(kv);
  const pointers = [];
  for (const key of pointerKeys) {
    const pointer2 = pointerRecord(await kv.get(key), key);
    if (pointer2)
      pointers.push(pointer2);
  }
  if (pointers.length !== 1)
    return null;
  const pointer = pointers[0];
  const known = [];
  if (run1Record)
    known.push(run1Record);
  if (!run1Record || pointer.open_run_id !== run1Record.run_id) {
    const pointed = parseStoredJson(await kv.get(pointer.open_run_id));
    if (pointed && pointed.run_id === pointer.open_run_id && pointed.objective_id === pointer.objective_id) {
      known.push(pointed);
    }
  }
  const openIds = openRunIds(known);
  if (openIds.length !== 1 || openIds[0] !== pointer.open_run_id)
    return null;
  const open = known.find((record) => record.run_id === openIds[0]);
  return open || null;
}
__name(readAgreedOpenRun, "readAgreedOpenRun");
async function handleObjectiveRead(env, origin, path) {
  const kv = objectiveKv(env);
  if (!kv)
    return objectiveError(503, "objective_store_unbound", origin);
  if (path.kind === "run") {
    const record = await readObjectiveRun(kv, path.run_id);
    if (!record)
      return objectiveError(404, "not_found", origin);
    return json2(200, httpObjectiveView(record), origin);
  }
  const open = await readAgreedOpenRun(kv);
  if (!open)
    return objectiveError(404, "not_found", origin);
  return json2(200, httpObjectiveView(open), origin);
}
__name(handleObjectiveRead, "handleObjectiveRead");
var src_default = {
  async fetch(request, env = {}) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return json2(
        200,
        {
          ok: true,
          service: "evaos-v05-ask",
          write_enabled: !!(env.OWNER_BEARER && env.GH_PAT),
          hard_stop_guard: true,
          ready: false,
          payment_fail: "not_lifted"
        },
        origin
      );
    }
    if (request.method === "POST" && url.pathname === "/intent") {
      return handleIntent(request, env, origin);
    }
    if (request.method === "POST" && url.pathname === "/metering/complete") {
      return handleComplete(request, env, origin);
    }
    if (request.method === "POST" && url.pathname === "/objective") {
      return handleObjective(request, env, origin);
    }
    if (request.method === "POST") {
      const actPath = disposableActPath(url.pathname);
      if (actPath)
        return handleDisposableAct(request, env, origin, actPath);
      const claimPath = disposableClaimPath(url.pathname);
      if (claimPath)
        return handleDisposableClaim(request, env, origin, claimPath);
      const closePath = objectiveClosePath(url.pathname);
      if (closePath)
        return handleObjectiveClose(request, env, origin, closePath);
    }
    if (request.method === "GET") {
      const objectivePath = objectiveReadPath(url.pathname);
      if (objectivePath)
        return handleObjectiveRead(env, origin, objectivePath);
    }
    return json2(404, { status: "FAILED", error: "not_found" }, origin);
  }
};
export {
  OBJECTIVE_NEXT_STEP,
  PAGE_READ_NOTES,
  PAGE_READ_UNKNOWN_NOTES,
  PAID_RESEARCH_UNKNOWN_NOTES,
  applyStrangerObjective,
  artifactTextToStore,
  composeObjectiveArtifact,
  src_default as default,
  objectivePointerKey,
  pageNamedInSentence,
  readObjectivePage,
  readObjectiveRun,
  resetIngressForTests,
  writeObjectiveRun
};
//# sourceMappingURL=index.js.map
