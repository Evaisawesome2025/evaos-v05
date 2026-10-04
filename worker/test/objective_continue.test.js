/**
 * Same-run continuation. Synthetic ids and an in-memory store only.
 * No Cloudflare calls. stranger-objective is not written.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker, { objectivePointerKey, resetIngressForTests } from "../src/index.js";

const OBJECTIVE_ID = "a4c0e1b27233445566778899aabbccdd";
const OPEN_RUN_ID = "b4c0e1b27233445566778899aabbccde";
const OTHER_RUN_ID = "c4c0e1b27233445566778899aabbccdf";
const OTHER_OBJECTIVE_ID = "d4c0e1b27233445566778899aabbccd0";
const POINTER_KEY = objectivePointerKey(OBJECTIVE_ID);

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
    async list({ prefix } = {}) {
      const keys = [];
      for (const name of store.keys()) {
        if (!prefix || String(name).startsWith(prefix)) keys.push({ name });
      }
      return { keys, list_complete: true };
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

function openRun(runId, objectiveId) {
  return {
    run_id: runId,
    objective_id: objectiveId,
    events: [event(runId, "saved", { status: "" }, { status: "SAVED", ready: false })],
    evidence: null,
    verdict: null,
  };
}

function pointer(objectiveId, openRunId) {
  return JSON.stringify({ objective_id: objectiveId, open_run_id: openRunId });
}

function agreedStore() {
  const run = openRun(OPEN_RUN_ID, OBJECTIVE_ID);
  return memoryKv([
    [OPEN_RUN_ID, JSON.stringify(run)],
    [POINTER_KEY, pointer(OBJECTIVE_ID, OPEN_RUN_ID)],
  ]);
}

function ownerEnv(kv) {
  return {
    OBJECTIVE: kv,
    OWNER_BEARER: "owner-token",
    GH_PAT: "test-pat-not-real",
  };
}

function continueRequest(body, token = "owner-token") {
  const headers = {
    "Content-Type": "application/json",
    Origin: "https://joinermill.com",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request("https://worker.test/objective/continue", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function action() {
  return {
    name: "record updated",
    time: "2026-10-04T16:00:00.000Z",
    before_state: { status: "SAVED", ready: false },
    after_state: { status: "SAVED", ready: false },
  };
}

function pair(objectiveId, openRunId, carried = action()) {
  return { objective_id: objectiveId, open_run_id: openRunId, action: carried };
}

describe("same-run continuation", () => {
  it("appends the action on the matching open run and does not create a run key", async () => {
    resetIngressForTests();
    const kv = agreedStore();
    const keysBefore = [...kv.store.keys()].sort();
    const runBefore = kv.store.get(OPEN_RUN_ID);
    const pointerBefore = kv.store.get(POINTER_KEY);
    const env = ownerEnv(kv);

    const anonymous = await worker.fetch(continueRequest(pair(OBJECTIVE_ID, OPEN_RUN_ID), ""), env);
    assert.equal(anonymous.status, 401);
    assert.equal(kv.puts.length, 0);
    assert.equal(kv.store.get(OPEN_RUN_ID), runBefore);

    const res = await worker.fetch(continueRequest(pair(OBJECTIVE_ID, OPEN_RUN_ID)), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.run_id, OPEN_RUN_ID);
    assert.equal(body.objective_id, OBJECTIVE_ID);
    assert.equal(body.ready, false);
    assert.equal(body.payment_fail, "not_lifted");
    assert.deepEqual(
      body.events.map((item) => item.name),
      ["saved", "record updated"]
    );
    assert.equal(body.events[1].run_id, OPEN_RUN_ID);
    assert.equal(body.events[1].who, "worker");
    assert.deepEqual(body.events[1].after_state, { status: "SAVED", ready: false });

    const stored = JSON.parse(kv.store.get(OPEN_RUN_ID));
    assert.equal(stored.run_id, OPEN_RUN_ID);
    assert.deepEqual(
      stored.events.map((item) => item.name),
      ["saved", "record updated"]
    );
    assert.equal(stored.verdict, null);
    assert.equal(stored.next_action, undefined);
    assert.deepEqual([...kv.store.keys()].sort(), keysBefore);
    assert.equal(kv.store.has(OTHER_RUN_ID), false);
    assert.equal(kv.store.has("stranger-objective"), false);
    assert.deepEqual(
      kv.puts.map((put) => put.key),
      [OPEN_RUN_ID]
    );
    assert.equal(kv.store.get(POINTER_KEY), pointerBefore);
    assert.equal(kv.puts.some((put) => put.key === "stranger-objective"), false);
  });

  it("writes nothing when the ids do not name that open run", async () => {
    resetIngressForTests();
    const kv = agreedStore();
    const before = new Map(kv.store);
    const env = ownerEnv(kv);
    const attempts = [
      pair(OTHER_OBJECTIVE_ID, OPEN_RUN_ID),
      pair(OBJECTIVE_ID, OTHER_RUN_ID),
      { objective_id: OBJECTIVE_ID, open_run_id: OPEN_RUN_ID, run_id: OTHER_RUN_ID, action: action() },
    ];
    for (const body of attempts) {
      const res = await worker.fetch(continueRequest(body), env);
      assert.equal(res.status, 409);
      const data = await res.json();
      assert.equal(data.error, "refused");
      assert.equal(data.ready, false);
      assert.equal(data.payment_fail, "not_lifted");
    }
    kv.store.set(POINTER_KEY, pointer(OBJECTIVE_ID, OTHER_RUN_ID));
    const disagreed = await worker.fetch(continueRequest(pair(OBJECTIVE_ID, OPEN_RUN_ID)), env);
    assert.equal(disagreed.status, 409);
    assert.equal(kv.puts.length, 0);
    assert.equal(kv.store.has(OTHER_RUN_ID), false);
    assert.equal(kv.store.has("stranger-objective"), false);
    assert.equal(kv.store.get(OPEN_RUN_ID), before.get(OPEN_RUN_ID));
  });

  it("writes nothing for a terminal run", async () => {
    resetIngressForTests();
    const terminal = openRun(OPEN_RUN_ID, OBJECTIVE_ID);
    terminal.events.push(
      event(OPEN_RUN_ID, "completed", { terminal: "" }, { terminal: "completed" })
    );
    const raw = JSON.stringify(terminal);
    const kv = memoryKv([
      [OPEN_RUN_ID, raw],
      [POINTER_KEY, pointer(OBJECTIVE_ID, OPEN_RUN_ID)],
    ]);
    const res = await worker.fetch(continueRequest(pair(OBJECTIVE_ID, OPEN_RUN_ID)), ownerEnv(kv));
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, "refused");
    assert.equal(kv.puts.length, 0);
    assert.equal(kv.store.get(OPEN_RUN_ID), raw);
    assert.equal(kv.store.has("stranger-objective"), false);
  });

  it("writes nothing when a second open run is present", async () => {
    resetIngressForTests();
    const otherPointer = objectivePointerKey(OTHER_OBJECTIVE_ID);
    const kv = memoryKv([
      [OPEN_RUN_ID, JSON.stringify(openRun(OPEN_RUN_ID, OBJECTIVE_ID))],
      [OTHER_RUN_ID, JSON.stringify(openRun(OTHER_RUN_ID, OTHER_OBJECTIVE_ID))],
      [POINTER_KEY, pointer(OBJECTIVE_ID, OPEN_RUN_ID)],
      [otherPointer, pointer(OTHER_OBJECTIVE_ID, OTHER_RUN_ID)],
    ]);
    const env = ownerEnv(kv);
    const first = await worker.fetch(continueRequest(pair(OBJECTIVE_ID, OPEN_RUN_ID)), env);
    const second = await worker.fetch(continueRequest(pair(OTHER_OBJECTIVE_ID, OTHER_RUN_ID)), env);
    assert.equal(first.status, 409);
    assert.equal(second.status, 409);
    assert.equal(kv.puts.length, 0);

    const sibling = memoryKv([
      [OPEN_RUN_ID, JSON.stringify(openRun(OPEN_RUN_ID, OBJECTIVE_ID))],
      [OTHER_RUN_ID, JSON.stringify(openRun(OTHER_RUN_ID, OBJECTIVE_ID))],
      [POINTER_KEY, pointer(OBJECTIVE_ID, OPEN_RUN_ID)],
    ]);
    const siblingEnv = ownerEnv(sibling);
    const siblingRes = await worker.fetch(continueRequest(pair(OBJECTIVE_ID, OTHER_RUN_ID)), siblingEnv);
    const pointedSibling = await worker.fetch(continueRequest(pair(OBJECTIVE_ID, OPEN_RUN_ID)), siblingEnv);
    assert.equal(siblingRes.status, 409);
    assert.equal(pointedSibling.status, 409);
    assert.equal(sibling.puts.length, 0);
    assert.equal(sibling.store.has("stranger-objective"), false);

    const creating = agreedStore();
    const freshId = "e4c0e1b27233445566778899aabbccd1";
    const created = await worker.fetch(continueRequest(pair(OBJECTIVE_ID, freshId)), ownerEnv(creating));
    assert.equal(created.status, 409);
    assert.equal(creating.puts.length, 0);
    assert.equal(creating.store.has(freshId), false);
    assert.equal(creating.store.size, 2);
  });

  it("writes nothing when the write would be stranger-objective", async () => {
    resetIngressForTests();
    const kv = agreedStore();
    const env = ownerEnv(kv);
    const attempts = [
      pair("stranger-objective", OPEN_RUN_ID),
      pair(OBJECTIVE_ID, "stranger-objective"),
      pair("stranger-objective", "stranger-objective"),
    ];
    for (const body of attempts) {
      const res = await worker.fetch(continueRequest(body), env);
      assert.equal(res.status, 409);
      assert.equal((await res.json()).payment_fail, "not_lifted");
    }
    const empty = memoryKv();
    const bare = await worker.fetch(continueRequest(pair(OBJECTIVE_ID, "stranger-objective")), ownerEnv(empty));
    assert.equal(bare.status, 409);
    assert.equal(empty.puts.length, 0);
    assert.equal(empty.store.has("stranger-objective"), false);
    assert.equal(empty.store.size, 0);
    assert.equal(kv.puts.length, 0);
    assert.equal(kv.store.has("stranger-objective"), false);
    assert.equal(kv.puts.some((put) => put.key === "stranger-objective"), false);
  });
});
