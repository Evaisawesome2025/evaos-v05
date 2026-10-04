/**
 * EvaOS v0.5 — trusted Ask ingress (Cloudflare Worker)
 * POST /intent  Authorization: Bearer <OWNER_BEARER>
 * Body: { "type": "ask", "body": "<plain text ≤240>" }
 * Creates a hidden GitHub Issue (plumbing). Secrets only in env — never in client/git.
 *
 * Billable owner asks call the hard-stop preflight before that write.
 * Deny returns a hard_stop error and does not create the issue.
 * Allow records a work-credit hold first (KV when METERING_KV is bound).
 * DEMO / REPLAY / SELFTEST / SAMPLE stay non-billable.
 * Payment FAIL is not lifted. This worker does not capture or charge.
 *
 * POST /metering/complete  — same bearer; settles a hold into a JOB_COST row.
 * GET  /health  — liveness (no secrets)
 * OPTIONS       — CORS preflight
 *
 * POST /objective — one sentence on the key stranger-objective. The run id is
 * created once. A clean post stores that sentence, then reads the public
 * joinermill page named in the sentence and may write one artifact on the
 * same record. A later post keeps the sentence and the run id and does not
 * write another artifact. Ready stays false.
 * GET  /objective — read that one record, including its events. No write.
 * GET  /objective/<run_id> — that same record when the run id matches, else 404.
 * POST /objective/<run_id>/close — Authorization: Bearer <OWNER_BEARER>,
 * the same owner boundary as POST /intent. On the stored record for that
 * run id only, appends one audit event and then exactly one terminal event
 * (completed or failed). The audit cites the caller's audit id and does not
 * record a pass. The terminal carries the caller's failure reasons. The
 * sentence, artifact, and run id stay. Status on a read is a projection of
 * the events. The read writes nothing. Repeating the stored pass-false
 * failed pair does not append. If that pair is stored and status is still
 * SAVED, the same call sets status to failed and does not append. A
 * different terminal or verdict writes nothing.
 */
import {
  DOGFOOD_POLICY,
  DOGFOOD_ASK_ESTIMATED_COGS_USD,
  classifyAskJob,
  createKvLedger,
} from "./hardstop.js";

const ALLOWED_ORIGINS = [
  "https://evaisawesome2025.github.io",
  "https://joinermill.com",
  "https://www.joinermill.com",
  "http://127.0.0.1:8765",
  "http://localhost:8765",
];
const MAX_BODY = 240;
const STRANGER_OBJECTIVE_KEY = "stranger-objective";
const OBJECTIVE_ORIGINS = Object.freeze([
  "https://joinermill.com",
  "https://www.joinermill.com",
]);
export const PAID_RESEARCH_UNKNOWN_NOTES =
  "Paid research call blocked. Unknown: what this objective would find, what it would cost, and what result would follow. No result was written.";
export const OBJECTIVE_NEXT_STEP = "paid_research (does not run)";
export const PAGE_READ_UNKNOWN_NOTES =
  "Unknown: the page named in the sentence could not be read, or the first paragraph after the h1 was missing. The hero sentence was not written.";
export const PAGE_READ_NOTES =
  "Paid research was not called. Ready is false. No approval was claimed. The artifact quotes the fetched page.";
const OBJECTIVE_EVENT_NAMES = new Set([
  "received",
  "saved",
  "owner",
  "work started",
  "artifact",
  "record updated",
  "audit",
  "result",
  "completed",
  "failed",
]);
const MAX_PER_WINDOW = 10;
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const REPO = "Evaisawesome2025/evaos-v05";
const CRED_RE = /\b(password|api[\s_-]?key|secret|token|credit[\s_-]?card|cvv|ssn)\b/i;

/** In-isolate rate bucket (best-effort on free Workers; not global durable). */
const rateBucket = { resetsAt: 0, count: 0 };

