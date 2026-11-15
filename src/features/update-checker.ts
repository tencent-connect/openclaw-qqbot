/**
 * 版本检查器
 *
 * - triggerUpdateCheck(): gateway 启动时调用，后台预热缓存
 * - getUpdateInfo(): 每次实时查询 npm registry，返回最新结果
 *
 * 使用 HTTPS 直接请求 npm registry API（不依赖 npm CLI），
 * 支持多 registry fallback：npmjs.org → npmmirror.com，解决国内网络问题。
 */

import https from "node:https";
import { getPackageVersion } from "../utils/pkg-version.js";
import type { PluginLogger } from '../utils/plugin-logger.js';

const PKG_NAME = "@tencent-connect/openclaw-qqbot";
const ENCODED_PKG = encodeURIComponent(PKG_NAME);

const REGISTRIES = [
  `https://registry.npmjs.org/${ENCODED_PKG}`,
  `https://registry.npmmirror.com/${ENCODED_PKG}`,
];

let CURRENT_VERSION = getPackageVersion();

export interface UpdateInfo {
  current: string;
  latest: string | null;
  stable: string | null;
  alpha: string | null;
  hasUpdate: boolean;
  checkedAt: number;
  error?: string;
}

function fetchJson(url: string, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs, headers: { Accept: "application/json" } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }
      let data = "";
      res.on("data", (chunk: string) => { data += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error(`timeout fetching ${url}`)); });
  });
}

async function fetchDistTags(log?: PluginLogger): Promise<Record<string, string>> {
  for (const url of REGISTRIES) {
    try {
      const json = await fetchJson(url, 10_000);
      const tags = json["dist-tags"];
      if (tags && typeof tags === "object") return tags;
    } catch (e: any) {
      log?.debug(`[update-checker] ${url} failed: ${e.message}`);
    }
  }
  throw new Error("all registries failed");
}

function buildUpdateInfo(tags: Record<string, string>): UpdateInfo {
  const currentIsPrerelease = CURRENT_VERSION.includes("-");
  const stableTag = tags.latest || null;
  const alphaTag = tags.alpha || null;

  const compareTarget = currentIsPrerelease ? alphaTag : stableTag;

  const hasUpdate = typeof compareTarget === "string"
    && compareTarget !== CURRENT_VERSION
    && compareVersions(compareTarget, CURRENT_VERSION) > 0;

  return {
    current: CURRENT_VERSION,
    latest: compareTarget,
    stable: stableTag,
    alpha: alphaTag,
    hasUpdate,
    checkedAt: Date.now(),
  };
}

/**
 * Gateway 启动时调用，后台预热版本缓存。
 * log 通过闭包传递，避免模块级可变状态。
 */
export function triggerUpdateCheck(log: PluginLogger): void {
  getUpdateInfo(log).then((info) => {
    if (info.hasUpdate) {
      log.info(`[update-checker] new version available: ${info.latest} (current: ${CURRENT_VERSION})`);
    }
  }).catch(() => {});
}

/** 每次实时查询 npm registry */
export async function getUpdateInfo(log?: PluginLogger): Promise<UpdateInfo> {
  try {
    const tags = await fetchDistTags(log);
    return buildUpdateInfo(tags);
  } catch (err: any) {
    log?.debug(`[update-checker] check failed: ${err.message}`);
    return { current: CURRENT_VERSION, latest: null, stable: null, alpha: null, hasUpdate: false, checkedAt: Date.now(), error: err.message };
  }
}

/**
 * 检查指定版本是否存在于 npm registry
 */
export async function checkVersionExists(version: string, pkgName?: string): Promise<boolean> {
  const registries = pkgName ? buildRegistries(pkgName) : REGISTRIES;
  for (const baseUrl of registries) {
    try {
      const url = `${baseUrl}/${version}`;
      const json = await fetchJson(url, 10_000);
      if (json && json.version === version) return true;
    } catch {
      // try next registry
    }
  }
  return false;
}

function buildRegistries(pkgName: string): string[] {
  const encoded = encodeURIComponent(pkgName);
  return [
    `https://registry.npmjs.org/${encoded}`,
    `https://registry.npmmirror.com/${encoded}`,
  ];
}

function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const clean = v.replace(/^v/, "");
    const [main, pre] = clean.split("-", 2);
    return { parts: main.split(".").map(Number), pre: pre || null };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa.parts[i] || 0) - (pb.parts[i] || 0);
    if (diff !== 0) return diff;
  }
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && !pb.pre) return 0;
  const aParts = pa.pre!.split(".");
  const bParts = pb.pre!.split(".");
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aP = aParts[i] ?? "";
    const bP = bParts[i] ?? "";
    const aNum = Number(aP);
    const bNum = Number(bP);
    if (!isNaN(aNum) && !isNaN(bNum)) {
      if (aNum !== bNum) return aNum - bNum;
    } else {
      if (aP < bP) return -1;
      if (aP > bP) return 1;
    }
  }
  return 0;
}
