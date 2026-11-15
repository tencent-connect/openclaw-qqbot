/**
 * 版本号获取工具。
 *
 * - getPackageVersion(): 插件自身版本（@tencent-connect/openclaw-qqbot）
 * - getOpenclawVersion():  OpenClaw 框架版本降级链
 *
 * 兼容 CJS（tsup bundle）环境，不依赖 require.resolve。
 */

import path from "node:path";
import fs from "node:fs";

/** OpenClaw 框架版本缓存（一次查完不再重复 io） */
let _cachedOpenclawVersion: string | undefined;

declare const __PLUGIN_VERSION__: string;

/**
 * 获取插件自身版本号。
 * 编译时由 tsup define 注入，零运行时 IO。
 */
export function getPackageVersion(): string {
  return typeof __PLUGIN_VERSION__ !== 'undefined' ? __PLUGIN_VERSION__ : 'unknown';
}

// ── OpenClaw 框架版本 ──

/**
 * OpenClaw 框架版本降级链（优先后）。
 *   1. PluginRuntime.version（3.31+，非 "unknown"）
 *   2. OPENCLAW_VERSION / OPENCLAW_SERVICE_VERSION 环境变量
 *   3. 文件系统搜索 openclaw/package.json
 *   4. 兜底 "unknown"
 */
export function getOpenclawVersion(runtimeVersion?: string): string {
  if (_cachedOpenclawVersion) return _cachedOpenclawVersion;

  // 1. runtime.version（排除兜底值）
  if (runtimeVersion && runtimeVersion !== "unknown") {
    return _cachedOpenclawVersion = runtimeVersion;
  }
  // 2. 环境变量
  if (process.env.OPENCLAW_VERSION) {
    return _cachedOpenclawVersion = process.env.OPENCLAW_VERSION;
  }
  if (process.env.OPENCLAW_SERVICE_VERSION) {
    return _cachedOpenclawVersion = process.env.OPENCLAW_SERVICE_VERSION;
  }
  // 3. 文件系统
  const pkgVer = readOpenclawPackageVersion();
  if (pkgVer) return _cachedOpenclawVersion = pkgVer;

  return "unknown";
}

function readOpenclawPackageVersion(): string | undefined {
  try {
    const dirs = searchRoots();
    for (const dir of dirs) {
      const pkgPath = path.join(dir, "package.json");
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
        if (pkg.name === "openclaw" && pkg.version) return pkg.version;
      } catch { /* next */ }
    }
  } catch { /* fallthrough */ }
  return undefined;
}

function searchRoots(): string[] {
  const roots: string[] = [];

  // 从插件自身路径向上查找
  if (typeof __filename === "string") {
    let dir = path.dirname(__filename);
    for (let i = 0; i < 10; i++) {
      roots.push(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // STATE_DIR 指向的 openclaw 安装目录附近
  for (const key of ["OPENCLAW_STATE_DIR", "CLAWDBOT_STATE_DIR", "MOLTBOT_STATE_DIR"]) {
    const v = process.env[key];
    if (v) {
      roots.push(path.dirname(v));
      roots.push(path.resolve(v, ".."));
    }
  }

  // 常见安装路径
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  for (const name of ["openclaw", "clawdbot", "moltbot"]) {
    roots.push(path.join(home, `.${name}`));
  }
  roots.push(process.cwd());

  return [...new Set(roots.filter((r) => typeof r === "string" && r.length > 0))];
}