export function resetIngressForTests() {
  rateBucket.resetsAt = 0;
  rateBucket.count = 0;
}

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(status, data, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(origin || ALLOWED_ORIGINS[0]),
    },
  });
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  if (ba.length !== bb.length) {
    // still compare to reduce obvious timing oracle on length alone
    let x = 0;
    for (let i = 0; i < ba.length; i++) x |= ba[i] ^ ba[i];
    return false;
  }
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

function checkRate() {
  const now = Date.now();
  if (now > rateBucket.resetsAt) {
    rateBucket.resetsAt = now + WINDOW_MS;
    rateBucket.count = 0;
  }
  rateBucket.count += 1;
  return rateBucket.count <= MAX_PER_WINDOW;
}

function newIntentId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function workspaceId(env) {
  const raw = env && env.WORKSPACE_ID;
  if (typeof raw === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(raw)) return raw;
  return DOGFOOD_POLICY.workspace_id_default;
}

function estimatedCogsUsd(env) {
  const raw = env && env.ASK_ESTIMATED_COGS_USD;
  if (raw == null || raw === "") return DOGFOOD_ASK_ESTIMATED_COGS_USD;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DOGFOOD_ASK_ESTIMATED_COGS_USD;
}

function resolveLedger(env) {
  if (env && env.METERING_LEDGER && typeof env.METERING_LEDGER.preflight === "function") {
    return env.METERING_LEDGER;
  }
  if (
    env &&
    env.METERING_KV &&
    typeof env.METERING_KV.get === "function" &&
    typeof env.METERING_KV.put === "function"
  ) {
    return createKvLedger(env.METERING_KV);
  }
  return null;
}

function unboundBillableDeny(req) {
  return {
    ok: false,
    denied: true,
    reason: "hard_stop",
    code: "metering_unconfigured",
    message:
      "Hard stop: billable jobs are refused until the metering ledger is bound. No job was started.",
    job_id: req.job_id,
    workspace_id: req.workspace_id,
  };
}

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
          non_billable_reason: req.non_billable_reason || "non_billable",
        },
      };
    }
    return ledger.preflight(req);
  }
  if (!ledger) return unboundBillableDeny(req);
  return ledger.preflight(req);
}

function hardStopBody(gate, intentId) {
  return {
    status: "FAILED",
    error: "hard_stop",
    reason: (gate && gate.reason) || "hard_stop",
    code: (gate && gate.code) || "hard_stop",
    message: (gate && gate.message) || "Hard stop: this ask was not started.",
    intent_id: intentId || (gate && gate.job_id) || undefined,
    denied: true,
  };
}

function meteringComment(decision) {
  if (!decision) return "";
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
    "-->",
  ].join(" ");
}

async function createIssue(pat, intentId, body, kind, decision) {
  const title =
    (kind === "selftest" ? "Owner ask SELFTEST: " : "Owner ask: ") +
    body.slice(0, 80);
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
    kind === "selftest" ? "**Kind:** selftest" : "**Kind:** owner",
  ].join("\n");

  const labels = ["owner-ask"];
  if (kind === "selftest") labels.push("loop-selftest");

  const res = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "evaos-v05-ask-worker",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ title, body: issueBody, labels }),
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
    // never attach GH error body with potential leak to client
    throw err;
  }
  return { number: data.number, html_url: data.html_url };
}

function ownerBoundary(request, env, origin) {
  if (!env.OWNER_BEARER || !env.GH_PAT) {
    return json(503, { status: "FAILED", error: "ingress_not_configured" }, origin);
  }
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return json(403, { status: "FAILED", error: "origin_denied" }, origin);
  }
  const auth = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  const presented = m ? m[1].trim() : "";
  if (!presented || !timingSafeEqual(presented, env.OWNER_BEARER)) {
    return json(401, { status: "FAILED", error: "unauthorized" }, origin);
  }
  return null;
}

async function readJson(request) {
  try {
    return { payload: await request.json() };
  } catch {
    return { payload: null, invalid: true };
  }
}

