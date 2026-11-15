/**
 * 公共模块：openclaw plugin-sdk symlink 创建逻辑。
 *
 * 被 preload.cjs 和 postinstall-link-sdk.js 共同使用，避免代码重复。
 * 必须是 CJS 格式，因为 preload.cjs 需要同步 require()。
 *
 * 注意：本模块不使用 child_process，避免被 openclaw 安全检查拦截。
 */
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const CLI_NAMES = ["openclaw", "clawdbot", "moltbot"];

/**
 * 比较版本号是否 >= target
 * Strip pre-release suffix (e.g. "2026.3.23-2" → "2026.3.23")
 */
function compareVersionGte(version, target) {
  const parts = version.replace(/-.*$/, "").split(".").map(Number);
  for (let i = 0; i < target.length; i++) {
    const v = parts[i] || 0;
    const t = target[i];
    if (v > t) return true;
    if (v < t) return false;
  }
  return true;
}

/**
 * 获取全局 node_modules 候选目录列表（按优先级排序）。
 * 不依赖 npm/child_process，通过常用路径推导。
 */
function getGlobalNodeModulesDirs() {
  const dirs = [];
  const npmPrefix = process.env.npm_config_prefix || process.env.PREFIX;
  if (npmPrefix) {
    // macOS: prefix/lib/node_modules; Windows: prefix/node_modules
    dirs.push(path.join(npmPrefix, "lib", "node_modules"));
    dirs.push(path.join(npmPrefix, "node_modules"));
  }

  // nvm / fnm / volta 等版本管理器
  // process.execPath = .../versions/node/vX.Y.Z/bin/node
  const execBase = path.dirname(path.dirname(process.execPath));
  dirs.push(path.join(execBase, "lib", "node_modules"));
  dirs.push(path.join(execBase, "node_modules"));

  // Homebrew (macOS Intel)
  dirs.push("/usr/local/lib/node_modules");
  // Homebrew (macOS Apple Silicon)
  dirs.push("/opt/homebrew/lib/node_modules");
  // Linux / macOS 标准路径
  dirs.push("/usr/lib/node_modules");
  // pnpm global (XDG)
  const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  dirs.push(path.join(xdgData, "pnpm", "global", "5", "node_modules"));
  dirs.push(path.join(xdgData, "npm", "lib", "node_modules"));

  return dirs;
}

/**
 * 在全局 node_modules 目录中查找指定包的 package.json。
 */
function findPackageInGlobalDirs(packageName) {
  for (const dir of getGlobalNodeModulesDirs()) {
    const pkgPath = path.join(dir, packageName, "package.json");
    try {
      if (fs.existsSync(pkgPath)) return pkgPath;
    } catch {}
  }
  return null;
}

/**
 * 在 $PATH 中查找 CLI 可执行文件。
 */
function findCliInPath(cliName) {
  const pathEnv = process.env.PATH || "";
  const ext = process.platform === "win32" ? ".cmd" : "";
  const dirs = pathEnv.split(path.delimiter);

  for (const dir of dirs) {
    const binPath = path.join(dir, cliName + ext);
    try {
      if (fs.existsSync(binPath)) return fs.realpathSync(binPath);
    } catch {}
  }
  return null;
}

/**
 * 从 CLI 二进制路径反查全局 node_modules 中的 package.json。
 */
function resolveGlobalRootFromBin(binPath, cliName) {
  // 方式 A: bin -> ../lib/node_modules/<cli>/package.json
  const binDir = path.dirname(binPath);
  const c1 = path.resolve(binDir, "..", "lib", "node_modules", cliName, "package.json");
  try { if (fs.existsSync(c1)) return c1; } catch {}

  // 方式 B: bin -> ../package.json (如果在 node_modules/.bin 下)
  const c2 = path.resolve(binDir, "..", "package.json");
  try {
    if (fs.existsSync(c2)) {
      const parentDir = path.dirname(c2);
      if (fs.existsSync(path.join(parentDir, "plugin-sdk")) || fs.existsSync(path.join(parentDir, "dist", "plugin-sdk"))) {
        return c2;
      }
    }
  } catch {}

  return null;
}

/**
 * 读取 package.json 中的版本号。
 */
function readPkgVersion(pkgPath) {
  try {
    const v = JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version;
    return v || null;
  } catch {
    return null;
  }
}

/**
 * 检查 openclaw 版本是否 >= 2026.3.22（需要 symlink 的最低版本）。
 * 如果无法检测版本，返回 true（保守策略：宁可多创建也不遗漏）。
 */
