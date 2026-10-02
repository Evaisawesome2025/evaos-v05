/**
 * Dogfood hard-stop: preflight deny/allow, and owner Ask /intent wiring.
 * Does not call GitHub, Cloudflare, or Stripe.
 */
import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

let hardstop;
let worker;

before(async () => {
  hardstop = await import("../src/hardstop.js");
  worker = await import("../src/index.js");
});

afterEach(() => {
  hardstop.resetIsolateStoreForTests();
  worker.resetRateBucketForTests();
});

const OWNER = "owner-test-bearer";
const PAT = "test-gh-pat";

function billableReq(jobId, extra = {}) {
  return {
    workspace_id: "dogfood-glen",
    job_id: jobId,
    job_class: "ask_reply",
    estimated_cogs_usd: 0.05,
    billable: true,
    ...extra,
  };
}

function narrow(overrides) {
  return { ...hardstop.DOGFOOD_POLICY, ...overrides };
}

async function postIntent(env, deps, body, { auth = OWNER, origin } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth != null) headers.Authorization = `Bearer ${auth}`;
  if (origin) headers.Origin = origin;
  const request = new Request("https://worker.test/intent", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return worker.handleRequest(request, env, deps);
}

function ownerEnv(extra = {}) {
  return { OWNER_BEARER: OWNER, GH_PAT: PAT, ...extra };
}

function recordingWriter() {
  const calls = [];
  return {
    calls,
    createIssue: async (...args) => {
      calls.push(args);
      return { number: 1, html_url: "https://example.invalid/issues/1" };
    },
  };
}

describe("policy placeholder", () => {
  it("keeps the dogfood WCincl note and refuses overage", () => {
    const policy = hardstop.DOGFOOD_POLICY;
    assert.equal(policy.status, "DOGFOOD_POLICY");
    assert.equal(policy.wc_incl_per_period, 50);
    assert.equal(policy.auto_overage, false);
    assert.match(policy.notes, /NOT measured founding WCincl/);
    assert.deepEqual(policy.non_billable_classes, ["DEMO", "REPLAY", "SELFTEST", "SAMPLE"]);
    assert.equal(hardstop.PAYMENT_READY, false);
    assert.equal(hardstop.PRODUCT_READY, false);
    assert.equal(hardstop.STRANGER_WRITE, false);
  });
});

describe("ct calendar", () => {
  it("uses America/Chicago dates", () => {
    const beforeMidnight = hardstop.ctStamp(new Date("2026-10-02T03:30:00Z"));
    assert.equal(beforeMidnight.day_id, "2026-10-01");
    assert.equal(beforeMidnight.period_id, "2026-10");
    const afterMidnight = hardstop.ctStamp(new Date("2026-10-02T05:30:00Z"));
    assert.equal(afterMidnight.day_id, "2026-10-02");
  });
});