async function handleIntent(request, env, origin) {
  const blocked = ownerBoundary(request, env, origin);
  if (blocked) return blocked;
  if (!checkRate()) {
    return json(429, { status: "FAILED", error: "rate_limited" }, origin);
  }
  const { payload, invalid } = await readJson(request);
  if (invalid) return json(400, { status: "FAILED", error: "invalid_json" }, origin);

  const type = (payload && payload.type) || "ask";
  if (type !== "ask") {
    return json(400, { status: "FAILED", error: "unsupported_type" }, origin);
  }

  const body = String((payload && payload.body) || "").trim();
  if (!body) {
    return json(400, { status: "FAILED", error: "empty_body" }, origin);
  }
  if (body.length > MAX_BODY) {
    return json(400, { status: "FAILED", error: "body_too_long" }, origin);
  }
  if (CRED_RE.test(body)) {
    return json(
      400,
      {
        status: "FAILED",
        error: "refused_credential_keywords",
        message: "Public channel — do not put passwords, tokens, or card data in Asks.",
      },
      origin
    );
  }

  const kind =
    /\b(selftest|loop check)\b/i.test(body) || payload.selftest === true ? "selftest" : "owner";
  const intentId = newIntentId();
  const cls = classifyAskJob({ kind, job_class: payload && payload.job_class });
  const meteringReq = {
    workspace_id: workspaceId(env),
    job_id: intentId,
    job_class: cls.job_class,
    estimated_cogs_usd: cls.billable ? estimatedCogsUsd(env) : 0,
    billable: cls.billable,
    non_billable_reason: cls.non_billable_reason,
    now: new Date(),
  };
  const gate = await preflightJob(env, meteringReq);
  if (!gate || gate.denied || gate.ok === false) {
    return json(403, hardStopBody(gate, intentId), origin);
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
            reason: "write_failed",
          });
        } catch {
          // Hold stays reserved if the release write fails. Conservative.
        }
      }
    }
    return json(502, { status: "FAILED", error: "write_failed", intent_id: intentId }, origin);
  }

  // Honest state: SENT (accepted by trusted boundary). PROCESSING/ANSWERED come from outbox.
  // Do NOT return issue number/url — transport_ref stays hidden from owner UI.
  return json(
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
      message: "Ask accepted. Eva will process on the box; reply appears in EvaOS outbox.",
    },
    origin
  );
}

async function handleComplete(request, env, origin) {
  const blocked = ownerBoundary(request, env, origin);
  if (blocked) return blocked;
  if (!checkRate()) {
    return json(429, { status: "FAILED", error: "rate_limited" }, origin);
  }
  const { payload, invalid } = await readJson(request);
  if (invalid || !payload || typeof payload !== "object") {
    return json(400, { status: "FAILED", error: "invalid_json" }, origin);
  }
  const ledger = resolveLedger(env);
  if (!ledger) {
    return json(503, hardStopBody(unboundBillableDeny({ workspace_id: workspaceId(env) })), origin);
  }
  const result = await ledger.complete({
    workspace_id: workspaceId(env),
    job_id: payload.job_id,
    job_class: payload.job_class,
    actual_cogs_usd: payload.actual_cogs_usd,
    billable: payload.billable,
    non_billable_reason: payload.non_billable_reason,
    units_note: payload.units_note,
    now: new Date(),
  });
  if (!result || result.ok === false || result.denied) {
    const status = result && (result.code === "invalid_job" || result.code === "invalid_actual") ? 400 : 403;
    return json(status, hardStopBody(result), origin);
  }
  return json(200, { ok: true, settled: true, capture: false, result: result.result }, origin);
}

function hasText(value) {
  return typeof value === "string" && value.trim() !== "";
}

function objectiveKv(env) {
  const kv = env && env.OBJECTIVE;
  if (!kv || kv === env.METERING_KV) return null;
  if (typeof kv.get !== "function" || typeof kv.put !== "function") return null;
  return kv;
}

/**
 * Sentence is immutable once stored. Notes may be appended on the same record.
 * An artifact is stored only when artifactProduced is set after real work.
 * The sentence-saving post does not set that flag.
 */
