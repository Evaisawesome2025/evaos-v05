/**
 * Hard-stop deny + allow harness. No GitHub, Cloudflare, or Stripe calls.
 * Payment FAIL is not lifted. Capture is not enabled.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker, {
  OBJECTIVE_NEXT_STEP,
  PAGE_READ_NOTES,
  PAID_RESEARCH_UNKNOWN_NOTES,
  applyStrangerObjective,
  artifactTextToStore,
  composeObjectiveArtifact,
  pageNamedInSentence,
  readObjectivePage,
  resetIngressForTests,
} from "../src/index.js";
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

  it("binds OBJECTIVE on its own namespace and leaves METERING_KV unchanged", () => {
    const toml = fs.readFileSync(path.join(__dirname, "../wrangler.toml"), "utf8");
    assert.match(toml, /binding = "METERING_KV"/);
    assert.match(toml, /id = "ca78fb121eb746db9097b63328b49631"/);
    assert.match(toml, /binding = "OBJECTIVE"/);
    assert.match(toml, /id = "f9c1e824a1d04be1bb2cbcbcabf63d2f"/);
    assert.match(toml, /evaos-v05-ask--OBJECTIVE/);
    assert.equal(toml.split("ca78fb121eb746db9097b63328b49631").length - 1, 1);
    assert.equal(toml.split("f9c1e824a1d04be1bb2cbcbcabf63d2f").length - 1, 1);
    const metering = toml.indexOf('binding = "METERING_KV"');
    const objective = toml.indexOf('binding = "OBJECTIVE"');
    assert.ok(metering > 0 && objective > metering);
  });

  it("keeps the objective route off the bearer, GitHub, and metering paths", () => {
    const src = fs.readFileSync(path.join(__dirname, "../src/index.js"), "utf8");
    const start = src.indexOf("async function handleObjective");
    const end = src.indexOf("\nexport default");
    const fn = src.slice(start, end);
    assert.ok(start > 0 && end > start);
    assert.equal(fn.includes("METERING_KV"), false);
    assert.equal(fn.includes("createIssue"), false);
    assert.equal(fn.includes("OWNER_BEARER"), false);
    assert.equal(fn.includes("api.github.com"), false);
    assert.equal(fn.includes(".delete("), false);
    assert.equal(/stripe/i.test(fn), false);
    assert.equal(fn.includes('url.pathname === "/objective"') || src.includes('pathname === "/objective"'), true);
  });
});

describe("stranger objective save", () => {
  let previousFetch;

  beforeEach(() => {
    previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("objective route must not call out");
    };
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  function memoryKv(initial) {
    const store = new Map(initial || []);
    const puts = [];
    return {
      store,
      puts,
      async get(key) {
        return store.has(key) ? store.get(key) : null;
      },
      async put(key, value) {
        assert.notEqual(key, "stranger-objective");
        puts.push(value);
        store.set(key, value);
      },
      async list({ prefix } = {}) {
        const keys = [];
        for (const name of store.keys()) {
          if (!prefix || String(name).startsWith(prefix)) keys.push({ name });
        }
        return { keys, list_complete: true };
      },
      async delete() {
        throw new Error("objective key must not be deleted");
      },
    };
  }

  function meteringKv() {
    return {
      async get() {
        throw new Error("METERING_KV read");
      },
      async put() {
        throw new Error("METERING_KV write");
      },
      async delete() {
        throw new Error("METERING_KV delete");
      },
    };
  }

  function postObjective(sentence, origin = "https://joinermill.com", extra = {}) {
    return new Request("https://worker.test/objective", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
      },
      body: JSON.stringify({ sentence, ...extra }),
    });
  }

  it("keeps the sentence and can still gain notes; artifact waits for real work", () => {
    const first = applyStrangerObjective(null, {
      sentence: "  Keep this sentence  ",
      time: "2026-10-04T12:00:00.000Z",
      notes: "client notes must not replace the unknown",
      artifact: "https://example.com/not-produced",
      artifactProduced: true,
    });
    assert.equal(first.created, true);
    assert.equal(first.record.sentence, "Keep this sentence");
    assert.equal(first.record.notes, PAID_RESEARCH_UNKNOWN_NOTES);
    assert.equal(first.record.artifact, "");
    assert.equal(first.record.status, "SAVED");
    assert.equal(first.record.next_step, OBJECTIVE_NEXT_STEP);
    assert.equal(first.record.time, "2026-10-04T12:00:00.000Z");
    assert.equal(first.record.result, undefined);
    assert.equal(first.record.score, undefined);
    assert.equal(first.record.date, undefined);
    assert.match(PAID_RESEARCH_UNKNOWN_NOTES, /Unknown:/);
    assert.match(PAID_RESEARCH_UNKNOWN_NOTES, /No result was written/);
    assert.match(OBJECTIVE_NEXT_STEP, /does not run/);

    const noted = applyStrangerObjective(first.record, {
      sentence: "A second sentence",
      notes: "Source list for this sentence is unknown.",
      artifact: "https://example.com/fake",
    });
    assert.equal(noted.created, false);
    assert.equal(noted.changed, true);
    assert.equal(noted.record.sentence, "Keep this sentence");
    assert.equal(noted.record.run_id, first.record.run_id);
    assert.equal(noted.record.artifact, "");
    assert.match(noted.record.notes, /Paid research call blocked/);
    assert.match(noted.record.notes, /Source list for this sentence is unknown/);

    const again = applyStrangerObjective(noted.record, {
      sentence: "A third sentence",
      notes: "Source list for this sentence is unknown.",
    });
    assert.equal(again.changed, false);
    assert.equal(again.record.sentence, "Keep this sentence");
    assert.equal(again.record.notes, noted.record.notes);

    const produced = applyStrangerObjective(noted.record, {
      sentence: "A third sentence",
      artifact: "evidence://real-work",
      artifactProduced: true,
    });
    assert.equal(produced.record.sentence, "Keep this sentence");
    assert.equal(produced.record.run_id, first.record.run_id);
    assert.equal(produced.record.artifact, "evidence://real-work");
    assert.match(produced.record.notes, /Source list for this sentence is unknown/);
  });

  it("does not create stranger-objective from a public post", async () => {
    const kv = memoryKv();
    const res = await worker.fetch(
      postObjective("Find the first honest stranger objective", "https://www.joinermill.com", {
        artifact: "https://example.com/not-real",
        artifactProduced: true,
        result: "invented",
        score: 99,
        date: "1999-01-01",
        notes: "client note",
        time: "2000-01-01T00:00:00.000Z",
      }),
      { OBJECTIVE: kv, METERING_KV: meteringKv() }
    );
    assert.equal(res.status, 404);
    const data = await res.json();
    assert.equal(data.error, "not_found");
    assert.equal(data.ready, false);
    assert.equal(data.payment_fail, "not_lifted");
    assert.equal(data.saved, undefined);
    assert.equal(kv.puts.length, 0);
    assert.equal(kv.store.size, 0);
    assert.equal(kv.store.has("stranger-objective"), false);
  });

  it("does not replace a stored sentence and returns its run id", async () => {
    const kv = memoryKv([
      [
        "stranger-objective",
        JSON.stringify({
          sentence: "Already saved",
          run_id: "run-existing",
          status: "SAVED",
          notes: PAID_RESEARCH_UNKNOWN_NOTES,
          artifact: "evidence://real-work",
          time: "2026-10-04T12:00:00.000Z",
          next_step: OBJECTIVE_NEXT_STEP,
        }),
      ],
    ]);
    const res = await worker.fetch(
      new Request("https://worker.test/objective", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://joinermill.com",
          Authorization: "Bearer not-the-owner",
        },
        body: "not-json { sentence: \"A second sentence\" }",
      }),
      { OBJECTIVE: kv, METERING_KV: meteringKv(), OWNER_BEARER: "owner-token", GH_PAT: "test-pat-not-real" }
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.saved, false);
    assert.equal(data.run_id, "run-existing");
    assert.equal(data.sentence, "Already saved");
    assert.equal(data.artifact, "evidence://real-work");
    assert.equal(data.notes, PAID_RESEARCH_UNKNOWN_NOTES);
    assert.equal(data.ready, false);
    assert.equal(data.payment_fail, "not_lifted");
    assert.equal(kv.puts.length, 0);
    assert.equal(kv.store.size, 1);
    assert.equal(JSON.parse(kv.store.get("stranger-objective")).sentence, "Already saved");
  });

  it("resumes the same run on a later post and does not write another artifact", async () => {
    const kv = memoryKv([
      [
        "stranger-objective",
        JSON.stringify({
          sentence: "Already saved",
          run_id: "run-existing",
          status: "SAVED",
          notes: "",
          artifact: "",
          time: "2026-10-04T12:00:00.000Z",
          next_step: OBJECTIVE_NEXT_STEP,
          events: [{ name: "saved", run_id: "run-existing", who: "worker" }],
        }),
      ],
    ]);
    const before = kv.store.get("stranger-objective");
    const res = await worker.fetch(postObjective("A second sentence", "https://joinermill.com"), {
      OBJECTIVE: kv,
      METERING_KV: meteringKv(),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.run_id, "run-existing");
    assert.equal(data.sentence, "Already saved");
    assert.equal(data.artifact, "");
    assert.equal(data.saved, false);
    assert.equal(data.events.length, 1);
    assert.equal(data.events[0].run_id, "run-existing");
    assert.equal(kv.puts.length, 0);
    assert.equal(kv.store.size, 1);
    assert.equal(kv.store.get("stranger-objective"), before);
  });

  it("refuses other origins, an unbound store, and a held key without writing", async () => {
    const kv = memoryKv();
    const denied = await worker.fetch(
      postObjective("from pages", "https://evaisawesome2025.github.io"),
      { OBJECTIVE: kv, METERING_KV: meteringKv() }
    );
    assert.equal(denied.status, 403);
    const deniedBody = await denied.json();
    assert.equal(deniedBody.error, "origin_denied");
    assert.equal(deniedBody.ready, false);
    assert.equal(kv.puts.length, 0);

    const local = await worker.fetch(postObjective("from local", "http://127.0.0.1:8765"), {
      OBJECTIVE: kv,
    });
    assert.equal(local.status, 403);
    assert.equal(kv.puts.length, 0);

    const unbound = await worker.fetch(postObjective("needs a store"), { METERING_KV: meteringKv() });
    assert.equal(unbound.status, 503);
    const unboundBody = await unbound.json();
    assert.equal(unboundBody.error, "objective_store_unbound");
    assert.equal(unboundBody.ready, false);
    assert.equal(unboundBody.payment_fail, "not_lifted");

    const shared = memoryKv();
    const sameStore = await worker.fetch(postObjective("do not use metering"), {
      OBJECTIVE: shared,
      METERING_KV: shared,
    });
    assert.equal(sameStore.status, 503);
    assert.equal(shared.puts.length, 0);

    const held = memoryKv([["stranger-objective", "not-a-record"]]);
    const heldRes = await worker.fetch(postObjective("do not overwrite"), {
      OBJECTIVE: held,
      METERING_KV: meteringKv(),
    });
    assert.equal(heldRes.status, 409);
    const heldBody = await heldRes.json();
    assert.equal(heldBody.error, "objective_record_held");
    assert.equal(heldBody.run_id, undefined);
    assert.equal(held.puts.length, 0);
    assert.equal(held.store.get("stranger-objective"), "not-a-record");
  });

  it("does not save an empty sentence and leaves bearer routes unchanged", async () => {
    const kv = memoryKv();
    const env = {
      OBJECTIVE: kv,
      METERING_KV: meteringKv(),
      OWNER_BEARER: "owner-token",
      GH_PAT: "test-pat-not-real",
    };
    const empty = await worker.fetch(postObjective("   "), env);
    assert.equal(empty.status, 404);
    const emptyBody = await empty.json();
    assert.equal(emptyBody.error, "not_found");
    assert.equal(kv.puts.length, 0);
    assert.equal(kv.store.has("stranger-objective"), false);

    const intent = await worker.fetch(
      new Request("https://worker.test/intent", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://joinermill.com",
        },
        body: JSON.stringify({ type: "ask", body: "still needs the bearer" }),
      }),
      env
    );
    assert.equal(intent.status, 401);
    const intentBody = await intent.json();
    assert.equal(intentBody.error, "unauthorized");

    const complete = await worker.fetch(
      new Request("https://worker.test/metering/complete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://joinermill.com",
        },
        body: JSON.stringify({ job_id: "job-1" }),
      }),
      env
    );
    assert.equal(complete.status, 401);

    const health = await worker.fetch(new Request("https://worker.test/health"));
    const healthBody = await health.json();
    assert.equal(healthBody.ready, false);
    assert.equal(healthBody.payment_fail, "not_lifted");

    const missed = await worker.fetch(
      new Request("https://worker.test/objective/", {
        method: "POST",
        headers: { Origin: "https://joinermill.com", "Content-Type": "application/json" },
        body: JSON.stringify({ sentence: "wrong path" }),
      }),
      env
    );
    assert.equal(missed.status, 404);
    assert.equal(kv.puts.length, 0);
  });

  function storedObjective() {
    return {
      sentence: "Already saved",
      run_id: "run-existing",
      status: "SAVED",
      notes: PAID_RESEARCH_UNKNOWN_NOTES,
      artifact: "",
      time: "2026-10-04T12:00:00.000Z",
      next_step: OBJECTIVE_NEXT_STEP,
    };
  }

  it("reads the stored objective and the matching run id without writing", async () => {
    const record = storedObjective();
    const kv = memoryKv([["stranger-objective", JSON.stringify(record)]]);
    const before = kv.store.get("stranger-objective");
    const env = { OBJECTIVE: kv, METERING_KV: meteringKv() };

    const list = await worker.fetch(new Request("https://worker.test/objective"), env);
    assert.equal(list.status, 404);
    assert.equal((await list.json()).error, "not_found");

    const one = await worker.fetch(new Request("https://worker.test/objective/run-existing"), env);
    assert.equal(one.status, 200);
    const read = await one.json();
    assert.equal(read.sentence, record.sentence);
    assert.equal(read.run_id, record.run_id);
    assert.equal(read.status, record.status);
    assert.equal(read.notes, record.notes);
    assert.equal(read.artifact, "");
    assert.equal(read.time, record.time);
    assert.equal(read.next_step, record.next_step);
    assert.equal(read.ready, false);
    assert.equal(read.payment_fail, "not_lifted");
    assert.equal(read.saved, undefined);
    assert.equal(read.result, undefined);
    assert.equal(read.score, undefined);
    assert.equal(kv.puts.length, 0);
    assert.equal(kv.store.size, 1);
    assert.equal(kv.store.get("stranger-objective"), before);
  });

  it("returns 404 when the key is missing or the run id does not match", async () => {
    const empty = memoryKv();
    const missing = await worker.fetch(new Request("https://worker.test/objective"), {
      OBJECTIVE: empty,
      METERING_KV: meteringKv(),
    });
    assert.equal(missing.status, 404);
    const missingBody = await missing.json();
    assert.equal(missingBody.error, "not_found");
    assert.equal(missingBody.ready, false);
    assert.equal(missingBody.payment_fail, "not_lifted");
    assert.equal(empty.puts.length, 0);

    const missingRun = await worker.fetch(new Request("https://worker.test/objective/run-existing"), {
      OBJECTIVE: empty,
      METERING_KV: meteringKv(),
    });
    assert.equal(missingRun.status, 404);
    assert.equal(empty.store.size, 0);

    const kv = memoryKv([["stranger-objective", JSON.stringify(storedObjective())]]);
    const other = await worker.fetch(new Request("https://worker.test/objective/run-other"), {
      OBJECTIVE: kv,
      METERING_KV: meteringKv(),
    });
    assert.equal(other.status, 404);
    const otherBody = await other.json();
    assert.equal(otherBody.error, "not_found");
    assert.equal(otherBody.run_id, undefined);
    assert.equal(kv.puts.length, 0);
    assert.equal(kv.store.size, 1);
    assert.equal(JSON.parse(kv.store.get("stranger-objective")).sentence, "Already saved");

    const nested = await worker.fetch(new Request("https://worker.test/objective/run-existing/notes"), {
      OBJECTIVE: kv,
    });
    assert.equal(nested.status, 404);
    const slash = await worker.fetch(new Request("https://worker.test/objective/"), { OBJECTIVE: kv });
    assert.equal(slash.status, 404);
    assert.equal(kv.puts.length, 0);
    assert.equal(kv.store.size, 1);
  });

  it("does not read METERING_KV and does not backfill notes on a read", async () => {
    const kv = memoryKv([
      [
        "stranger-objective",
        JSON.stringify({
          sentence: "Already saved",
          run_id: "run-existing",
          status: "SAVED",
          notes: "",
          artifact: "",
          time: "2026-10-04T12:00:00.000Z",
          next_step: OBJECTIVE_NEXT_STEP,
        }),
      ],
    ]);
    const res = await worker.fetch(new Request("https://worker.test/objective/run-existing"), {
      OBJECTIVE: kv,
      METERING_KV: meteringKv(),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.notes, "");
    assert.equal(data.artifact, "");
    assert.equal(data.sentence, "Already saved");
    assert.equal(kv.puts.length, 0);

    const unbound = await worker.fetch(new Request("https://worker.test/objective"), {
      METERING_KV: meteringKv(),
    });
    assert.equal(unbound.status, 503);
    const unboundBody = await unbound.json();
    assert.equal(unboundBody.error, "objective_store_unbound");
    assert.equal(unboundBody.ready, false);
  });

  const FIXTURE_HTML = `<!doctype html>
<html><body>
<h1>Fixture mill</h1>
<p>Fixture hero line stays exact.</p>
<ul><li>Fixture status line says not for sale.</li></ul>
</body></html>`;

  const FOR_SALE_HTML = `<!doctype html>
<html><body>
<h1>Fixture shop</h1>
<p>Other fixture hero.</p>
<p>This fixture booth is for sale.</p>
</body></html>`;

  it("reads fixture html without baking a page sentence into the artifact helper", () => {
    assert.equal(pageNamedInSentence("See https://example.com/x"), "");
    assert.equal(pageNamedInSentence("Read https://joinermill.com today"), "https://joinermill.com/");
    const page = readObjectivePage(FIXTURE_HTML);
    assert.equal(page.ok, true);
    assert.equal(page.hero, "Fixture hero line stays exact.");
    assert.equal(page.notForSale, true);
    assert.equal(page.saleQuote, "Fixture status line says not for sale.");
    const artifact = composeObjectiveArtifact(page, "run-fixture");
    assert.match(artifact, /^Fixture hero line stays exact\./);
    assert.match(artifact, /Not for sale\. "Fixture status line says not for sale\."/);
    assert.ok(artifact.includes("run-fixture"));
    assert.equal(artifactTextToStore(artifact, "run-fixture"), artifact);
    assert.equal(artifactTextToStore("Fixture hero line stays exact.", "run-fixture"), "");
    const sale = readObjectivePage(FOR_SALE_HTML);
    const saleArtifact = composeObjectiveArtifact(sale, "run-fixture");
    assert.equal(saleArtifact.includes("Not for sale."), false);
    assert.match(saleArtifact, /"This fixture booth is for sale\."/);
    assert.equal(readObjectivePage("<h1>Only heading</h1><div>no paragraph</div>").ok, false);
    const src = fs.readFileSync(path.join(__dirname, "../src/index.js"), "utf8");
    assert.equal(src.includes("Fixture hero line stays exact"), false);
    assert.equal(src.includes("This fixture booth is for sale"), false);
  });

  it("does not fetch or store an artifact from a public post", async () => {
    const kv = memoryKv();
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      return new Response(FIXTURE_HTML, { status: 200, headers: { "Content-Type": "text/html" } });
    };
    const env = { OBJECTIVE: kv, METERING_KV: meteringKv() };
    const res = await worker.fetch(
      postObjective("Read https://joinermill.com and quote the page.", "https://joinermill.com", {
        artifact: "client-supplied-artifact",
        result: "invented result",
        score: 10,
      }),
      env
    );
    assert.equal(res.status, 404);
    assert.equal(fetches, 0);
    assert.equal(kv.puts.length, 0);
    assert.equal(kv.store.size, 0);
    assert.equal(kv.store.has("stranger-objective"), false);

    const record = storedObjective();
    record.artifact = "already-stored";
    const seeded = memoryKv([["stranger-objective", JSON.stringify(record)]]);
    const again = await worker.fetch(
      postObjective("A different sentence https://joinermill.com", "https://www.joinermill.com"),
      { OBJECTIVE: seeded, METERING_KV: meteringKv() }
    );
    assert.equal(again.status, 200);
    const resumed = await again.json();
    assert.equal(fetches, 0);
    assert.equal(seeded.puts.length, 0);
    assert.equal(resumed.run_id, record.run_id);
    assert.equal(resumed.sentence, record.sentence);
    assert.equal(resumed.artifact, "already-stored");
    assert.equal(resumed.saved, false);
    assert.equal(seeded.store.get("stranger-objective"), JSON.stringify(record));
  });

  it("does not write when a public post names a page", async () => {
    const kv = memoryKv();
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      throw new Error("fixture fetch failed");
    };
    const res = await worker.fetch(
      postObjective("Read https://joinermill.com", "https://joinermill.com"),
      { OBJECTIVE: kv, METERING_KV: meteringKv() }
    );
    assert.equal(res.status, 404);
    assert.equal(fetches, 0);
    assert.equal(kv.puts.length, 0);
    assert.equal(kv.store.has("stranger-objective"), false);

    const missing = memoryKv();
    const missingRes = await worker.fetch(
      postObjective("Read https://www.joinermill.com/now", "https://joinermill.com"),
      { OBJECTIVE: missing, METERING_KV: meteringKv() }
    );
    assert.equal(missingRes.status, 404);
    assert.equal(fetches, 0);
    assert.equal(missing.puts.length, 0);
    assert.equal(missing.store.size, 0);
  });

  function resultObjectiveRecord() {
    const runId = "dca70509780aa2891c9dce962166eae2";
    const time = "2026-10-04T14:00:00.000Z";
    const sentence = "Read https://joinermill.com and quote the page.";
    const artifact = [
      "Fixture hero line stays exact.",
      "",
      'Not for sale. "Fixture status line says not for sale."',
      "",
      runId,
    ].join("\n");
    const event = (name, beforeState, afterState) => ({
      name,
      run_id: runId,
      time,
      who: "worker",
      before_state: beforeState,
      after_state: afterState,
    });
    return {
      sentence,
      run_id: runId,
      status: "SAVED",
      notes: PAGE_READ_NOTES,
      artifact,
      time,
      next_step: OBJECTIVE_NEXT_STEP,
      events: [
        event("received", { present: false }, { present: false, ready: false }),
        event("saved", { sentence: "", status: "", ready: false }, { sentence, status: "SAVED", ready: false }),
        event("owner", { ready: false }, { ready: false, approval: false }),
        event("work started", { work: "not_started", ready: false, approval: false }, { work: "started", ready: false, approval: false }),
        event("artifact", { artifact: "" }, { artifact }),
        event("record updated", { artifact: "", status: "SAVED", ready: false }, { artifact, status: "SAVED", ready: false }),
        event("result", { status: "SAVED", ready: false, approval: false }, { status: "SAVED", ready: false, approval: false }),
      ],
    };
  }

  function closeEnv(kv, extra = {}) {
    return {
      OBJECTIVE: kv,
      METERING_KV: meteringKv(),
      OWNER_BEARER: "owner-token",
      GH_PAT: "test-pat-not-real",
      ...extra,
    };
  }

  function postClose(runId, body, token = "owner-token") {
    const headers = {
      "Content-Type": "application/json",
      Origin: "https://joinermill.com",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return new Request(`https://worker.test/objective/${runId}/close`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  it("close of Run 1 writes nothing and leaves the stored body unchanged", async () => {
    resetIngressForTests();
    const record = resultObjectiveRecord();
    const kv = memoryKv([["stranger-objective", JSON.stringify(record)]]);
    const env = closeEnv(kv);
    const reasons = [
      "Glen confirmed that missing path is a fail.",
      "The organization stalled until he intervened at 9:39 AM CT.",
    ];
    const body = {
      audit_id: "AUDIT-20261004-0847-RUN-READ",
      terminal: "failed",
      reasons,
      pass: true,
      ready: true,
      approval: true,
      who: "Glen",
      sentence: "A replacement sentence",
      artifact: "A replacement artifact",
      run_id: "ffffffffffffffffffffffffffffffff",
      time: "1999-01-01T00:00:00.000Z",
    };

    const listed = await worker.fetch(new Request("https://worker.test/objective"), env);
    assert.equal(listed.status, 404);
    assert.equal((await listed.json()).error, "not_found");
    assert.equal(kv.puts.length, 0);

    const readFirst = await worker.fetch(
      new Request(`https://worker.test/objective/${record.run_id}`),
      env
    );
    assert.equal(readFirst.status, 200);
    assert.equal((await readFirst.json()).sentence, record.sentence);
    assert.equal(kv.puts.length, 0);

    const anonymous = await worker.fetch(postClose(record.run_id, body, ""), env);
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).error, "unauthorized");
    const wrong = await worker.fetch(postClose(record.run_id, body, "not-the-owner"), env);
    assert.equal(wrong.status, 401);
    assert.equal(kv.puts.length, 0);
    assert.equal(kv.store.get("stranger-objective"), JSON.stringify(record));

    const otherRun = await worker.fetch(postClose("a".repeat(32), body), env);
    assert.equal(otherRun.status, 404);
    assert.equal(kv.puts.length, 0);
    assert.equal(kv.store.size, 1);
    assert.equal(JSON.parse(kv.store.get("stranger-objective")).run_id, record.run_id);

    const empty = memoryKv();
    const created = await worker.fetch(postClose(record.run_id, body), closeEnv(empty));
    assert.equal(created.status, 404);
    assert.equal(empty.puts.length, 0);
    assert.equal(empty.store.size, 0);

    const closed = await worker.fetch(postClose(record.run_id, body), env);
    assert.equal(closed.status, 409);
    const data = await closed.json();
    assert.equal(data.error, "terminal_exists");
    assert.equal(data.ready, false);
    assert.equal(data.payment_fail, "not_lifted");
    assert.equal(data.sentence, undefined);
    assert.equal(kv.puts.length, 0);
    assert.equal(kv.store.size, 1);
    assert.equal(kv.store.get("stranger-objective"), JSON.stringify(record));
    const stored = JSON.parse(kv.store.get("stranger-objective"));
    assert.deepEqual(stored.events, record.events);
    assert.equal(stored.sentence, record.sentence);
    assert.equal(stored.artifact, record.artifact);
    assert.equal(stored.run_id, record.run_id);
    assert.equal(JSON.stringify(stored).includes('"who":"Glen"'), false);

    const src = fs.readFileSync(path.join(__dirname, "../src/index.js"), "utf8");
    assert.equal(src.includes(record.run_id), false);
    assert.equal(src.includes("AUDIT-20261004-0847-RUN-READ"), false);
    assert.equal(src.includes("9:39"), false);
    assert.equal(src.includes(reasons[0]), false);

    const putsAfterClose = kv.puts.length;
    const read = await worker.fetch(new Request(`https://worker.test/objective/${record.run_id}`), env);
    assert.equal(read.status, 200);
    const readBody = await read.json();
    assert.equal(readBody.sentence, record.sentence);
    assert.equal(readBody.artifact, record.artifact);
    assert.equal(readBody.run_id, record.run_id);
    const listAgain = await worker.fetch(new Request("https://worker.test/objective"), env);
    assert.equal(listAgain.status, 404);
    assert.equal((await listAgain.json()).error, "not_found");
    const getClose = await worker.fetch(
      new Request(`https://worker.test/objective/${record.run_id}/close`),
      env
    );
    assert.equal(getClose.status, 404);
    assert.equal(kv.puts.length, putsAfterClose);

    const second = await worker.fetch(
      postClose(record.run_id, { ...body, terminal: "completed", audit_id: "AUDIT-SECOND" }),
      env
    );
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error, "terminal_exists");
    assert.equal(kv.puts.length, putsAfterClose);
    assert.deepEqual(JSON.parse(kv.store.get("stranger-objective")).events, stored.events);
    assert.equal(kv.store.size, 1);
  });

  it("does not write a completed terminal onto Run 1", async () => {
    resetIngressForTests();
    const record = resultObjectiveRecord();
    const raw = JSON.stringify(record);
    const kv = memoryKv([["stranger-objective", raw]]);
    const env = closeEnv(kv);
    const closed = await worker.fetch(
      postClose(record.run_id, { audit_id: "AUDIT-20261004-0847-RUN-READ", terminal: "completed" }),
      env
    );
    assert.equal(closed.status, 409);
    assert.equal((await closed.json()).error, "terminal_exists");
    assert.equal(kv.store.get("stranger-objective"), raw);
    assert.equal(kv.puts.length, 0);
    assert.equal(kv.store.size, 1);
    const second = await worker.fetch(
      postClose(record.run_id, {
        audit_id: "AUDIT-20261004-0847-RUN-READ",
        terminal: "failed",
        reasons: ["another terminal"],
      }),
      env
    );
    assert.equal(second.status, 409);
    assert.equal(kv.puts.length, 0);
    assert.equal(kv.store.get("stranger-objective"), raw);
    assert.equal(JSON.parse(raw).events.at(-1).name, "result");
  });

  function storedFailPair(status) {
    const record = resultObjectiveRecord();
    const time = "2026-10-04T15:00:00.000Z";
    record.status = status;
    record.events = record.events.concat([
      {
        name: "audit",
        run_id: record.run_id,
        time,
        who: "worker",
        before_state: { audit_id: "", pass: false, ready: false, approval: false },
        after_state: {
          audit_id: "AUDIT-20261004-0847-RUN-READ",
          pass: false,
          ready: false,
          approval: false,
        },
      },
      {
        name: "failed",
        run_id: record.run_id,
        time,
        who: "worker",
        before_state: { terminal: "", reasons: [], pass: false, ready: false, approval: false },
        after_state: {
          terminal: "failed",
          reasons: ["missing path"],
          pass: false,
          ready: false,
          approval: false,
        },
      },
    ]);
    return record;
  }

  it("projects status from events on read and does not write", async () => {
    const open = resultObjectiveRecord();
    open.status = "OTHER";
    const openKv = memoryKv([["stranger-objective", JSON.stringify(open)]]);
    const openBefore = openKv.store.get("stranger-objective");
    const openRead = await worker.fetch(new Request(`https://worker.test/objective/${open.run_id}`), {
      OBJECTIVE: openKv,
    });
    assert.equal(openRead.status, 200);
    const openBody = await openRead.json();
    assert.equal(openBody.status, "SAVED");
    assert.equal(openBody.ready, false);
    assert.equal(openBody.sentence, open.sentence);
    assert.equal(openKv.puts.length, 0);
    assert.equal(openKv.store.get("stranger-objective"), openBefore);

    const record = storedFailPair("SAVED");
    const kv = memoryKv([["stranger-objective", JSON.stringify(record)]]);
    const before = kv.store.get("stranger-objective");
    const read = await worker.fetch(new Request("https://worker.test/objective"), { OBJECTIVE: kv });
    assert.equal(read.status, 404);
    assert.equal((await read.json()).error, "not_found");
    const byId = await worker.fetch(new Request(`https://worker.test/objective/${record.run_id}`), {
      OBJECTIVE: kv,
    });
    assert.equal(byId.status, 200);
    const body = await byId.json();
    assert.equal(body.status, "failed");
    assert.equal(body.ready, false);
    assert.equal(body.sentence, record.sentence);
    assert.equal(body.artifact, record.artifact);
    assert.equal(body.run_id, record.run_id);
    assert.deepEqual(body.events, record.events);
    assert.equal(kv.puts.length, 0);
    assert.equal(kv.store.get("stranger-objective"), before);
    assert.equal(JSON.parse(before).status, "SAVED");
  });

  it("does not rewrite a stored pass-false pair on close", async () => {
    resetIngressForTests();
    const record = storedFailPair("SAVED");
    const kv = memoryKv([["stranger-objective", JSON.stringify(record)]]);
    const env = closeEnv(kv);
    const eventsBefore = JSON.stringify(record.events);
    const same = { terminal: "failed", audit_id: "AUDIT-20261004-0847-RUN-READ", pass: false };

    const anonymous = await worker.fetch(postClose(record.run_id, same, ""), env);
    assert.equal(anonymous.status, 401);
    assert.equal(kv.puts.length, 0);

    const otherVerdict = await worker.fetch(postClose(record.run_id, { ...same, pass: true }), env);
    assert.equal(otherVerdict.status, 409);
    const otherTerminal = await worker.fetch(postClose(record.run_id, { ...same, terminal: "completed" }), env);
    assert.equal(otherTerminal.status, 409);
    assert.equal(kv.puts.length, 0);
    assert.equal(JSON.parse(kv.store.get("stranger-objective")).status, "SAVED");
    assert.equal(JSON.stringify(JSON.parse(kv.store.get("stranger-objective")).events), eventsBefore);

    const corrected = await worker.fetch(
      postClose(record.run_id, { ...same, sentence: "nope", artifact: "nope", status: "SAVED", who: "Glen" }),
      env
    );
    assert.equal(corrected.status, 409);
    assert.equal((await corrected.json()).error, "terminal_exists");
    assert.equal(kv.puts.length, 0);
    assert.equal(kv.store.size, 1);
    const stored = JSON.parse(kv.store.get("stranger-objective"));
    assert.equal(stored.status, "SAVED");
    assert.equal(JSON.stringify(stored.events), eventsBefore);
    assert.equal(stored.sentence, record.sentence);
    assert.equal(stored.artifact, record.artifact);
    assert.equal(stored.notes, record.notes);
    assert.equal(stored.run_id, record.run_id);

    const again = await worker.fetch(postClose(record.run_id, same), env);
    assert.equal(again.status, 409);
    assert.equal(kv.puts.length, 0);
    assert.equal(JSON.stringify(JSON.parse(kv.store.get("stranger-objective")).events), eventsBefore);

    const read = await worker.fetch(new Request(`https://worker.test/objective/${record.run_id}`), env);
    assert.equal((await read.json()).status, "failed");
    assert.equal(kv.puts.length, 0);
    assert.equal(kv.store.get("stranger-objective"), JSON.stringify(record));
  });

  it("does not append a close without the owner boundary", async () => {
    resetIngressForTests();
    const record = resultObjectiveRecord();
    const kv = memoryKv([["stranger-objective", JSON.stringify(record)]]);
    const before = kv.store.get("stranger-objective");
    const body = { audit_id: "AUDIT-20261004-0847-RUN-READ", terminal: "failed", reasons: ["x"] };
    const missingPat = await worker.fetch(postClose(record.run_id, body), {
      OBJECTIVE: kv,
      METERING_KV: meteringKv(),
      OWNER_BEARER: "owner-token",
    });
    assert.equal(missingPat.status, 503);
    assert.equal((await missingPat.json()).error, "ingress_not_configured");
    const denied = await worker.fetch(
      new Request(`https://worker.test/objective/${record.run_id}/close`, {
        method: "POST",
        headers: {
          Authorization: "Bearer owner-token",
          "Content-Type": "application/json",
          Origin: "https://evil.example",
        },
        body: JSON.stringify(body),
      }),
      closeEnv(kv)
    );
    assert.equal(denied.status, 403);
    assert.equal(kv.puts.length, 0);
    assert.equal(kv.store.get("stranger-objective"), before);
    assert.equal(kv.store.size, 1);
  });
});