describe("preflight and complete", () => {
  it("holds 1 WC for a $0.05 ask_reply and burns the estimate on complete", async () => {
    const store = hardstop.memoryStore();
    const gate = await hardstop.preflight(store, billableReq("ASK-1"));
    assert.equal(gate.ok, true);
    assert.equal(gate.denied, false);
    assert.equal(gate.decision.hold_wc, 1);
    assert.equal(gate.decision.billable, true);
    assert.equal(gate.decision.payment_ready, false);
    assert.equal(gate.decision.soft_warn, false);

    const done = await hardstop.complete(store, {
      ...billableReq("ASK-1"),
      actual_cogs_usd: 0.05,
      hold_wc: gate.decision.hold_wc,
      units_note: "settled at estimate",
    });
    assert.equal(done.ok, true);
    assert.equal(done.result.burn_wc, 0.5);
    assert.equal(done.result.hold_wc, 1);
    assert.equal(done.result.payment_ready, false);
    assert.equal(done.result.job_cost.burn_wc, 0.5);

    const again = await hardstop.complete(store, {
      ...billableReq("ASK-1"),
      actual_cogs_usd: 9,
      hold_wc: 1,
    });
    assert.equal(again.result.burn_wc, 0.5);
    const ledger = await store.peek("dogfood-glen");
    assert.equal(hardstop.microToWc(ledger.consumed_micro), 0.5);
    assert.deepEqual(ledger.open_holds, {});
  });

  it("denies when the next hold would pass included WC and does not save", async () => {
    const inner = hardstop.memoryStore();
    let saves = 0;
    const store = {
      kind: inner.kind,
      load: (id) => inner.load(id),
      save: async (id, ledger) => {
        saves += 1;
        await inner.save(id, ledger);
      },
      peek: (id) => inner.peek(id),
    };
    const policy = narrow({ wc_incl_per_period: 1 });
    const first = await hardstop.preflight(store, billableReq("ASK-a"), policy);
    assert.equal(first.denied, false);
    await hardstop.complete(
      store,
      { ...billableReq("ASK-a"), actual_cogs_usd: 0.05, hold_wc: 1 },
      policy
    );
    const savesAfterAllow = saves;
    const second = await hardstop.preflight(store, billableReq("ASK-b"), policy);
    assert.equal(second.ok, false);
    assert.equal(second.denied, true);
    assert.equal(second.reason, "hard_stop");
    assert.equal(second.code, "wc_hard_stop");
    assert.equal(second.spend, false);
    assert.equal(saves, savesAfterAllow);
    const replay = await hardstop.preflight(store, billableReq("ASK-a"), policy);
    assert.equal(replay.code, "job_already_complete");
  });

  it("keeps an open hold against the cap until complete or abort", async () => {
    const store = hardstop.memoryStore();
    const policy = narrow({ wc_incl_per_period: 1.5 });
    const first = await hardstop.preflight(store, billableReq("ASK-open"), policy);
    assert.equal(first.denied, false);
    const blocked = await hardstop.preflight(store, billableReq("ASK-next"), policy);
    assert.equal(blocked.code, "wc_hard_stop");
    await hardstop.complete(
      store,
      {
        ...billableReq("ASK-open"),
        actual_cogs_usd: 0,
        aborted: true,
        hold_wc: 1,
      },
      policy
    );
    const released = await store.peek("dogfood-glen");
    assert.equal(released.consumed_micro, 0);
    assert.deepEqual(released.open_holds, {});
    const retry = await hardstop.preflight(store, billableReq("ASK-next"), policy);
    assert.equal(retry.denied, false);
  });

  it("does not burn DEMO, REPLAY, SELFTEST, or SAMPLE", async () => {
    const store = hardstop.memoryStore();
    const policy = narrow({ wc_incl_per_period: 1 });
    for (const jobClass of ["DEMO", "replay", "SELFTEST", "sample"]) {
      const jobId = `NB-${jobClass}`;
      const gate = await hardstop.preflight(
        store,
        {
          workspace_id: "dogfood-glen",
          job_id: jobId,
          job_class: jobClass,
          estimated_cogs_usd: 3,
          billable: true,
        },
        policy
      );
      assert.equal(gate.denied, false, jobClass);
      assert.equal(gate.decision.hold_wc, 0, jobClass);
      assert.equal(gate.decision.billable, false, jobClass);
      const done = await hardstop.complete(
        store,
        {
          workspace_id: "dogfood-glen",
          job_id: jobId,
          job_class: jobClass,
          estimated_cogs_usd: 3,
          actual_cogs_usd: 3,
          hold_wc: 0,
          billable: true,
        },
        policy
      );
      assert.equal(done.result.burn_wc, 0, jobClass);
    }
    const ledger = await store.peek("dogfood-glen");
    assert.equal(ledger.consumed_micro, 0);
    const still = await hardstop.preflight(store, billableReq("ASK-after-nb"), policy);
    assert.equal(still.denied, false);
  });

  it("treats billable false as non-billable even for ask_reply", async () => {
    const store = hardstop.memoryStore();
    const gate = await hardstop.preflight(
      store,
      billableReq("ASK-free", { billable: false, non_billable_reason: "test" })
    );
    assert.equal(gate.decision.billable, false);
    assert.equal(gate.decision.hold_wc, 0);
  });

  it("applies the objective_cycle multiplier above the reserve floor", async () => {
    const store = hardstop.memoryStore();
    const gate = await hardstop.preflight(
      store,
      billableReq("ASK-cycle", { job_class: "objective_cycle", estimated_cogs_usd: 0.1 })
    );
    assert.equal(gate.decision.hold_wc, 2);
  });

  it("denies at the daily job cap and the daily COGS cap", async () => {
    const jobs = hardstop.memoryStore();
    const jobPolicy = narrow({ daily_max_jobs: 1, wc_incl_per_period: 50 });
    assert.equal((await hardstop.preflight(jobs, billableReq("ASK-d1"), jobPolicy)).denied, false);
    const jobDeny = await hardstop.preflight(jobs, billableReq("ASK-d2"), jobPolicy);
    assert.equal(jobDeny.code, "daily_job_cap");

    const cogs = hardstop.memoryStore();
    const cogsPolicy = narrow({ daily_max_cogs_usd: 0.01, wc_incl_per_period: 50 });
    const cogsDeny = await hardstop.preflight(cogs, billableReq("ASK-c1"), cogsPolicy);
    assert.equal(cogsDeny.code, "daily_cogs_cap");
    assert.equal(await cogs.peek("dogfood-glen"), null);
  });

  it("warns at 80% and still allows under the hard stop", async () => {
    const stamp = hardstop.ctStamp(new Date());
    const store = hardstop.memoryStore({
      schema_version: 1,
      workspace_id: "dogfood-glen",
      period_id: stamp.period_id,
      consumed_micro: 39 * hardstop.WC_MICRO,
      open_holds: {},
      jobs: {},
      daily: {},
      job_cost: [],
      payment_ready: false,
      ready: false,
    });
    const gate = await hardstop.preflight(store, billableReq("ASK-warn"));
    assert.equal(gate.denied, false);
    assert.equal(gate.decision.soft_warn, true);
    assert.equal(gate.decision.consumed_wc, 39);
  });

  it("resets the cap on the next Chicago calendar month", async () => {
    const store = hardstop.memoryStore();
    const policy = narrow({ wc_incl_per_period: 1 });
    const oct = new Date("2026-10-15T18:00:00Z");
    const nov = new Date("2026-11-15T18:00:00Z");
    await hardstop.preflight(store, billableReq("ASK-oct"), policy, { now: oct });
    await hardstop.complete(
      store,
      { ...billableReq("ASK-oct"), actual_cogs_usd: 0.05, hold_wc: 1 },
      policy,
      { now: oct }
    );
    const denied = await hardstop.preflight(store, billableReq("ASK-oct-2"), policy, { now: oct });
    assert.equal(denied.code, "wc_hard_stop");
    const allowed = await hardstop.preflight(store, billableReq("ASK-nov"), policy, { now: nov });
    assert.equal(allowed.denied, false);
    assert.equal(allowed.decision.period_id, "2026-11");
    assert.equal(allowed.decision.consumed_wc, 0);
  });

  it("is idempotent for an open preflight", async () => {
    const inner = hardstop.memoryStore();
    let saves = 0;
    const store = {
      kind: inner.kind,
      load: (id) => inner.load(id),
      save: async (id, ledger) => {
        saves += 1;
        await inner.save(id, ledger);
      },
    };
    await hardstop.preflight(store, billableReq("ASK-same"));
    await hardstop.preflight(store, billableReq("ASK-same"));
    assert.equal(saves, 1);
    const ledger = await inner.peek("dogfood-glen");
    assert.equal(Object.keys(ledger.open_holds).length, 1);
  });

  it("fails closed on auto-overage, a corrupt ledger, and a dead store", async () => {
    const store = hardstop.memoryStore();
    await assert.rejects(
      () => hardstop.preflight(store, billableReq("ASK-over"), narrow({ auto_overage: true })),
      /auto_overage_not_supported/
    );
    const corrupt = hardstop.memoryStore({
      schema_version: 2,
      workspace_id: "dogfood-glen",
      payment_ready: false,
      ready: false,
    });
    await assert.rejects(() => hardstop.preflight(corrupt, billableReq("ASK-bad")));
    const dead = {
      kind: "kv",
      async load() {
        throw new Error("kv down");
      },
      async save() {
        throw new Error("kv down");
      },
    };
    await assert.rejects(() => hardstop.preflight(dead, billableReq("ASK-dead")));
    assert.equal(await store.peek("dogfood-glen"), null);
  });

  it("round-trips the ledger through a KV-shaped binding", async () => {
    const map = new Map();
    const kv = {
      async get(key, type) {
        const value = map.get(key);
        if (value == null) return null;
        return type === "json" ? JSON.parse(value) : value;
      },
      async put(key, value) {
        map.set(key, value);
      },
    };
    const first = hardstop.kvStore(kv);
    const policy = narrow({ wc_incl_per_period: 1 });
    await hardstop.preflight(first, billableReq("ASK-kv"), policy);
    await hardstop.complete(
      first,
      { ...billableReq("ASK-kv"), actual_cogs_usd: 0.05, hold_wc: 1 },
      policy
    );
    const second = hardstop.kvStore(kv);
    const denied = await hardstop.preflight(second, billableReq("ASK-kv-2"), policy);
    assert.equal(denied.code, "wc_hard_stop");
    assert.equal(first.kind, "kv");
    assert.equal(map.size, 1);
  });
});

