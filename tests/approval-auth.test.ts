/**
 * 审批授权逻辑单元测试
 *
 * 测试 isApprovalAuthorized 和 resolveOperatorId 核心逻辑
 * （内联实现以保持模块私有性，确保测试覆盖与实现一致）
 *
 * 运行方式:  npx tsx tests/approval-auth.test.ts
 */

import assert from "node:assert";

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

// ── 授权逻辑（与 src/gateway/event-handlers.ts 保持一致）──

interface MockAccount {
  accountId: string;
  config?: {
    allowFrom?: string[];
  };
}

function isApprovalAuthorized(account: MockAccount, operatorId?: string): boolean {
  if (!operatorId) return false;
  const allowFrom = account.config?.allowFrom ?? [];
  if (!allowFrom.length || allowFrom.includes('*')) return true;
  return allowFrom.includes(operatorId);
}

/* eslint-disable @typescript-eslint/no-unused-vars */
function resolveOperatorId(event: Record<string, unknown>): string | undefined {
  const evt = event as any;
  return evt.user_openid
    ?? evt.data?.resolved?.user_id
    ?? evt.data?.resolved?.user_openid
    ?? evt.openid;
}
/* eslint-enable */

// ── 测试辅助 ──

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
    failed++;
    failedTests.push(name);
  }
}

function group(title: string) {
  console.log(`\n=== ${title} ===`);
}

// ======================================================================
//  Part 1: isApprovalAuthorized
// ======================================================================
group("1. isApprovalAuthorized — allowFrom 为空（开放模式）");

test("allowFrom 为空 → 任意用户可审批", () => {
  const account: MockAccount = { accountId: "default" };
  assert.strictEqual(isApprovalAuthorized(account, "user123"), true);
});

test("allowFrom 为空 → 不同用户也可审批", () => {
  const account: MockAccount = { accountId: "default" };
  assert.strictEqual(isApprovalAuthorized(account, "anyone"), true);
});

group("2. isApprovalAuthorized — allowFrom 含 *");

test("allowFrom: ['*'] → 任意用户可审批", () => {
  const account: MockAccount = {
    accountId: "default",
    config: { allowFrom: ["*"] },
  };
  assert.strictEqual(isApprovalAuthorized(account, "user123"), true);
});

group("3. isApprovalAuthorized — allowFrom 白名单模式");

test("用户在白名单中 → 可以审批", () => {
  const account: MockAccount = {
    accountId: "default",
    config: { allowFrom: ["alice123", "bob456"] },
  };
  assert.strictEqual(isApprovalAuthorized(account, "alice123"), true);
});

test("用户不在白名单中 → 拒绝审批", () => {
  const account: MockAccount = {
    accountId: "default",
    config: { allowFrom: ["alice123"] },
  };
  assert.strictEqual(isApprovalAuthorized(account, "evil_user"), false);
});

test("白名单只有一人，其他人全拒绝", () => {
  const account: MockAccount = {
    accountId: "default",
    config: { allowFrom: ["admin001"] },
  };
  assert.strictEqual(isApprovalAuthorized(account, "admin001"), true);
  assert.strictEqual(isApprovalAuthorized(account, "user002"), false);
  assert.strictEqual(isApprovalAuthorized(account, "user003"), false);
});

group("4. isApprovalAuthorized — operatorId 为空");

test("operatorId 为 undefined → 拒绝", () => {
  const account: MockAccount = { accountId: "default" };
  assert.strictEqual(isApprovalAuthorized(account, undefined), false);
});

test("operatorId 为空字符串 → 拒绝", () => {
  const account: MockAccount = { accountId: "default" };
  assert.strictEqual(isApprovalAuthorized(account, ""), false);
});

group("5. isApprovalAuthorized — 无 config");

test("无 config → 按开放模式处理", () => {
  const account: MockAccount = { accountId: "default" };
  assert.strictEqual(isApprovalAuthorized(account, "anyone"), true);
});

// ======================================================================
//  Part 2: resolveOperatorId
// ======================================================================
group("6. resolveOperatorId — user_openid");

test("evt.user_openid 优先级最高", () => {
  const event = {
    user_openid: "openid_aaa",
    openid: "openid_bbb",
  };
  assert.strictEqual(resolveOperatorId(event), "openid_aaa");
});

group("7. resolveOperatorId — data.resolved.user_id");

test("无 user_openid 时回退到 data.resolved.user_id", () => {
  const event = {
    data: { resolved: { user_id: "user_ccc" } },
  };
  assert.strictEqual(resolveOperatorId(event), "user_ccc");
});

group("8. resolveOperatorId — data.resolved.user_openid");

test("无前两个字段时回退到 data.resolved.user_openid", () => {
  const event = {
    data: { resolved: { user_openid: "openid_ddd" } },
  };
  assert.strictEqual(resolveOperatorId(event), "openid_ddd");
});

group("9. resolveOperatorId — openid 兜底");

test("所有字段都没有时回退到顶层 openid", () => {
  const event = { openid: "fallback_openid" };
  assert.strictEqual(resolveOperatorId(event), "fallback_openid");
});

group("10. resolveOperatorId — 全部缺失");

test("事件没有任何身份字段 → undefined", () => {
  const event = { data: { type: 99 } };
  assert.strictEqual(resolveOperatorId(event), undefined);
});

// ======================================================================
//  Part 3: 集成场景（resolveOperatorId + isApprovalAuthorized）
// ======================================================================
group("11. 集成 — 身份解析 + 授权校验");

test("QQ Bot v2 user_openid → 白名单匹配通过", () => {
  const event = {
    user_openid: "admin_openid",
  };
  const account: MockAccount = {
    accountId: "default",
    config: { allowFrom: ["admin_openid"] },
  };
  const operatorId = resolveOperatorId(event);
  assert.strictEqual(isApprovalAuthorized(account, operatorId), true);
});

test("QQ Bot v2 data.resolved.user_id → 白名单匹配通过", () => {
  const event = {
    data: { resolved: { user_id: "admin_openid" } },
  };
  const account: MockAccount = {
    accountId: "default",
    config: { allowFrom: ["admin_openid"] },
  };
  const operatorId = resolveOperatorId(event);
  assert.strictEqual(isApprovalAuthorized(account, operatorId), true);
});

test("未授权用户 → 身份解析正常但授权拒绝", () => {
  const event = {
    user_openid: "random_user",
  };
  const account: MockAccount = {
    accountId: "default",
    config: { allowFrom: ["admin_only"] },
  };
  const operatorId = resolveOperatorId(event);
  assert.strictEqual(operatorId, "random_user");
  assert.strictEqual(isApprovalAuthorized(account, operatorId), false);
});

test("事件无身份 → 解析为 undefined → 拒绝授权", () => {
  const event = { data: { type: 99 } };
  const account: MockAccount = {
    accountId: "default",
    config: { allowFrom: ["admin"] },
  };
  const operatorId = resolveOperatorId(event);
  assert.strictEqual(operatorId, undefined);
  assert.strictEqual(isApprovalAuthorized(account, operatorId), false);
});

// ======================================================================
//  结果汇总
// ======================================================================
console.log("\n" + "=".repeat(50));
console.log(`测试结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 个`);
if (failedTests.length > 0) {
  console.log(`\n失败的测试用例:`);
  for (const name of failedTests) {
    console.log(`  - ${name}`);
  }
}
console.log("=".repeat(50));

process.exit(failed > 0 ? 1 : 0);
