/**
 * 插件预加载入口（CJS 格式）。
 *
 * openclaw 框架通过 require() 加载插件，因此需要 .cjs 后缀
 * 确保在 "type": "module" 的 package 中也能被正确 require()。
 *
 * 在 require 真正的插件代码（依赖 openclaw/plugin-sdk）之前，
 * 先同步确保 node_modules/openclaw symlink 存在。
 */
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { ensurePluginSdkSymlink } = require("./scripts/link-sdk-core.cjs");

// 1) 同步创建 symlink（确保 openclaw/plugin-sdk 可解析）
ensurePluginSdkSymlink(__dirname, "[preload]");

// 2) 加载编译产物（向后兼容：优先 .cjs，fallback .js）
const cjsPath = path.join(__dirname, "dist", "index.cjs");
const jsPath = path.join(__dirname, "dist", "index.js");

if (fs.existsSync(cjsPath)) {
  module.exports = require(cjsPath);
} else {
  // 兼容旧版 tsc 编译产物（ESM .js），需展平 default export
  const _mod = require(jsPath);
  const _default = _mod.default;
  const merged = Object.assign({}, _mod);
  if (_default && typeof _default === "object") {
    for (const key of Object.keys(_default)) {
      if (!(key in merged)) merged[key] = _default[key];
    }
  }
  module.exports = merged;
}