describe("POST /intent hard-stop", () => {
  it("returns 401 for unauthenticated writes and spends nothing", async () => {
    const writer = recordingWriter();
    const store = hardstop.memoryStore();
    const policy = narrow({ wc_incl_per_period: 0.5 });
    const prev = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("network_forbidden_in_test");
    };
    try {
      const missing = await postIntent(
        ownerEnv(),
        { createIssue: writer.createIssue, store, policy, checkRate: () => true },
        { type: "ask", body: "hello from a stranger" },
        { auth: null }
      );
      const wrong = await postIntent(
        ownerEnv(),
        { createIssue: writer.createIssue, store, policy, checkRate: () => true },
        { type: "ask", body: "hello from a stranger" },
        { auth: "not-the-owner" }
      );
      assert.equal(missing.status, 401);
      assert.equal(wrong.status, 401);
      assert.equal((await missing.json()).error, "unauthorized");
      assert.equal((await wrong.json()).error, "unauthorized");
      assert.equal(writer.calls.length, 0);
      assert.equal(await store.peek("dogfood-glen"), null);
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("allows an owner Ask, writes once, and settles the estimate", async () => {
    const writer = recordingWriter();
    const store = hardstop.memoryStore();
    const res = await postIntent(
      ownerEnv(),
      { createIssue: writer.createIssue, store, checkRate: () => true },
      { type: "ask", body: "why is the bay empty" }
    );
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.equal(body.status, "SENT");
    assert.equal(body.metering.denied, false);
    assert.equal(body.metering.hold_wc, 1);
    assert.equal(body.metering.burn_wc, 0.5);
    assert.equal(body.metering.billable, true);
    assert.equal(body.metering.payment_ready, false);
    assert.equal(body.metering.ready, false);
    assert.equal(body.metering.included_wc, undefined);
    assert.equal(body.html_url, undefined);
    assert.equal(writer.calls.length, 1);
    assert.equal(writer.calls[0][4].hold_wc, 1);
    assert.equal(writer.calls[0][4].job_class, "ask_reply");
    const ledger = await store.peek("dogfood-glen");
    assert.equal(hardstop.microToWc(ledger.consumed_micro), 0.5);
    assert.equal(ledger.payment_ready, false);
  });

  it("denies the next owner Ask once the hold no longer fits, without a second write", async () => {
    const writer = recordingWriter();
    const store = hardstop.memoryStore();
    const policy = narrow({ wc_incl_per_period: 1 });
    const deps = { createIssue: writer.createIssue, store, policy, checkRate: () => true };
    const first = await postIntent(ownerEnv(), deps, { type: "ask", body: "first billable ask" });
    assert.equal(first.status, 201);
    const second = await postIntent(ownerEnv(), deps, { type: "ask", body: "second billable ask" });
    const body = await second.json();
    assert.equal(second.status, 403);
    assert.equal(body.status, "FAILED");
    assert.equal(body.error, "hard_stop");
    assert.equal(body.reason, "hard_stop");
    assert.equal(body.code, "wc_hard_stop");
    assert.equal(body.denied, true);
    assert.equal(body.spend, false);
    assert.equal(body.payment_ready, false);
    assert.match(body.message, /Nothing was written/);
    assert.equal(JSON.stringify(body).toLowerCase().includes("stripe"), false);
    assert.equal(JSON.stringify(body).toLowerCase().includes("waitlist"), false);
    assert.equal(writer.calls.length, 1);
  });

  it("denies before any write when the estimate alone exceeds the cap", async () => {
    const writer = recordingWriter();
    const store = hardstop.memoryStore();
    const policy = narrow({ wc_incl_per_period: 0.5 });
    const res = await postIntent(
      ownerEnv(),
      { createIssue: writer.createIssue, store, policy, checkRate: () => true },
      { type: "ask", body: "this hold cannot fit" }
    );
    const body = await res.json();
    assert.equal(res.status, 403);
    assert.equal(body.code, "wc_hard_stop");
    assert.equal(body.spend, false);
    assert.equal(writer.calls.length, 0);
    assert.equal(await store.peek("dogfood-glen"), null);
  });

  it("still accepts selftest when billable asks are stopped, and does not burn", async () => {
    const writer = recordingWriter();
    const store = hardstop.memoryStore();
    const policy = narrow({ wc_incl_per_period: 0.5 });
    const deps = { createIssue: writer.createIssue, store, policy, checkRate: () => true };
    const denied = await postIntent(ownerEnv(), deps, { type: "ask", body: "real owner ask" });
    assert.equal(denied.status, 403);
    const selftest = await postIntent(ownerEnv(), deps, {
      type: "ask",
      body: "loop check ping",
      selftest: true,
    });
    const body = await selftest.json();
    assert.equal(selftest.status, 201);
    assert.equal(body.kind, "selftest");
    assert.equal(body.metering.billable, false);
    assert.equal(body.metering.hold_wc, 0);
    assert.equal(body.metering.burn_wc, 0);
    assert.equal(writer.calls.length, 1);
    assert.equal(writer.calls[0][3], "selftest");
    const ledger = await store.peek("dogfood-glen");
    assert.equal(ledger.consumed_micro, 0);
  });

  it("releases the hold when the upstream write fails", async () => {
    const store = hardstop.memoryStore();
    let fetches = 0;
    const res = await postIntent(
      ownerEnv(),
      {
        store,
        checkRate: () => true,
        createIssue: async () => {
          fetches += 1;
          throw new Error("upstream_write_failed");
        },
      },
      { type: "ask", body: "write will fail" }
    );
    const body = await res.json();
    assert.equal(res.status, 502);
    assert.equal(body.error, "write_failed");
    assert.equal(body.spend, false);
    assert.equal(fetches, 1);
    const ledger = await store.peek("dogfood-glen");
    assert.equal(ledger.consumed_micro, 0);
    assert.deepEqual(ledger.open_holds, {});
    const follow = await postIntent(
      ownerEnv(),
      {
        store,
        checkRate: () => true,
        createIssue: async () => ({ number: 2, html_url: "https://example.invalid/2" }),
      },
      { type: "ask", body: "write can proceed" }
    );
    assert.equal(follow.status, 201);
  });

  it("does not write when metering is unavailable", async () => {
    const writer = recordingWriter();
    const dead = {
      kind: "kv",
      async load() {
        throw new Error("kv down");
      },
      async save() {
        throw new Error("kv down");
      },
    };
    const down = await postIntent(
      ownerEnv(),
      { createIssue: writer.createIssue, store: dead, checkRate: () => true },
      { type: "ask", body: "store down" }
    );
    assert.equal(down.status, 503);
    assert.equal((await down.json()).error, "metering_unavailable");
    const badEstimate = await postIntent(
      ownerEnv({ ASK_ESTIMATED_COGS_USD: "nope" }),
      { createIssue: writer.createIssue, store: hardstop.memoryStore(), checkRate: () => true },
      { type: "ask", body: "bad estimate" }
    );
    assert.equal(badEstimate.status, 503);
    assert.equal(writer.calls.length, 0);
  });

  it("puts hold_wc on the upstream issue and hides transport details", async () => {
    let captured;
    const prev = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ number: 9, html_url: "https://example.invalid/9" }), {
        status: 201,
      });
    };
    try {
      const res = await postIntent(
        ownerEnv(),
        { store: hardstop.memoryStore(), checkRate: () => true },
        { type: "ask", body: "wire the hold through" }
      );
      const body = await res.json();
      assert.equal(res.status, 201);
      assert.equal(body.html_url, undefined);
      assert.equal(body.number, undefined);
      const upstream = JSON.parse(captured.init.body);
      assert.match(String(captured.url), /\/repos\/Evaisawesome2025\/evaos-v05\/issues$/);
      assert.match(upstream.body, /hold_wc=1/);
      assert.match(upstream.body, /payment_ready=false/);
      assert.match(upstream.body, /job_class=ask_reply/);
      assert.equal(upstream.body.includes(OWNER), false);
      assert.equal(upstream.body.includes(PAT), false);
      assert.equal(captured.init.headers.Authorization, `Bearer ${PAT}`);
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("drops upstream error bodies on a failed write", async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("upstream-detail-should-not-leak", { status: 500 });
    try {
      const res = await postIntent(
        ownerEnv(),
        { store: hardstop.memoryStore(), checkRate: () => true },
        { type: "ask", body: "upstream fails closed" }
      );
      const text = await res.text();
      assert.equal(res.status, 502);
      assert.equal(text.includes("upstream-detail-should-not-leak"), false);
    } finally {
      globalThis.fetch = prev;
    }
  });
});

