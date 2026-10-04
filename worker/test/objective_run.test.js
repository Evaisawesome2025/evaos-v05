/**
 * One objective, one open run beside terminal Run 1.
 * No Cloudflare calls. stranger-objective is not written.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  OBJECTIVE_NEXT_STEP,
  PAGE_READ_NOTES,
  objectivePointerKey,
  readObjectiveRun,
  writeObjectiveRun,
} from "../src/index.js";

const RUN1 = "dca70509780aa2891c9dce962166eae2";
const RUN2 = "b7e1c0a94d552e6f8a013c47d9ab60e1";
const OBJECTIVE_ID = "9c1e0b7a4d224f0a8e6b51d0c3a7e214";
const OBJECTIVE_KEY = objectivePointerKey(OBJECTIVE_ID);

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

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
      puts.push({ key, value });
      store.set(key, value);
    },
    async delete() {
      throw new Error("objective key must not be deleted");
    },
  };
}

function event(runId, name, beforeState, afterState) {
  return {
    name,
    run_id: runId,
    time: "2026-10-04T15:00:00.000Z",
    who: "worker",
    before_state: beforeState,
    after_state: afterState,
  };
}

function terminalRun1() {
  const sentence = "Read https://joinermill.com and quote the page.";
  const artifact = "Fixture hero line stays exact.\n\n" + RUN1;
  const saved = { status: "SAVED", ready: false };
  return {
    sentence,
    run_id: RUN1,
    status: "failed",
    notes: PAGE_READ_NOTES,
    artifact,
    time: "2026-10-04T14:00:00.000Z",
    next_step: OBJECTIVE_NEXT_STEP,
    events: [
      event(RUN1, "received", { present: false }, { present: false, ready: false }),
      event(RUN1, "saved", { sentence: "", status: "" }, { sentence, status: "SAVED", ready: false }),
      event(RUN1, "artifact", { artifact: "" }, { artifact }),
      event(RUN1, "result", saved, { ...saved, approval: false }),
      event(
        RUN1,
        "audit",
        { audit_id: "", pass: false, ready: false, approval: false },
        { audit_id: "AUDIT-20261004-0847-RUN-READ", pass: false, ready: false, approval: false }
      ),
      event(
        RUN1,
        "failed",
        { terminal: "", reasons: [], pass: false, ready: false, approval: false },
        { terminal: "failed", reasons: ["missing path"], pass: false, ready: false, approval: false }
      ),
    ],
  };
}

function openRun1() {
  const record = terminalRun1();
  record.status = "SAVED";
  record.events = record.events.filter((item) => item.name !== "audit" && item.name !== "failed");
  return record;
}

function run2Events() {
  return [
    event(
      RUN2,
      "saved",
      { sentence: "", status: "", ready: false },
      { status: "SAVED", ready: false }
    ),
  ];
}

describe("objective run pointer", () => {
  it("stores Run 2 beside an unchanged Run 1 and the pointer names Run 2", async () => {
    const run1 = terminalRun1();
    const raw1 = JSON.stringify(run1);
    const hash1 = sha256(raw1);
    const kv = memoryKv([["stranger-objective", raw1]]);
    const evidence = "run-2 evidence only";

    const wrote = await writeObjectiveRun(kv, {
      objective_id: OBJECTIVE_ID,
      run_id: RUN2,
      events: run2Events(),
      evidence,
      verdict: null,
    });

    assert.equal(wrote.ok, true);
    assert.equal(kv.store.get("stranger-objective"), raw1);
    assert.equal(sha256(kv.store.get("stranger-objective")), hash1);
    assert.equal(JSON.parse(raw1).run_id, RUN1);
    assert.equal(JSON.parse(kv.store.get("stranger-objective")).status, "failed");
    assert.deepEqual(
      JSON.parse(kv.store.get("stranger-objective")).events.slice(-2).map((item) => item.name),
      ["audit", "failed"]
    );

    assert.notEqual(RUN2, RUN1);
    assert.notEqual(OBJECTIVE_ID, RUN2);
    assert.equal(OBJECTIVE_KEY, `objective/${OBJECTIVE_ID}`);
    const stored2 = JSON.parse(kv.store.get(RUN2));
    assert.equal(stored2.run_id, RUN2);
    assert.equal(stored2.objective_id, OBJECTIVE_ID);
    assert.equal(stored2.evidence, evidence);
    assert.equal(stored2.verdict, null);
    assert.equal(stored2.sentence, undefined);
    assert.equal(stored2.artifact, undefined);
    assert.deepEqual(
      stored2.events.map((item) => item.name),
      ["saved"]
    );
    assert.equal(stored2.events.some((item) => item.name === "completed" || item.name === "failed"), false);

    const pointer = JSON.parse(kv.store.get(OBJECTIVE_KEY));
    assert.deepEqual(pointer, { objective_id: OBJECTIVE_ID, open_run_id: RUN2 });
    assert.deepEqual(Object.keys(pointer).sort(), ["objective_id", "open_run_id"]);

    assert.deepEqual(
      kv.puts.map((put) => put.key),
      [RUN2, OBJECTIVE_KEY]
    );
    assert.equal(kv.puts.some((put) => put.key === "stranger-objective"), false);
  });

  it("reads each run id as its own history and does not create a missing key", async () => {
    const run1 = terminalRun1();
    const raw1 = JSON.stringify(run1);
    const kv = memoryKv([["stranger-objective", raw1]]);
    const evidence = "run-2 evidence only";
    await writeObjectiveRun(kv, {
      objective_id: OBJECTIVE_ID,
      run_id: RUN2,
      events: run2Events(),
      evidence,
      verdict: null,
    });
    const putsAfterWrite = kv.puts.length;
    const keysAfterWrite = [...kv.store.keys()];

    const first = await readObjectiveRun(kv, RUN1);
    const second = await readObjectiveRun(kv, RUN2);
    assert.equal(first.run_id, RUN1);
    assert.equal(second.run_id, RUN2);
    assert.equal(first.status, "failed");
    assert.equal(second.status, "SAVED");
    assert.equal(first.sentence, run1.sentence);
    assert.equal(first.artifact, run1.artifact);
    assert.equal(first.evidence, undefined);
    assert.equal(second.evidence, evidence);
    assert.equal(second.sentence, undefined);
    assert.equal(second.artifact, undefined);
    assert.equal(JSON.stringify(first).includes(evidence), false);
    assert.equal(JSON.stringify(second).includes(run1.sentence), false);
    assert.equal(JSON.stringify(second).includes(RUN1), false);
    assert.notDeepEqual(first.events, second.events);
    assert.deepEqual(
      first.events.slice(-2).map((item) => item.name),
      ["audit", "failed"]
    );
    assert.deepEqual(
      second.events.map((item) => item.name),
      ["saved"]
    );

    const missing = await readObjectiveRun(kv, "c".repeat(32));
    assert.equal(missing, null);
    assert.equal(kv.store.has("c".repeat(32)), false);
    assert.deepEqual([...kv.store.keys()], keysAfterWrite);
    assert.equal(kv.puts.length, putsAfterWrite);
    assert.equal(kv.store.get("stranger-objective"), raw1);
  });

  it("appends on the open run key only and does not rewrite a terminal run", async () => {
    const raw1 = JSON.stringify(terminalRun1());
    const kv = memoryKv([["stranger-objective", raw1]]);
    await writeObjectiveRun(kv, {
      objective_id: OBJECTIVE_ID,
      run_id: RUN2,
      events: run2Events(),
      evidence: "run-2 evidence only",
      verdict: null,
    });
    const pointerBefore = kv.store.get(OBJECTIVE_KEY);
    kv.puts.length = 0;

    const appended = await writeObjectiveRun(kv, {
      objective_id: OBJECTIVE_ID,
      run_id: RUN2,
      events: [
        event(
          RUN2,
          "failed",
          { terminal: "", reasons: [], pass: false, ready: false, approval: false },
          { terminal: "failed", reasons: ["run 2 stopped"], pass: false, ready: false, approval: false }
        ),
      ],
      verdict: { terminal: "failed", pass: false },
    });
    assert.equal(appended.ok, true);
    assert.deepEqual(
      kv.puts.map((put) => put.key),
      [RUN2]
    );
    assert.equal(kv.store.get(OBJECTIVE_KEY), pointerBefore);
    assert.equal(kv.store.get("stranger-objective"), raw1);
    const closed = JSON.parse(kv.store.get(RUN2));
    assert.deepEqual(
      closed.events.map((item) => item.name),
      ["saved", "failed"]
    );
    assert.deepEqual(closed.verdict, { terminal: "failed", pass: false });

    kv.puts.length = 0;
    const again = await writeObjectiveRun(kv, {
      objective_id: OBJECTIVE_ID,
      run_id: RUN2,
      events: [event(RUN2, "completed", { terminal: "" }, { terminal: "completed" })],
    });
    assert.equal(again.ok, false);
    assert.equal(again.error, "refused");
    assert.equal(kv.puts.length, 0);
    assert.deepEqual(
      JSON.parse(kv.store.get(RUN2)).events.map((item) => item.name),
      ["saved", "failed"]
    );
    assert.equal(kv.store.get("stranger-objective"), raw1);
    assert.equal(kv.store.get(OBJECTIVE_KEY), pointerBefore);
  });

  it("refuses a write that would leave two open runs and writes nothing", async () => {
    const raw1 = JSON.stringify(openRun1());
    const kv = memoryKv([
      ["stranger-objective", raw1],
      [OBJECTIVE_KEY, JSON.stringify({ objective_id: OBJECTIVE_ID, open_run_id: RUN1 })],
    ]);
    const wrote = await writeObjectiveRun(kv, {
      objective_id: OBJECTIVE_ID,
      run_id: RUN2,
      events: run2Events(),
      evidence: "should not land",
      verdict: null,
    });
    assert.equal(wrote.ok, false);
    assert.equal(wrote.error, "refused");
    assert.equal(kv.puts.length, 0);
    assert.equal(kv.store.size, 2);
    assert.equal(kv.store.get("stranger-objective"), raw1);
    assert.equal(kv.store.has(RUN2), false);
    assert.equal(
      kv.store.get(OBJECTIVE_KEY),
      JSON.stringify({ objective_id: OBJECTIVE_ID, open_run_id: RUN1 })
    );
  });

  it("refuses a write when the pointer disagrees with the one open run", async () => {
    const raw1 = JSON.stringify(terminalRun1());
    const kv = memoryKv([["stranger-objective", raw1]]);
    await writeObjectiveRun(kv, {
      objective_id: OBJECTIVE_ID,
      run_id: RUN2,
      events: run2Events(),
      evidence: "run-2 evidence only",
      verdict: null,
    });
    const run2Before = kv.store.get(RUN2);
    kv.store.set(
      OBJECTIVE_KEY,
      JSON.stringify({ objective_id: OBJECTIVE_ID, open_run_id: "d".repeat(32) })
    );
    const pointerBefore = kv.store.get(OBJECTIVE_KEY);
    kv.puts.length = 0;

    const wrote = await writeObjectiveRun(kv, {
      objective_id: OBJECTIVE_ID,
      run_id: RUN2,
      events: [event(RUN2, "artifact", { artifact: "" }, { artifact: "more" })],
      evidence: "changed",
    });
    assert.equal(wrote.ok, false);
    assert.equal(wrote.error, "refused");
    assert.equal(kv.puts.length, 0);
    assert.equal(kv.store.get("stranger-objective"), raw1);
    assert.equal(kv.store.get(RUN2), run2Before);
    assert.equal(kv.store.get(OBJECTIVE_KEY), pointerBefore);
  });
});
