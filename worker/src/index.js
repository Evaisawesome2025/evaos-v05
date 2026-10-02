/**
 * EvaOS v0.5 — trusted Ask ingress (Cloudflare Worker)
 * POST /intent  Authorization: Bearer <OWNER_BEARER>
 * Body: { "type": "ask", "body": "<plain text ≤240>" }
 * Creates a hidden GitHub Issue (plumbing). Secrets only in env — never in client/git.
 *
 * Authorized owner Ask runs dogfood hard-stop preflight before that write.
 * Deny returns a structured error and does not write. Unauthenticated POST stays 401.
 * DEMO/REPLAY/SELFTEST/SAMPLE and kind=selftest do not burn work credits.
 * This is not Stripe, not payment-ready, and product Ready stays NO.
 *
 * GET  /health  — liveness (no secrets)
 * OPTIONS       — CORS preflight
 */
import {
  DOGFOOD_POLICY,
  PAYMENT_READY,
  PRODUCT_READY,
  STRANGER_WRITE,
  complete,
  preflight,
  readEstimatedCogs,
  storeForEnv,
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

export function checkRate() {
  const now = Date.now();
  if (now > rateBucket.resetsAt) {
    rateBucket.resetsAt = now + WINDOW_MS;
    rateBucket.count = 0;
  }
  rateBucket.count += 1;
  return rateBucket.count <= MAX_PER_WINDOW;
}

export function resetRateBucketForTests() {
  rateBucket.resetsAt = 0;
  rateBucket.count = 0;
}

function newIntentId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function meteringComment(metering) {
  const safe = (value) => String(value).replace(/[^a-zA-Z0-9_.:-]/g, "");
  return [
    "<!-- evaos-metering dogfood",
    `job_id=${safe(metering.job_id)}`,
    `hold_wc=${safe(metering.hold_wc)}`,
    `billable=${safe(metering.billable)}`,
    `job_class=${safe(metering.job_class)}`,
    `estimated_cogs_usd=${safe(metering.estimated_cogs_usd)}`,
    `workspace_id=${safe(metering.workspace_id)}`,
    "payment_ready=false ready=false",
    "-->",
  ].join(" ");
}

async function createIssue(pat, intentId, body, kind, metering) {
  const title =
    (kind === "selftest" ? "Owner ask SELFTEST: " : "Owner ask: ") +
    body.slice(0, 80);
  const lines = [
    "## Owner question",
    "",
    body,
    "",
    "---",
    `<!-- evaos-v05 owner-ask intent_id=${intentId} -->`,
    `**intent_id:** \`${intentId}\``,
    "**Source:** EvaOS v0.5 in-product Ask (Worker ingress)",
    "**Rules:** Public channel. No passwords, cards, private emails, or secrets.",
    "**Label:** owner-ask",
    kind === "selftest" ? "**Kind:** selftest" : "**Kind:** owner",
  ];
  if (metering && metering.job_id) lines.push(meteringComment(metering));
  const issueBody = lines.join("\n");

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

function meteringUnavailable(origin) {
  return json(
    503,
    {
      status: "FAILED",
      error: "metering_unavailable",
      spend: false,
      payment_ready: PAYMENT_READY,
      ready: PRODUCT_READY,
    },
    origin
  );
}

export async function handleRequest(request, env, deps = {}) {
  const origin = request.headers.get("Origin") || "";
  const url = new URL(request.url);
  const issueWriter = deps.createIssue || createIssue;
  const allowRate = deps.checkRate || checkRate;
  const policy = deps.policy || DOGFOOD_POLICY;
  const store = deps.store || storeForEnv(env);
  const now = deps.now ? new Date(deps.now) : new Date();

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
        metering: {
          wired: true,
          store: env && env.METERING_KV ? "kv" : "isolate_memory",
          payment_ready: PAYMENT_READY,
          ready: PRODUCT_READY,
          stranger_write: STRANGER_WRITE,
        },
      },
      origin
    );
  }

  if (request.method === "POST" && url.pathname === "/intent") {
    // Fail closed if secrets missing
    if (!env.OWNER_BEARER || !env.GH_PAT) {
      return json(
        503,
        { status: "FAILED", error: "ingress_not_configured" },
        origin
      );
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

    if (!allowRate()) {
      return json(429, { status: "FAILED", error: "rate_limited" }, origin);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json(400, { status: "FAILED", error: "invalid_json" }, origin);
    }

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
          message:
            "Public channel — do not put passwords, tokens, or card data in Asks.",
        },
        origin
      );
    }

    const kind =
      /\b(selftest|loop check)\b/i.test(body) || payload.selftest === true
        ? "selftest"
        : "owner";
    const intentId = newIntentId();
    const jobId = `ASK-${intentId}`;
    const billable = kind !== "selftest";
    const jobClass = billable ? "ask_reply" : "SELFTEST";

    let estimated;
    try {
      estimated = readEstimatedCogs(env);
    } catch {
      return meteringUnavailable(origin);
    }

    let gate;
    try {
      gate = await preflight(
        store,
        {
          workspace_id: policy.workspace_id_default,
          job_id: jobId,
          job_class: jobClass,
          estimated_cogs_usd: estimated,
          billable,
          non_billable_reason: billable ? undefined : "non_billable_class",
        },
        policy,
        { now }
      );
    } catch {
      return meteringUnavailable(origin);
    }

    if (gate.denied) {
      return json(
        403,
        {
          status: "FAILED",
          error: "hard_stop",
          reason: gate.reason,
          code: gate.code,
          denied: true,
          message: gate.message,
          intent_id: intentId,
          job_id: jobId,
          workspace_id: policy.workspace_id_default,
          spend: false,
          payment_ready: PAYMENT_READY,
          ready: PRODUCT_READY,
        },
        origin
      );
    }

    const metering = {
      job_id: jobId,
      hold_wc: gate.decision.hold_wc,
      billable,
      job_class: jobClass,
      estimated_cogs_usd: estimated,
      workspace_id: policy.workspace_id_default,
    };

    try {
      await issueWriter(env.GH_PAT, intentId, body, kind, metering);
    } catch {
      try {
        await complete(
          store,
          {
            workspace_id: policy.workspace_id_default,
            job_id: jobId,
            job_class: jobClass,
            estimated_cogs_usd: estimated,
            actual_cogs_usd: 0,
            hold_wc: gate.decision.hold_wc,
            billable,
            aborted: true,
            units_note: "aborted: upstream write failed; hold released; no burn",
            provider: "evaos-dogfood",
            model_tier: "none",
            route_reason: "upstream_write_failed",
          },
          policy,
          { now }
        );
      } catch {
        // Hold may remain reserved. Still do not report success.
      }
      return json(
        502,
        { status: "FAILED", error: "write_failed", intent_id: intentId, spend: false },
        origin
      );
    }

    let settled = null;
    try {
      settled = await complete(
        store,
        {
          workspace_id: policy.workspace_id_default,
          job_id: jobId,
          job_class: jobClass,
          estimated_cogs_usd: estimated,
          actual_cogs_usd: billable ? estimated : 0,
          hold_wc: gate.decision.hold_wc,
          billable,
          units_note: billable
            ? "dogfood Ask accept settled at estimate; Worker does not observe provider token COGS; not a charge"
            : "non-billable SELFTEST; no work-credit burn",
          provider: "evaos-dogfood",
          model_tier: billable ? "unobserved" : "none",
          route_reason: billable ? "worker_estimate_settlement" : "non_billable_selftest",
        },
        policy,
        { now }
      );
    } catch {
      settled = null;
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
        message:
          "Ask accepted. Eva will process on the box; reply appears in EvaOS outbox.",
        metering: {
          denied: false,
          billable,
          job_class: jobClass,
          hold_wc: gate.decision.hold_wc,
          burn_wc: settled && settled.ok ? settled.result.burn_wc : null,
          settled: !!(settled && settled.ok),
          payment_ready: PAYMENT_READY,
          ready: PRODUCT_READY,
        },
      },
      origin
    );
  }

  return json(404, { status: "FAILED", error: "not_found" }, origin);
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
