/**
 * Unit tests for the approval delivery target parser (resolveTarget).
 *
 * Covers resolveTarget exported from src/features/approval-utils.ts — the very
 * implementation shipped in approval-handler.ts is imported here, so these
 * tests exercise the production code path, not a copy of it.
 *
 * Run:  npx tsx tests/approval-target.test.ts
 */

import assert from "node:assert";
import { resolveTarget } from "../src/features/approval-utils.js";

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

// ── Test helpers ──

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  OK ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  FAIL ${name}`);
    console.log(`     ${e.message}`);
    failed++;
    failedTests.push(name);
  }
}

function group(title: string) {
  console.log(`\n=== ${title} ===`);
}

const OPENID = "387CFB340004F7E30E238109D80C81F1";
const GROUP_ID = "A1B2C3D4E5F60718293A4B5C6D7E8F90";

// ======================================================================
//  Part 1: sessionKey carries an explicit qqbot target (pre-existing
//  behavior — must not regress)
// ======================================================================

group("1. sessionKey with explicit qqbot target - existing behavior preserved");

test("qqbot:c2c:OPENID -> c2c target", () => {
  assert.deepStrictEqual(
    resolveTarget(`agent:main:qqbot:c2c:${OPENID}`, null),
    { type: "c2c", id: OPENID }
  );
});

test("qqbot:direct:OPENID -> c2c target (direct folds into c2c)", () => {
  assert.deepStrictEqual(
    resolveTarget(`agent:main:qqbot:direct:${OPENID}`, null),
    { type: "c2c", id: OPENID }
  );
});

test("qqbot:group:ID -> group target", () => {
  assert.deepStrictEqual(
    resolveTarget(`agent:main:qqbot:group:${GROUP_ID}`, null),
    { type: "group", id: GROUP_ID }
  );
});

test("decimal group id (real QQ group numbers) -> group target", () => {
  assert.deepStrictEqual(
    resolveTarget("agent:main:qqbot:group:123456789", null),
    { type: "group", id: "123456789" }
  );
});

test("sessionKey wins when both fields are parseable", () => {
  assert.deepStrictEqual(
    resolveTarget(`agent:main:qqbot:group:${GROUP_ID}`, `qqbot:c2c:${OPENID}`),
    { type: "group", id: GROUP_ID }
  );
});

// ======================================================================
//  Part 2: sessionKey has no channel info - fall back to turnSourceTo
//  (the core of this fix)
// ======================================================================

group("2. sessionKey without channel info - falls back to turnSourceTo");

test("sessionKey=agent:main:main + turnSourceTo=qqbot:c2c -> fallback works", () => {
  assert.deepStrictEqual(
    resolveTarget("agent:main:main", `qqbot:c2c:${OPENID}`),
    { type: "c2c", id: OPENID }
  );
});

test("sessionKey=cron run key (real-world shape) -> fallback works", () => {
  assert.deepStrictEqual(
    resolveTarget(
      "agent:main:cron:49b8daa8-3758-4194-acb6-2cb5ff070462:run:845255d6-bfce-46fe-90a4-cf5159f9caae",
      `qqbot:c2c:${OPENID}`
    ),
    { type: "c2c", id: OPENID }
  );
});

test("sessionKey unparseable + turnSourceTo=qqbot:group -> group target", () => {
  assert.deepStrictEqual(
    resolveTarget("agent:main:main", `qqbot:group:${GROUP_ID}`),
    { type: "group", id: GROUP_ID }
  );
});

// ======================================================================
//  Part 3: no target in either field - must return null
//  (never guess a delivery target)
// ======================================================================

group("3. no target in either field - returns null");

test("both fields empty -> null", () => {
  assert.strictEqual(resolveTarget(null, null), null);
  assert.strictEqual(resolveTarget(undefined, undefined), null);
  assert.strictEqual(resolveTarget("", ""), null);
});

test("sessionKey without channel info + turnSourceTo empty -> null", () => {
  assert.strictEqual(resolveTarget("agent:main:main", null), null);
});

test("neither field contains a qqbot segment -> null", () => {
  assert.strictEqual(
    resolveTarget("agent:main:cron:abc:run:def", "cron:abc"),
    null
  );
});

test("turnSourceTo has qqbot: but an illegal openid -> null", () => {
  assert.strictEqual(resolveTarget("agent:main:main", "qqbot:c2c:not-hex!"), null);
});

// ======================================================================
//  Part 4: case sensitivity and edge cases
// ======================================================================

group("4. case sensitivity and edge cases");

test("lowercase openid also matches (regex /i)", () => {
  assert.deepStrictEqual(
    resolveTarget("agent:main:main", `qqbot:c2c:${OPENID.toLowerCase()}`),
    { type: "c2c", id: OPENID.toLowerCase() }
  );
});

test("target embedded in a longer turnSourceTo string is still extracted", () => {
  assert.deepStrictEqual(
    resolveTarget("agent:main:main", `prefix:qqbot:c2c:${OPENID}:suffix`),
    { type: "c2c", id: OPENID }
  );
});

// ── Summary ──

console.log(`\n${"=".repeat(50)}`);
console.log(`Result: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`Failed: ${failedTests.join(", ")}`);
  process.exit(1);
}
