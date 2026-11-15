/**
 * GFM 表格 chunker 单元测试
 *
 * 验证 fallback chunker 不会在 Markdown 表格内部切分。
 * 当 adapters.chunkMarkdownText 不可用时触发此 fallback 路径。
 *
 * 运行方式:  npx tsx tests/chunker-table.test.ts
 */

import assert from "node:assert";

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

// ── 内联 chunker 实现（与 src/channel.ts fallback 保持一致）──

const GFM_TABLE_DATA_RE = /^\|.+\|.*\|/;
const GFM_TABLE_SEP_RE = /^\|[\s:-]+\|/;

function isGfmTableLine(line: string): boolean {
  return GFM_TABLE_DATA_RE.test(line) || GFM_TABLE_SEP_RE.test(line);
}

function chunkText(text: string, limit: number): string[] {
  const lines = text.split('\n');
  const chunks: string[] = [];
  let current = '';
  let tableBuffer: string[] = [];

  const flushTable = () => {
    if (tableBuffer.length === 0) return;
    const tableBlock = tableBuffer.join('\n');
    const candidate = current ? `${current}\n${tableBlock}` : tableBlock;
    if (candidate.length > limit && current) {
      chunks.push(current);
      current = tableBlock;
    } else {
      current = candidate;
    }
    tableBuffer = [];
  };

  for (const line of lines) {
    if (isGfmTableLine(line)) {
      tableBuffer.push(line);
      continue;
    }
    flushTable();
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  flushTable();
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [text];
}

// ── 测试辅助 ──

function eq(name: string, input: string, limit: number, expectedBlocks: number) {
  try {
    const result = chunkText(input, limit);
    assert.strictEqual(result.length, expectedBlocks, `期望 ${expectedBlocks} 个块，实际 ${result.length}`);
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ❌ ${name}`);
    const r = chunkText(input, limit);
    console.log(`     ${e.message}`);
    console.log(`     实际块数=${r.length}`);
    console.log(`     各块长度: ${r.map(c => c.length).join(',')}`);
    failed++;
    failedTests.push(name);
  }
}

function tableSafe(name: string, input: string, limit: number) {
  try {
    const result = chunkText(input, limit);
    // 验证分隔行没有被孤立（至少旁边有数据行）
    for (let i = 0; i < result.length; i++) {
      const chunk = result[i];
      const lines = chunk.split('\n');
      for (let j = 0; j < lines.length; j++) {
        if (GFM_TABLE_SEP_RE.test(lines[j])) {
          const near = lines.slice(Math.max(0, j - 1), j + 2).join(' | ');
          assert.ok(
            j > 0 || lines.length > 1,
            `分隔行不应单独存在 chunk[${i}]: "${chunk.slice(0, 60)}"`,
          );
        }
      }
    }
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
group("1. 表格保持完整（未拆分）");

eq("简单 2x2 表格 + 前后文本", "前文\n| A | B |\n|---|---|\n| 1 | 2 |\n后文", 200, 1);
eq("3列表格不超过 limit", "| 名称 | 价格 | 数量 |\n|------|------|------|\n| 苹果 | 5 | 10 |", 250, 1);

// ======================================================================
group("2. 表格独立成块（前文本超出 limit）");

eq(
  "大段前文 → 表格独立成块",
  "A".repeat(180) + "\n| ID | Name |\n|----|------|\n| 1  | Foo  |",
  150,
  2,
);

eq(
  "表格前后均有大段文本 → 3块",
  "B".repeat(200) + "\n| X | Y |\n|----|----|\n| a  | b  |\n" + "C".repeat(200),
  150,
  3,
);

// ======================================================================
group("3. GFM 分隔行变体");

eq(
  "单破折号 |-|-|",
  "| A | B |\n|-|-|\n| 1 | 2 |",
  100,
  1,
);

eq(
  "对齐冒号 |:---|:---:|",
  "| Left | Center |\n|:-----|:------:|\n| a    | b      |",
  200,
  1,
);

eq(
  "多破折号 |------|------|",
  "| Col1 | Col2 |\n|------|------|\n| v1   | v2   |",
  200,
  1,
);

// ======================================================================
group("4. 多个表格共存");

eq(
  "两个表格独立",
  "| T1 | V1 |\n|----|----|\n| a  | 1  |\n\n中间\n\n| T2 | V2 |\n|----|----|\n| b  | 2  |",
  200,
  1,  // all fits in one chunk
);

eq(
  "两个表格间有大段文字 → 分块",
  "| H1 |\n|----|\n| d1 |\n" + "X".repeat(300) + "\n| H2 |\n|----|\n| d2 |",
  200,
  3,
);

// ======================================================================
group("5. 非表格竖线文本不误判");

{
  const text = "普通 | 文本\n没有表格分隔行";
  try {
    const r = chunkText(text, 50);
    assert.ok(r.join('') === text || r.join('\n') === text, '非表格保持原样');
    console.log("  ✅ 普通竖线文本不误判");
    passed++;
  } catch (e: any) {
    console.log(`  ❌ 普通竖线文本不误判`);
    failed++;
    failedTests.push("普通竖线文本不误判");
  }
}

// ======================================================================
group("6. 表格语义校验（分隔行不孤立）");

tableSafe("表格分隔行有前后数据行", "前文\n| A | B |\n|---|---|\n| 1 | 2 |\n后文", 200);

// ======================================================================
group("7. 边界场景");

eq("纯表格无其他文本", "| H | V |\n|---|---|\n| d | v |", 100, 1);
eq("表格在 limit 内", "开头\n| H | V |\n|---|---|\n| d | v |\n结尾", 100, 1);

// ======================================================================
console.log("\n" + "=".repeat(50));
console.log(`测试结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 个`);
if (failedTests.length > 0) {
  console.log(`\n失败的测试用例:`);
  for (const name of failedTests) console.log(`  - ${name}`);
}
console.log("=".repeat(50));
process.exit(failed > 0 ? 1 : 0);
