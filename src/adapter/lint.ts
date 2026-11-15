/**
 * Lint: 检测 adapter/ 外部直接访问 runtime.channel.* 的代码
 *
 * 运行方式：
 *   npx tsx src/adapter/lint-runtime-access.ts
 *
 * 退出码：
 *   0 = 无违规
 *   1 = 存在未加白的直接 runtime 访问
 *
 * 加白方式（行内注释）：
 *   // @adapter-bypass: <理由>
 *
 * 示例：
 *   const tts = (runtime as any)?.tts; // @adapter-bypass: TTS 非 channel API，无需经过适配层
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ── 配置 ──

const SRC_ROOT = path.resolve(import.meta.dirname, '..');
const ADAPTER_DIR = path.resolve(SRC_ROOT, 'adapter');

/** 匹配直接使用 runtime.channel / runtime.config / (runtime as any) 的模式 */
const VIOLATION_PATTERNS: RegExp[] = [
  /runtime\.channel\b/,
  /runtime\.config\b/,
  /\(runtime\s+as\s+any\)/,
  /channel\??\.(inbound|turn|reply|session|routing|text|media|runtimeContexts)\b/,
  /config\s+as\s*\{.*writeConfigFile/,
];

/** 加白注释标记 */
const BYPASS_MARKER = '@adapter-bypass';

/** 排除的目录/文件 */
const EXCLUDE_DIRS = ['adapter', 'node_modules', 'dist', 'tests'];
const EXCLUDE_FILES = ['types.ts', 'types-augment.d.ts', 'openclaw-plugin-sdk.d.ts'];

// ── 扫描逻辑 ──

interface Violation {
  file: string;
  line: number;
  content: string;
  pattern: string;
}

function shouldExclude(filePath: string): boolean {
  const relative = path.relative(SRC_ROOT, filePath);
  // 排除 adapter 自身
  if (filePath.startsWith(ADAPTER_DIR)) return true;
  // 排除配置的目录
  for (const dir of EXCLUDE_DIRS) {
    if (relative.startsWith(dir + '/') || relative === dir) return true;
  }
  // 排除特定文件
  const fileName = path.basename(filePath);
  if (EXCLUDE_FILES.includes(fileName)) return true;
  return false;
}

function scanFile(filePath: string): Violation[] {
  const violations: Violation[] = [];
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // 跳过注释行（单行注释、JSDoc 行、多行注释体）
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/**') || trimmed.startsWith('*/')) continue;

    // 检查加白标记
    if (line.includes(BYPASS_MARKER)) continue;

    // 检查违规模式
    for (const pattern of VIOLATION_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({
          file: path.relative(SRC_ROOT, filePath),
          line: lineNum,
          content: line.trim(),
          pattern: pattern.source,
        });
        break; // 同一行只报一次
      }
    }
  }

  return violations;
}

function walkDir(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDE_DIRS.includes(entry.name)) {
        results.push(...walkDir(fullPath));
      }
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

// ── 主流程 ──

function main(): void {
  const files = walkDir(SRC_ROOT).filter((f) => !shouldExclude(f));
  const allViolations: Violation[] = [];

  for (const file of files) {
    const violations = scanFile(file);
    allViolations.push(...violations);
  }

  if (allViolations.length === 0) {
    console.log('✅ No direct runtime access found outside adapter/');
    process.exit(0);
  }

  console.error(`❌ Found ${allViolations.length} direct runtime access violation(s):\n`);
  for (const v of allViolations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.content}`);
    console.error(`    → matched: ${v.pattern}`);
    console.error(`    → fix: use adapter or add "// @adapter-bypass: <reason>"\n`);
  }
  console.error(
    `\nTo bypass a specific line, add an inline comment:\n` +
    `  // @adapter-bypass: <reason why this cannot go through the adapter>\n`,
  );
  process.exit(1);
}

main();
