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

    return json(404, { status: "FAILED", error: "not_found" }, origin);
  },
};
