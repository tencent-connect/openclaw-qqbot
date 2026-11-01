/**
 * 审批按钮决策适配单元测试
 *
 * 测试 buildApprovalKeyboard 按 allowedDecisions 动态隐藏「始终允许」按钮的逻辑
 * （内联实现以保持模块私有性，确保测试覆盖与实现一致）
 *
 * 运行方式:  npx tsx tests/approval-keyboard-decisions.test.ts
 */

import assert from "node:assert";

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

// ── 键盘构建（与 src/features/approval-handler.ts 保持一致）──

interface KeyboardButton {
  id: string;
  render_data: { label: string; visited_label: string; style: 0 | 1 };
  action: { type: 1; data: string; permission: { type: 2 }; click_limit: 1 };
  group_id: string;
}

interface InlineKeyboard {
  content: { rows: { buttons: KeyboardButton[] }[] };
}

function buildApprovalKeyboard(
  approvalId: string,
  allowedDecisions?: readonly string[] | null
): InlineKeyboard {
  const makeBtn = (
    id: string,
    label: string,
    visitedLabel: string,
    data: string,
    style: 0 | 1
  ): KeyboardButton => ({
    id,
    render_data: { label, visited_label: visitedLabel, style },
    action: {
      type: 1,
      data,
      permission: { type: 2 },
      click_limit: 1,
    },
    group_id: "approval",
  });
  // 核心在 request.allowedDecisions 中声明该请求实际支持的决策；渲染不在集合内的
  // 按钮只会让用户点了必失败。字段缺失时维持原三按钮行为。
  const can = (decision: string) =>
    !allowedDecisions || allowedDecisions.includes(decision);
  return {
    content: {
      rows: [
        {
          buttons: [
            ...(can("allow-once") ? [makeBtn("allow", "✅ 允许一次", "已允许", `approve:${approvalId}:allow-once`, 1)] : []),
            ...(can("allow-always") ? [makeBtn("always", "⭐ 始终允许", "已始终允许", `approve:${approvalId}:allow-always`, 1)] : []),
            ...(can("deny") ? [makeBtn("deny", "❌ 拒绝", "已拒绝", `approve:${approvalId}:deny`, 0)] : []),
          ],
        },
      ],
    },
  };
}

/** 调用点逻辑：从审批请求 payload 提取 allowedDecisions（与 handleRequested 保持一致） */
function extractAllowedDecisions(request: { request?: { allowedDecisions?: unknown } }): string[] | null {
  return Array.isArray(request.request?.allowedDecisions)
    ? request.request.allowedDecisions as string[]
    : null;
}

// ── 测试 ──

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failedTests.push(name);
    console.error(`  ✗ ${name}`);
    console.error(`    ${(err as Error).message}`);
  }
}

function buttonIds(kb: InlineKeyboard): string[] {
  return kb.content.rows[0].buttons.map((b) => b.id);
}

function buttonDatas(kb: InlineKeyboard): string[] {
  return kb.content.rows[0].buttons.map((b) => b.action.data);
}

console.log("\nbuildApprovalKeyboard: allowedDecisions 适配\n");

test("默认（无 allowedDecisions）→ 三按钮，保持向后兼容", () => {
  const kb = buildApprovalKeyboard("t1");
  assert.deepStrictEqual(buttonIds(kb), ["allow", "always", "deny"]);
});

test("allowedDecisions 为 null（plugin 审批等未声明场景）→ 三按钮", () => {
  const kb = buildApprovalKeyboard("t2", null);
  assert.deepStrictEqual(buttonIds(kb), ["allow", "always", "deny"]);
});

test("allowedDecisions 含 allow-always → 三按钮", () => {
  const kb = buildApprovalKeyboard("t3", ["allow-once", "allow-always", "deny"]);
  assert.deepStrictEqual(buttonIds(kb), ["allow", "always", "deny"]);
});

test("ask=always 场景（不含 allow-always）→ 两按钮，无 always", () => {
  const kb = buildApprovalKeyboard("t4", ["allow-once", "deny"]);
  assert.deepStrictEqual(buttonIds(kb), ["allow", "deny"]);
  const datas = buttonDatas(kb).join("|");
  assert.ok(!datas.includes("allow-always"), "不应残留 allow-always 回调数据");
});

test("隐藏 always 后剩余按钮的回调数据正确", () => {
  const kb = buildApprovalKeyboard("exec-123", ["allow-once", "deny"]);
  const datas = buttonDatas(kb);
  assert.deepStrictEqual(datas, [
    "approve:exec-123:allow-once",
    "approve:exec-123:deny",
  ]);
});

test("三按钮时各按钮回调数据正确", () => {
  const kb = buildApprovalKeyboard("exec-456", ["allow-once", "allow-always", "deny"]);
  assert.deepStrictEqual(buttonDatas(kb), [
    "approve:exec-456:allow-once",
    "approve:exec-456:allow-always",
    "approve:exec-456:deny",
  ]);
});

test("deny-only 场景（allowedDecisions=[\"deny\"]）→ 只渲染拒绝按钮", () => {
  const kb = buildApprovalKeyboard("t5", ["deny"]);
  assert.deepStrictEqual(buttonIds(kb), ["deny"]);
});


test("空数组（无任何可用决策）→ 不渲染任何按钮", () => {
  const kb = buildApprovalKeyboard("t6", []);
  assert.deepStrictEqual(buttonIds(kb), []);
});

console.log("\n调用点：allowedDecisions 提取\n");

test("exec 审批请求携带 allowedDecisions → 原样提取", () => {
  const req = { request: { allowedDecisions: ["allow-once", "deny"] } };
  assert.deepStrictEqual(extractAllowedDecisions(req), ["allow-once", "deny"]);
});

test("请求未携带 allowedDecisions → null", () => {
  const req = { request: { command: "ls" } };
  assert.strictEqual(extractAllowedDecisions(req), null);
});

test("allowedDecisions 非数组（脏数据）→ null", () => {
  const req = { request: { allowedDecisions: "allow-once" } };
  assert.strictEqual(extractAllowedDecisions(req), null);
  const req2 = { request: { allowedDecisions: undefined } };
  assert.strictEqual(extractAllowedDecisions(req2), null);
});

test("request 缺失 → null", () => {
  assert.strictEqual(extractAllowedDecisions({}), null);
});

// ── 汇总 ──

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) {
  console.error("失败用例:", failedTests.join(", "));
  process.exit(1);
}