export function applyStrangerObjective(existing, input = {}) {
  if (existing && typeof existing === "object" && hasText(existing.sentence)) {
    const record = { ...existing, sentence: existing.sentence };
    let changed = false;

    if (hasText(input.notes)) {
      const addition = input.notes.trim();
      const prior = hasText(record.notes) ? record.notes.trim() : "";
      if (!prior) {
        record.notes = addition;
        changed = true;
      } else if (!prior.split("\n").includes(addition)) {
        record.notes = `${prior}\n${addition}`;
        changed = true;
      }
    } else if (!hasText(record.notes)) {
      record.notes = PAID_RESEARCH_UNKNOWN_NOTES;
      changed = true;
    }

    if (input.artifactProduced === true && hasText(input.artifact)) {
      const produced = input.artifact.trim();
      if (record.artifact !== produced) {
        record.artifact = produced;
        changed = true;
      }
    }

    return { record, created: false, changed, run_id: record.run_id };
  }

  const sentence = hasText(input.sentence) ? input.sentence.trim() : "";
  if (!sentence) return { error: "empty_sentence" };

  const time = typeof input.time === "string" && input.time ? input.time : new Date().toISOString();
  const record = {
    sentence,
    run_id: newIntentId(),
    status: "SAVED",
    notes: PAID_RESEARCH_UNKNOWN_NOTES,
    artifact: "",
    time,
    next_step: OBJECTIVE_NEXT_STEP,
  };
  return { record, created: true, changed: true, run_id: record.run_id };
}

async function readStrangerObjective(kv) {
  const raw = await kv.get(STRANGER_OBJECTIVE_KEY);
  if (raw == null) return { state: "missing" };
  let parsed = raw;
  if (typeof raw === "string") {
    if (raw.trim() === "") return { state: "missing" };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { state: "held" };
    }
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof parsed.sentence !== "string" ||
    parsed.sentence.trim() === ""
  ) {
    return { state: "held" };
  }
  return { state: "objective", record: parsed };
}

function passFalseFailedPair(events) {
  if (!Array.isArray(events) || events.length < 2) return false;
  const terminal = events[events.length - 1];
  const audit = events[events.length - 2];
  if (!terminal || !audit || terminal.name !== "failed" || audit.name !== "audit") return false;
  if (!audit.after_state || audit.after_state.pass !== false) return false;
  let terminals = 0;
  let audits = 0;
  for (const event of events) {
    if (!event) continue;
    if (event.name === "failed" || event.name === "completed") terminals += 1;
    if (event.name === "audit") audits += 1;
  }
  return terminals === 1 && audits === 1;
}

function projectObjectiveStatus(record) {
  const events = Array.isArray(record.events) ? record.events : [];
  if (passFalseFailedPair(events)) return "failed";
  for (let i = events.length - 1; i >= 0; i--) {
    const status = events[i] && events[i].after_state && events[i].after_state.status;
    if (typeof status === "string" && status) return status;
  }
  return typeof record.status === "string" ? record.status : "";
}

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
    payment_fail: "not_lifted",
  };
}

function objectiveBody(record, saved) {
  return { ...objectiveFields(record), saved };
}

function objectiveError(status, error, origin) {
  return json(status, { status: "FAILED", error, ready: false, payment_fail: "not_lifted" }, origin);
}

