/**
 * Hard-stop deny + allow harness. No GitHub, Cloudflare, or Stripe calls.
 * Payment FAIL is not lifted. Capture is not enabled.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker, { resetIngressForTests } from "../src/index.js";
import {
  DOGFOOD_POLICY,
  applyComplete,
  applyPreflight,
  applyRelease,
  classifyAskJob,
  createKvLedger,
  createMemoryLedger,
  ctParts,
  emptyLedger,
  quoteHoldWc,
} from "../src/hardstop.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-10-02T15:00:00.000Z"); // 10:00 CT
const DAY = "2026-10-02";

function job(id, extra = {}) {
  return {
    workspace_id: "dogfood-glen",
    job_id: id,
    job_class: "ask_reply",
    estimated_cogs_usd: 0.05,
    billable: true,
    now: NOW,
    ...extra,
  };
}

function funded(overrides = {}) {
  return {
    ...emptyLedger("dogfood-glen", NOW),
    ...overrides,
  };
}

describe("policy quote", () => {
  it("matches the dogfood placeholder and the wire-contract sample hold", () => {
    assert.equal(DOGFOOD_POLICY.workspace_id_default, "dogfood-glen");
    assert.equal(DOGFOOD_POLICY.wc_usd_value, 0.1);
    assert.equal(DOGFOOD_POLICY.wc_incl_per_period, 50);
    assert.equal(DOGFOOD_POLICY.hard_stop_pct, 1);
    assert.equal(DOGFOOD_POLICY.soft_warn_pct, 0.8);
    assert.equal(DOGFOOD_POLICY.auto_overage, false);
    assert.equal(DOGFOOD_POLICY.daily_max_jobs, 40);
    assert.equal(DOGFOOD_POLICY.daily_max_cogs_usd, 5);
    assert.equal(DOGFOOD_POLICY.reserve_floor_wc, 1);
    assert.deepEqual(DOGFOOD_POLICY.non_billable_classes, ["DEMO", "REPLAY", "SELFTEST", "SAMPLE"]);
    assert.equal(quoteHoldWc(DOGFOOD_POLICY, "ask_reply", 0.05), 0.5);
    assert.equal(quoteHoldWc(DOGFOOD_POLICY, "audit", 0.05), 0.75);
  });

  it("uses the Chicago calendar day, not UTC", () => {
    assert.deepEqual(ctParts(new Date("2026-10-02T04:30:00.000Z")), {
      period: "2026-10",
      day: "2026-10-01",
    });
    assert.equal(ctParts(NOW).day, DAY);
  });
});

describe("classify ask", () => {
  it("keeps selftest and explicit demo classes non-billable", () => {
    assert.equal(classifyAskJob({ kind: "selftest" }).billable, false);
    assert.equal(classifyAskJob({ kind: "owner", job_class: "DEMO" }).billable, false);
    assert.equal(classifyAskJob({ kind: "owner", job_class: "sample" }).job_class, "SAMPLE");
  });

  it("does not let the client mark a normal ask non-billable", () => {
    const cls = classifyAskJob({ kind: "owner", job_class: "ask_reply", billable: false });
    assert.equal(cls.billable, true);
    assert.equal(cls.job_class, "ask_reply");
  });
});

describe("preflight deny", () => {
  it("denies when the reserve floor would be breached and does not persist", () => {
    const ledger = funded({ burned_wc: 48.6 });
    const applied = applyPreflight(ledger, job("job-low"));
    assert.equal(applied.persist, false);
    assert.equal(applied.result.denied, true);
    assert.equal(applied.result.reason, "hard_stop");
    assert.equal(applied.result.code, "insufficient_wc");
    assert.match(applied.result.message, /not enough work credits/i);
    assert.match(applied.result.message, /No job was started/);
    assert.equal(ledger.burned_wc, 48.6);
    assert.deepEqual(ledger.open_holds, {});
  });

  it("denies when the period hard stop is already tripped", () => {
    const applied = applyPreflight(funded({ burned_wc: 50 }), job("job-tripped"));
    assert.equal(applied.result.denied, true);
    assert.equal(applied.result.code, "hard_stop");
    assert.match(applied.result.message, /hard stop/i);
    assert.equal(applied.persist, false);
  });

  it("denies a projection past the hard cap even if auto_overage is set", () => {
    const policy = { ...DOGFOOD_POLICY, reserve_floor_wc: 0, auto_overage: true };
    const applied = applyPreflight(funded({ burned_wc: 49.6 }), job("job-over"), policy);
    assert.equal(applied.result.denied, true);
    assert.equal(applied.result.code, "hard_stop");
    assert.match(applied.result.message, /overage is not enabled/);
    assert.equal(applied.persist, false);
  });

  it("denies at the daily job cap", () => {
    const applied = applyPreflight(
      funded({ daily: { [DAY]: { jobs: 40, cogs_usd: 0 } } }),
      job("job-daily")
    );
    assert.equal(applied.result.code, "daily_job_cap");
    assert.equal(applied.persist, false);
  });

  it("denies at the daily COGS cap", () => {
    const applied = applyPreflight(
      funded({ daily: { [DAY]: { jobs: 1, cogs_usd: 4.96 } } }),
      job("job-cogs")
    );
    assert.equal(applied.result.code, "daily_cogs_cap");
    assert.match(applied.result.message, /No job was started/);
  });
});

describe("preflight allow", () => {
  it("holds the estimated cost and is idempotent", () => {
    const first = applyPreflight(null, job("job-ok"));
    assert.equal(first.persist, true);
    assert.equal(first.result.denied, false);
    assert.equal(first.result.decision.hold_wc, 0.5);
    assert.equal(first.result.decision.billable, true);
    assert.equal(first.result.decision.soft_warn, false);
    assert.equal(first.ledger.open_holds["job-ok"].hold_wc, 0.5);
    assert.equal(first.ledger.daily[DAY].jobs, 1);
    assert.equal(first.ledger.daily[DAY].cogs_usd, 0.05);
    assert.equal(first.ledger.burned_wc, 0);

    const second = applyPreflight(first.ledger, job("job-ok"));
    assert.equal(second.persist, false);
    assert.equal(second.result.decision.idempotent, true);
    assert.equal(second.result.decision.hold_wc, 0.5);
    assert.equal(first.ledger.daily[DAY].jobs, 1);
  });

  it("flags a soft warning while still allowing under the hard stop", () => {
    const applied = applyPreflight(funded({ burned_wc: 39.5 }), job("job-warn"));
    assert.equal(applied.result.denied, false);
    assert.equal(applied.result.decision.soft_warn, true);
    assert.equal(applied.ledger.burned_wc, 39.5);
  });

  it("keeps open holds when the calendar month rolls", () => {
    const septemberNow = new Date("2026-09-15T15:00:00.000Z");
    const september = emptyLedger("dogfood-glen", septemberNow);
    const held = applyPreflight(september, job("job-sep", { now: septemberNow })).ledger;
    assert.equal(held.period, "2026-09");
    const october = applyPreflight(held, job("job-oct"));
    assert.equal(october.result.denied, false);
    assert.equal(october.ledger.period, "2026-10");
    assert.equal(october.ledger.burned_wc, 0);
    assert.equal(october.ledger.open_holds["job-sep"].hold_wc, 0.5);
    assert.equal(october.ledger.open_holds["job-oct"].hold_wc, 0.5);
  });

  it("leaves the balance untouched for DEMO, REPLAY, SELFTEST, and SAMPLE", () => {
    const ledger = funded({ burned_wc: 49 });
    for (const job_class of ["DEMO", "REPLAY", "SELFTEST", "SAMPLE"]) {
      const applied = applyPreflight(ledger, job(`nb-${job_class}`, { job_class, billable: false }));
      assert.equal(applied.persist, false);
      assert.equal(applied.result.denied, false);
      assert.equal(applied.result.decision.hold_wc, 0);
      assert.equal(applied.result.decision.billable, false);
    }
    assert.equal(ledger.burned_wc, 49);
    assert.deepEqual(ledger.open_holds, {});
  });
});

describe("complete and release", () => {
  it("burns actual COGS, writes JOB_COST, and releases the hold", () => {
    const held = applyPreflight(null, job("job-done")).ledger;
    const done = applyComplete(held, {
      workspace_id: "dogfood-glen",
      job_id: "job-done",
      actual_cogs_usd: 0.04,
      units_note: "ask reply",
      now: NOW,
    });
    assert.equal(done.result.ok, true);
    assert.equal(done.result.result.type, "JOB_COST");
    assert.equal(done.result.result.hold_wc, 0.5);
    assert.equal(done.result.result.wc_burned, 0.4);
    assert.equal(done.result.result.actual_cogs_usd, 0.04);
    assert.equal(done.ledger.burned_wc, 0.4);
    assert.equal(done.ledger.open_holds["job-done"], undefined);
    assert.equal(done.ledger.daily[DAY].cogs_usd, 0.04);
    const again = applyComplete(done.ledger, {
      workspace_id: "dogfood-glen",
      job_id: "job-done",
      actual_cogs_usd: 0.04,
      now: NOW,
    });
    assert.equal(again.persist, false);
    assert.equal(again.result.idempotent, true);
    assert.equal(done.ledger.burned_wc, 0.4);
  });

  it("does not burn when the billable job has no hold", () => {
    const applied = applyComplete(emptyLedger("dogfood-glen", NOW), {
      workspace_id: "dogfood-glen",
      job_id: "missing",
      job_class: "ask_reply",
      actual_cogs_usd: 0.05,
      billable: true,
      now: NOW,
    });
    assert.equal(applied.persist, false);
    assert.equal(applied.result.code, "hold_missing");
    assert.equal(applied.ledger.burned_wc, 0);
  });

  it("releases a hold when the job never starts", () => {
    const held = applyPreflight(null, job("job-fail")).ledger;
    const released = applyRelease(held, { job_id: "job-fail", reason: "write_failed" });
    assert.equal(released.result.released, true);
    assert.equal(released.ledger.daily[DAY].jobs, 0);
    assert.equal(released.ledger.daily[DAY].cogs_usd, 0);
    assert.deepEqual(released.ledger.open_holds, {});
    assert.equal(released.ledger.job_cost.length, 0);
  });
});

describe("memory and KV ledgers", () => {
  it("allows the first hold and denies the next one past the reserve", async () => {
    const memory = createMemoryLedger(funded({ burned_wc: 48.5 }));
    const allow = await memory.preflight(job("job-a"));
    assert.equal(allow.denied, false);
    assert.equal(allow.decision.hold_wc, 0.5);
    const deny = await memory.preflight(job("job-b"));
    assert.equal(deny.denied, true);
    assert.equal(deny.code, "insufficient_wc");
    const snap = memory.snapshot();
    assert.deepEqual(Object.keys(snap.open_holds), ["job-a"]);
    assert.equal(snap.burned_wc, 48.5);
  });

  it("persists the hold in KV before a later deny can see it", async () => {
    const store = new Map();
    const kv = {
      async get(key) {
        return store.has(key) ? store.get(key) : null;
      },
      async put(key, value) {
        store.set(key, value);
      },
    };
    const ledger = createKvLedger(kv);
    const allow = await ledger.preflight(job("job-kv"));
    assert.equal(allow.denied, false);
    assert.equal(store.size, 1);
    const saved = JSON.parse(store.values().next().value);
    assert.equal(saved.open_holds["job-kv"].hold_wc, 0.5);
    const settled = await ledger.complete({
      workspace_id: "dogfood-glen",
      job_id: "job-kv",
      actual_cogs_usd: 0.05,
      now: NOW,
    });
    assert.equal(settled.result.wc_burned, 0.5);
    assert.equal(settled.result.type, "JOB_COST");
  });
});

describe("worker intent gate", () => {
  let ghCalls;
  let previousFetch;

  beforeEach(() => {
    resetIngressForTests();
    ghCalls = [];
    previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      ghCalls.push({ url: String(url), body: opts && opts.body, headers: opts && opts.headers });
      return new Response(JSON.stringify({ number: 7, html_url: "https://github.com/example/issues/7" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    };
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  function env(extra = {}) {
    return { OWNER_BEARER: "owner-token", GH_PAT: "test-pat-not-real", ...extra };
  }

  function intent(body, token = "owner-token") {
    return new Request("https://worker.test/intent", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Origin: "https://joinermill.com",
      },
      body: JSON.stringify(body),
    });
  }

  it("still returns 401 before any ledger or GitHub call", async () => {
    let hits = 0;
    const ledger = {
      async preflight() {
        hits += 1;
        return { ok: true, denied: false, decision: {} };
      },
    };
    const res = await worker.fetch(intent({ type: "ask", body: "hello" }, "wrong-token"), env({ METERING_LEDGER: ledger }));
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.error, "unauthorized");
    assert.equal(hits, 0);
    assert.equal(ghCalls.length, 0);
  });

  it("denies a billable ask when the ledger is not bound and does not write", async () => {
    const res = await worker.fetch(intent({ type: "ask", body: "what should I do today", billable: false }), env());
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.error, "hard_stop");
    assert.equal(data.code, "metering_unconfigured");
    assert.equal(data.denied, true);
    assert.match(data.message, /No job was started/);
    assert.equal(ghCalls.length, 0);
    assert.equal(JSON.stringify(data).includes("test-pat-not-real"), false);
  });

  it("keeps selftest and DEMO non-billable without a ledger", async () => {
    const selftest = await worker.fetch(intent({ type: "ask", body: "selftest loop check" }), env());
    assert.equal(selftest.status, 201);
    const selfData = await selftest.json();
    assert.equal(selfData.billable, false);
    assert.equal(selfData.hold_wc, 0);
    assert.equal(selfData.kind, "selftest");

    resetIngressForTests();
    const demo = await worker.fetch(intent({ type: "ask", body: "show the sample", job_class: "DEMO" }), env());
    assert.equal(demo.status, 201);
    const demoData = await demo.json();
    assert.equal(demoData.billable, false);
    assert.equal(demoData.hold_wc, 0);
    assert.equal(demoData.job_class, "DEMO");
    assert.equal(ghCalls.length, 2);
  });

  it("allows a funded ask, holds 0.5 WC, and passes hold_wc through", async () => {
    const ledger = createMemoryLedger();
    const res = await worker.fetch(intent({ type: "ask", body: "what is next" }), env({ METERING_LEDGER: ledger }));
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.status, "SENT");
    assert.equal(data.billable, true);
    assert.equal(data.hold_wc, 0.5);
    assert.equal(data.html_url, undefined);
    assert.equal(ghCalls.length, 1);
    const issue = JSON.parse(ghCalls[0].body);
    assert.match(issue.body, /hold_wc=0\.5/);
    assert.match(issue.body, /billable=1/);
    assert.equal(issue.body.includes("test-pat-not-real"), false);
    const snap = ledger.snapshot();
    assert.equal(snap.open_holds[data.intent_id].hold_wc, 0.5);
    assert.equal(snap.burned_wc, 0);
  });

  it("denies an insufficient ledger without calling GitHub", async () => {
    const ledger = createMemoryLedger(funded({ burned_wc: 49 }));
    const res = await worker.fetch(intent({ type: "ask", body: "one more ask" }), env({ METERING_LEDGER: ledger }));
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.error, "hard_stop");
    assert.equal(data.code, "insufficient_wc");
    assert.match(data.message, /not enough work credits/i);
    assert.equal(ghCalls.length, 0);
    assert.equal(ledger.snapshot().burned_wc, 49);
    assert.deepEqual(ledger.snapshot().open_holds, {});
  });

  it("releases the hold when the GitHub write fails", async () => {
    globalThis.fetch = async () => new Response("nope", { status: 502 });
    const ledger = createMemoryLedger();
    const res = await worker.fetch(intent({ type: "ask", body: "try write" }), env({ METERING_LEDGER: ledger }));
    assert.equal(res.status, 502);
    const data = await res.json();
    assert.equal(data.error, "write_failed");
    const snap = ledger.snapshot();
    const today = ctParts(new Date()).day;
    assert.deepEqual(snap.open_holds, {});
    assert.equal(snap.daily[today].jobs, 0);
  });

  it("settles a hold on /metering/complete without capturing payment", async () => {
    const ledger = createMemoryLedger();
    const started = await worker.fetch(intent({ type: "ask", body: "bill this ask" }), env({ METERING_LEDGER: ledger }));
    const startedData = await started.json();
    resetIngressForTests();
    const res = await worker.fetch(
      new Request("https://worker.test/metering/complete", {
        method: "POST",
        headers: {
          Authorization: "Bearer owner-token",
          "Content-Type": "application/json",
          Origin: "https://joinermill.com",
        },
        body: JSON.stringify({
          job_id: startedData.intent_id,
          actual_cogs_usd: 0.04,
          hold_wc: 99,
        }),
      }),
      env({ METERING_LEDGER: ledger })
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.settled, true);
    assert.equal(data.capture, false);
    assert.equal(data.result.type, "JOB_COST");
    assert.equal(data.result.hold_wc, 0.5);
    assert.equal(data.result.wc_burned, 0.4);
    assert.equal(ledger.snapshot().burned_wc, 0.4);
    assert.deepEqual(ledger.snapshot().open_holds, {});
  });

  it("reports the guard on health without claiming ready", async () => {
    const res = await worker.fetch(new Request("https://worker.test/health"));
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.hard_stop_guard, true);
    assert.equal(data.ready, false);
    assert.equal(data.payment_fail, "not_lifted");
  });
});

describe("source wiring", () => {
  it("gates preflight before the GitHub write and does not mention Stripe", () => {
    const src = fs.readFileSync(path.join(__dirname, "../src/index.js"), "utf8");
    const hardstop = fs.readFileSync(path.join(__dirname, "../src/hardstop.js"), "utf8");
    const pre = src.indexOf("await preflightJob(");
    const write = src.indexOf("await createIssue(");
    assert.ok(pre > 0 && write > pre);
    assert.equal(/stripe/i.test(src + hardstop), false);
    assert.equal(/ghp_|gho_|github_pat_/.test(src + hardstop), false);
  });
});
