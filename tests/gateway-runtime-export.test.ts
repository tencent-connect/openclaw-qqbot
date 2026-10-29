/**
 * gateway-runtime 导出探测：缺少 createOperatorApprovalsGatewayClient 时必须降级，
 * 不能把半截 ESM 模块当成可用 runtime（否则每 30s TypeError）。
 *
 * 运行：npx tsx tests/gateway-runtime-export.test.ts
 */
import assert from "node:assert";
import { asApprovalGatewayRuntime } from "../src/adapter/gateway.ts";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}: ${err}`);
  }
}

test("null / non-object → null", () => {
  assert.equal(asApprovalGatewayRuntime(null), null);
  assert.equal(asApprovalGatewayRuntime(undefined), null);
  assert.equal(asApprovalGatewayRuntime("nope"), null);
});

test("loaded module without factory → null (stale plugin-sdk)", () => {
  assert.equal(
    asApprovalGatewayRuntime({ GatewayClient: class {}, startGatewayClientWhenEventLoopReady: () => {} }),
    null,
  );
});

test("named export factory → runtime", () => {
  const fn = async () => ({ start() {}, stop() {}, request: async () => null });
  const runtime = asApprovalGatewayRuntime({ createOperatorApprovalsGatewayClient: fn });
  assert.ok(runtime);
  assert.equal(runtime.createOperatorApprovalsGatewayClient, fn);
});

test("default export factory (CJS interop) → runtime", () => {
  const fn = async () => ({ start() {}, stop() {}, request: async () => null });
  const runtime = asApprovalGatewayRuntime({ default: { createOperatorApprovalsGatewayClient: fn } });
  assert.ok(runtime);
  assert.equal(runtime.createOperatorApprovalsGatewayClient, fn);
});

console.log(`passed=${passed} failed=${failed}`);
if (failed) process.exit(1);
console.log("OK");