async function handleObjective(request, env, origin) {
  if (!OBJECTIVE_ORIGINS.includes(origin)) {
    return objectiveError(403, "origin_denied", origin);
  }
  const kv = objectiveKv(env);
  if (!kv) return objectiveError(503, "objective_store_unbound", origin);

  const current = await readStrangerObjective(kv);
  if (current.state === "held") {
    return objectiveError(409, "objective_record_held", origin);
  }

  if (current.state === "objective") {
    return json(200, objectiveBody(current.record, false), origin);
  }

  const { payload, invalid } = await readJson(request);
  if (invalid || !payload || typeof payload !== "object") {
    return objectiveError(400, "invalid_json", origin);
  }
  if (typeof payload.sentence !== "string" || !payload.sentence.trim()) {
    return objectiveError(400, "empty_sentence", origin);
  }
  const sentence = payload.sentence.trim();
  if (sentence.length > MAX_BODY) {
    return objectiveError(400, "body_too_long", origin);
  }
  if (CRED_RE.test(sentence)) {
    return objectiveError(400, "refused_credential_keywords", origin);
  }

  const time = new Date().toISOString();
  const applied = applyStrangerObjective(null, { sentence, time });
  const runId = applied.record.run_id;
  const events = [
    objectiveEvent("received", runId, time, { present: false }, { present: false, ready: false }),
    objectiveEvent(
      "saved",
      runId,
      time,
      { sentence: "", status: "", ready: false },
      { sentence, status: "SAVED", ready: false }
    ),
    objectiveEvent(
      "owner",
      runId,
      time,
      { ready: false },
      { ready: false, approval: false }
    ),
    objectiveEvent(
      "work started",
      runId,
      time,
      { work: "not_started", ready: false, approval: false },
      { work: "started", ready: false, approval: false }
    ),
  ];
  let record = { ...applied.record, notes: "", artifact: "", events };
  await kv.put(STRANGER_OBJECTIVE_KEY, JSON.stringify(record));

  const page = await readNamedPage(sentence);
  if (!page.ok) {
    events.push(
      objectiveEvent(
        "failed",
        runId,
        time,
        { artifact: "", status: "SAVED" },
        { artifact: "", status: "SAVED", unknown: true, ready: false }
      )
    );
    record = { ...record, status: "SAVED", artifact: "", notes: PAGE_READ_UNKNOWN_NOTES, events };
    await kv.put(STRANGER_OBJECTIVE_KEY, JSON.stringify(record));
    return json(201, objectiveBody(record, true), origin);
  }

  const artifact = artifactTextToStore(composeObjectiveArtifact(page, runId), runId);
  if (!artifact) {
    record = { ...record, status: "SAVED", artifact: "", notes: PAGE_READ_UNKNOWN_NOTES, events };
    await kv.put(STRANGER_OBJECTIVE_KEY, JSON.stringify(record));
    return json(201, objectiveBody(record, true), origin);
  }

  events.push(objectiveEvent("artifact", runId, time, { artifact: "" }, { artifact }));
  events.push(
    objectiveEvent(
      "record updated",
      runId,
      time,
      { artifact: "", status: "SAVED", ready: false },
      { artifact, status: "SAVED", ready: false }
    )
  );
  events.push(
    objectiveEvent(
      "result",
      runId,
      time,
      { status: "SAVED", ready: false, approval: false },
      { status: "SAVED", ready: false, approval: false }
    )
  );
  const notes = page.saleQuote
    ? PAGE_READ_NOTES
    : `${PAGE_READ_NOTES} Unknown: the page does not say whether it is for sale.`;
  record = { ...record, status: "SAVED", artifact, notes, events };
  await kv.put(STRANGER_OBJECTIVE_KEY, JSON.stringify(record));
  return json(201, objectiveBody(record, true), origin);
}

function objectiveEvent(name, runId, time, beforeState, afterState) {
  if (!OBJECTIVE_EVENT_NAMES.has(name)) return null;
  return {
    name,
    run_id: runId,
    time,
    who: "worker",
    before_state: beforeState,
    after_state: afterState,
  };
}

function decodeHtml(text) {
  const fromCode = (code) => {
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return "";
    return String.fromCodePoint(code);
  };
  return String(text)
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (all, n) => fromCode(Number(n)) || all)
    .replace(/&#x([0-9a-f]+);/gi, (all, n) => fromCode(parseInt(n, 16)) || all);
}