function isOpenclawVersionRequiresSymlink() {
  const REQUIRED = [2026, 3, 22];

  // Strategy 1: 从全局 node_modules 读取 package.json 版本
  for (const name of CLI_NAMES) {
    const pkgPath = findPackageInGlobalDirs(name);
    if (pkgPath) {
      const v = readPkgVersion(pkgPath);
      if (v) return compareVersionGte(v, REQUIRED);
    }
  }

  // Strategy 2: 从 CLI 二进制反查到 package.json
  for (const name of CLI_NAMES) {
    const binPath = findCliInPath(name);
    if (binPath) {
      const pkgPath = resolveGlobalRootFromBin(binPath, name);
      if (pkgPath) {
        const v = readPkgVersion(pkgPath);
        if (v) return compareVersionGte(v, REQUIRED);
      }
    }
  }

  return true;
}

/**
 * 查找全局 openclaw 安装路径。
 * 三种策略依次尝试：全局 node_modules、$PATH 反查、extensions 目录推断。
 */
function findOpenclawRoot(pluginRoot) {
  // Strategy 1: 从全局 node_modules 查找
  for (const name of CLI_NAMES) {
    const pkgPath = findPackageInGlobalDirs(name);
    if (pkgPath) return path.dirname(pkgPath);
  }

  // Strategy 2: 从 $PATH 反查
  for (const name of CLI_NAMES) {
    const binPath = findCliInPath(name);
    if (binPath) {
      const pkgPath = resolveGlobalRootFromBin(binPath, name);
      if (pkgPath) return path.dirname(pkgPath);
    }
  }

  // Strategy 3: 从 extensions 目录推断
  const extensionsDir = path.dirname(pluginRoot);
  const dataDir = path.dirname(extensionsDir);
  const dataDirName = path.basename(dataDir);
  const cliName = dataDirName.replace(/^\./, "");
  if (cliName) {
    for (const dir of getGlobalNodeModulesDirs()) {
      const pkgPath = path.join(dir, cliName, "package.json");
      try { if (fs.existsSync(pkgPath)) return path.dirname(pkgPath); } catch {}
    }
  }

  return null;
}

/**
 * 验证现有 node_modules/openclaw 是否完整可用。
 *
 * openclaw plugins install 可能安装了不完整的 peerDep 副本
 * （只有 dist/plugin-sdk/index.js，缺少 core.js 等子模块），覆盖了之前的 symlink。
 *
 * 判断标准：
 * - symlink → 只需确认 dist/plugin-sdk 目录存在（target 有完整文件树）
 * - 真实目录 → 必须检查 dist/plugin-sdk/core.js 是否存在
 */
function isLinkValid(linkTarget) {
  try {
    const stat = fs.lstatSync(linkTarget);
    if (stat.isSymbolicLink()) {
      return fs.existsSync(path.join(linkTarget, "dist", "plugin-sdk"))
        || fs.existsSync(path.join(linkTarget, "plugin-sdk"));
    }
    // 真实目录
    return fs.existsSync(path.join(linkTarget, "dist", "plugin-sdk", "core.js"));
  } catch {
    return false;
  }
}

/**
 * 确保 plugin-sdk symlink 存在。
 *
 * @param {string} pluginRoot - 插件根目录路径
 * @param {string} [tag="[link-sdk]"] - 日志前缀
 * @returns {boolean} true 如果 symlink 已存在或成功创建
 */
function ensurePluginSdkSymlink(pluginRoot, tag) {
  tag = tag || "[link-sdk]";
  try {
    if (!pluginRoot.includes("extensions")) return true;

    const linkTarget = path.join(pluginRoot, "node_modules", "openclaw");

    if (fs.existsSync(linkTarget)) {
      if (isLinkValid(linkTarget)) return true;
      // 无效/不完整 → 删除后重建
      try {
        fs.rmSync(linkTarget, { recursive: true, force: true });
        console.log(`${tag} removed incomplete node_modules/openclaw`);
      } catch {}
    }

    if (!isOpenclawVersionRequiresSymlink()) return true;

    const openclawRoot = findOpenclawRoot(pluginRoot);
    if (!openclawRoot) {
      console.error(`${tag} WARNING: could not find openclaw global installation, symlink not created`);
      return false;
    }

    fs.mkdirSync(path.join(pluginRoot, "node_modules"), { recursive: true });
    fs.symlinkSync(openclawRoot, linkTarget, "junction");
    console.log(`${tag} symlink created: node_modules/openclaw -> ${openclawRoot}`);
    return true;
  } catch (e) {
    console.error(`${tag} WARNING: symlink check failed: ${e.message || e}`);
    return false;
  }
}

module.exports = {
  CLI_NAMES,
  compareVersionGte,
  isOpenclawVersionRequiresSymlink,
  findOpenclawRoot,
  isLinkValid,
  ensurePluginSdkSymlink,
};