describe("health and source order", () => {
  it("reports the hard-stop as wired and not payment-ready", async () => {
    const res = await worker.handleRequest(
      new Request("https://worker.test/health"),
      { PAYMENT_READY: "true", READY: "YES", METERING_KV: null }
    );
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.metering.wired, true);
    assert.equal(body.metering.store, "isolate_memory");
    assert.equal(body.metering.payment_ready, false);
    assert.equal(body.metering.ready, false);
    assert.equal(body.metering.stranger_write, false);
    assert.equal(body.write_enabled, false);

    const kvHealth = await worker.handleRequest(new Request("https://worker.test/health"), {
      METERING_KV: { get() {}, put() {} },
    });
    assert.equal((await kvHealth.json()).metering.store, "kv");
  });

  it("preflights before the issue writer", () => {
    const src = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
    const gate = src.indexOf("if (gate.denied)");
    const write = src.indexOf("await issueWriter(");
    assert.ok(gate > 0 && write > gate);
    assert.equal(/api\.stripe\.com|sk_live_|sk_test_/.test(src), false);
  });

  it("keeps the hourly owner rate limit", () => {
    worker.resetRateBucketForTests();
    for (let i = 0; i < 10; i++) assert.equal(worker.checkRate(), true);
    assert.equal(worker.checkRate(), false);
  });

  it("uses one isolate store until KV is bound", () => {
    const a = hardstop.storeForEnv({});
    const b = hardstop.storeForEnv({});
    assert.equal(a, b);
    assert.equal(a.kind, "isolate_memory");
    const kv = hardstop.storeForEnv({
      METERING_KV: {
        get() {
          return null;
        },
        put() {
          return null;
        },
      },
    });
    assert.equal(kv.kind, "kv");
    assert.notEqual(kv, a);
  });
});