function elementText(fragment) {
  return decodeHtml(String(fragment).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function pageNamedInSentence(sentence) {
  const match = String(sentence || "").match(/https:\/\/[^\s<>"']+/i);
  if (!match) return "";
  let url;
  try {
    url = new URL(match[0]);
  } catch {
    return "";
  }
  if (url.protocol !== "https:") return "";
  if (url.username || url.password || url.port) return "";
  const host = url.hostname.toLowerCase();
  if (host !== "joinermill.com" && host !== "www.joinermill.com") return "";
  return url.href;
}

export function readObjectivePage(html) {
  const source = String(html || "");
  const h1 = /<h1\b[^>]*>[\s\S]*?<\/h1>/i.exec(source);
  if (!h1) return { ok: false, hero: "", saleQuote: "", notForSale: false };
  const after = source.slice(h1.index + h1[0].length);
  const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(after);
  const hero = paragraph ? elementText(paragraph[1]) : "";
  if (!hero) return { ok: false, hero: "", saleQuote: "", notForSale: false };

  let saleQuote = "";
  let notForSale = false;
  const blocks = source.matchAll(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi);
  for (const block of blocks) {
    const text = elementText(block[2]);
    if (!text) continue;
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

export function composeObjectiveArtifact(page, runId) {
  if (!page || !hasText(page.hero) || !hasText(runId)) return "";
  const parts = [page.hero.trim()];
  if (hasText(page.saleQuote)) {
    parts.push(
      page.notForSale ? `Not for sale. "${page.saleQuote.trim()}"` : `"${page.saleQuote.trim()}"`
    );
  }
  parts.push(String(runId));
  return parts.join("\n\n");
}

export function artifactTextToStore(text, runId) {
  if (!hasText(text) || !hasText(runId) || !String(text).includes(runId)) return "";
  return text;
}

async function readNamedPage(sentence) {
  const pageUrl = pageNamedInSentence(sentence);
  if (!pageUrl) return { ok: false, hero: "", saleQuote: "", notForSale: false };
  let res;
  try {
    res = await fetch(pageUrl, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "text/html", "User-Agent": "evaos-v05-ask-worker" },
    });
  } catch {
    return { ok: false, hero: "", saleQuote: "", notForSale: false };
  }
  if (!res || !res.ok) return { ok: false, hero: "", saleQuote: "", notForSale: false };
  let html = "";
  try {
    html = await res.text();
  } catch {
    return { ok: false, hero: "", saleQuote: "", notForSale: false };
  }
  if (html.length > 1000000) return { ok: false, hero: "", saleQuote: "", notForSale: false };
  return readObjectivePage(html);
}

function objectiveView(record) {
  return objectiveFields(record);
}

function objectiveReadPath(pathname) {
  if (pathname === "/objective") return { kind: "record" };
  const match = /^\/objective\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  let run_id = match[1];
  try {
    run_id = decodeURIComponent(match[1]);
  } catch {
    run_id = match[1];
  }
  return { kind: "run", run_id };
}

function objectiveClosePath(pathname) {
  const match = /^\/objective\/([^/]+)\/close$/.exec(pathname);
  if (!match) return null;
  let run_id = match[1];
  try {
    run_id = decodeURIComponent(match[1]);
  } catch {
    run_id = match[1];
  }
  if (!run_id) return null;
  return { run_id };
}

function hasTerminalEvent(events) {
  return events.some((event) => event && (event.name === "completed" || event.name === "failed"));
}

async function handleObjectiveClose(request, env, origin, path) {
  const blocked = ownerBoundary(request, env, origin);
  if (blocked) return blocked;
  if (!checkRate()) {
    return json(429, { status: "FAILED", error: "rate_limited" }, origin);
  }
  const kv = objectiveKv(env);
  if (!kv) return objectiveError(503, "objective_store_unbound", origin);

  const current = await readStrangerObjective(kv);
  if (current.state === "held") {
    return objectiveError(409, "objective_record_held", origin);
  }
  if (current.state !== "objective") {
    return objectiveError(404, "not_found", origin);
  }
  const record = current.record;
  if (path.run_id !== record.run_id) {
    return objectiveError(404, "not_found", origin);
  }

  const events = Array.isArray(record.events) ? record.events : [];
  if (passFalseFailedPair(events)) {
    const { payload, invalid } = await readJson(request);
    if (invalid || !payload || typeof payload !== "object" || Array.isArray(payload)) {
      return objectiveError(400, "invalid_json", origin);
    }
    if (payload.terminal !== "completed" && payload.terminal !== "failed") {
      return objectiveError(400, "invalid_terminal", origin);
    }
    if (payload.terminal !== "failed" || payload.pass === true) {
      return objectiveError(409, "terminal_exists", origin);
    }
    if (record.status !== "SAVED") {
      return json(200, objectiveBody(record, false), origin);
    }
    const next = {
      ...record,
      sentence: record.sentence,
      artifact: typeof record.artifact === "string" ? record.artifact : "",
      run_id: record.run_id,
      notes: record.notes,
      status: "failed",
      events,
    };
    await kv.put(STRANGER_OBJECTIVE_KEY, JSON.stringify(next));
    return json(200, objectiveBody(next, false), origin);
  }
  if (hasTerminalEvent(events)) {
    return objectiveError(409, "terminal_exists", origin);
  }

  const { payload, invalid } = await readJson(request);
  if (invalid || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return objectiveError(400, "invalid_json", origin);
  }
  if (typeof payload.audit_id !== "string" || !payload.audit_id.trim() || payload.audit_id.trim().length > MAX_BODY) {
    return objectiveError(400, "invalid_audit", origin);
  }
  if (payload.terminal !== "completed" && payload.terminal !== "failed") {
    return objectiveError(400, "invalid_terminal", origin);
  }
  let reasons = [];
  if (payload.reasons != null) {
    if (!Array.isArray(payload.reasons) || payload.reasons.length > 20) {
      return objectiveError(400, "invalid_reasons", origin);
    }
    for (const item of payload.reasons) {
      if (typeof item !== "string") return objectiveError(400, "invalid_reasons", origin);
      const reason = item.trim();
      if (!reason || reason.length > MAX_BODY) return objectiveError(400, "invalid_reasons", origin);
      reasons.push(reason);
    }
  }
  const auditId = payload.audit_id.trim();
  const terminal = payload.terminal;
  if (CRED_RE.test(`${auditId}\n${reasons.join("\n")}`)) {
    return objectiveError(400, "refused_credential_keywords", origin);
  }

  const time = new Date().toISOString();
  const runId = record.run_id;
  const open = { pass: false, ready: false, approval: false };
  const nextEvents = events.slice();
  if (!nextEvents.some((event) => event && event.name === "audit")) {
    nextEvents.push(
      objectiveEvent("audit", runId, time, { audit_id: "", ...open }, { audit_id: auditId, ...open })
    );
  }
  nextEvents.push(
    objectiveEvent(
      terminal,
      runId,
      time,
      { terminal: "", reasons: [], ...open },
      { terminal, reasons, ...open }
    )
  );
  const next = {
    ...record,
    sentence: record.sentence,
    artifact: typeof record.artifact === "string" ? record.artifact : "",
    run_id: runId,
    events: nextEvents,
  };
  await kv.put(STRANGER_OBJECTIVE_KEY, JSON.stringify(next));
  return json(200, objectiveBody(next, false), origin);
}

async function handleObjectiveRead(env, origin, path) {
  const kv = objectiveKv(env);
  if (!kv) return objectiveError(503, "objective_store_unbound", origin);

  const current = await readStrangerObjective(kv);
  if (current.state !== "objective") {
    return objectiveError(404, "not_found", origin);
  }
  if (path.kind === "run" && path.run_id !== current.record.run_id) {
    return objectiveError(404, "not_found", origin);
  }
  return json(200, objectiveView(current.record), origin);
}

export default {
  async fetch(request, env = {}) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json(
        200,
        {
          ok: true,
          service: "evaos-v05-ask",
          write_enabled: !!(env.OWNER_BEARER && env.GH_PAT),
          hard_stop_guard: true,
          ready: false,
          payment_fail: "not_lifted",
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
      const closePath = objectiveClosePath(url.pathname);
      if (closePath) return handleObjectiveClose(request, env, origin, closePath);
    }

    if (request.method === "GET") {
      const objectivePath = objectiveReadPath(url.pathname);
      if (objectivePath) return handleObjectiveRead(env, origin, objectivePath);
    }

    return json(404, { status: "FAILED", error: "not_found" }, origin);
  },
};
