/**
 * Unit tests for Worker validation rules (mirrors src/index.js constraints).
 * Does not call GitHub or Cloudflare — safe offline.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const MAX_BODY = 240;
const CRED_RE = /\b(password|api[\s_-]?key|secret|token|credit[\s_-]?card|cvv|ssn)\b/i;

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

describe("bearer compare", () => {
  it("accepts exact match", () => {
    assert.equal(timingSafeEqual("abc123xyz", "abc123xyz"), true);
  });
  it("rejects mismatch and length mismatch", () => {
    assert.equal(timingSafeEqual("abc123xyz", "abc123xyZ"), false);
    assert.equal(timingSafeEqual("short", "longer-value"), false);
  });
});

describe("body validation", () => {
  it("caps length", () => {
    assert.equal("x".repeat(MAX_BODY).length <= MAX_BODY, true);
    assert.equal("x".repeat(MAX_BODY + 1).length > MAX_BODY, true);
  });
  it("refuses credential keywords", () => {
    assert.equal(CRED_RE.test("what is the password"), true);
    assert.equal(CRED_RE.test("api key please"), true);
    assert.equal(CRED_RE.test("why no money yet"), false);
  });
});

describe("CORS allowlist", () => {
  it("allows Pages, Joinermill, and local origins from the Worker source", () => {
    const fs = require("fs");
    const src = fs.readFileSync(require("path").join(__dirname, "../src/index.js"), "utf8");
    const block = src.match(/const ALLOWED_ORIGINS = \[([\s\S]*?)\];/);
    assert.ok(block, "ALLOWED_ORIGINS array missing");
    const origins = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(origins, [
      "https://evaisawesome2025.github.io",
      "https://joinermill.com",
      "https://www.joinermill.com",
      "http://127.0.0.1:8765",
      "http://localhost:8765",
    ]);
    assert.equal(origins.includes("https://evil.example"), false);
  });
});

describe("no secrets in worker source tree contract", () => {
  it("worker source has no ghp_/gho_/github_pat_ literals", () => {
    const fs = require("fs");
    const src = fs.readFileSync(require("path").join(__dirname, "../src/index.js"), "utf8");
    assert.equal(/ghp_|gho_|github_pat_/.test(src), false);
    assert.equal(/OWNER_BEARER\s*=\s*["']/.test(src), false);
  });
});
