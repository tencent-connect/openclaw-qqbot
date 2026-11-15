/**
 * 本地文件路由 — 检测路径并按类型自动选择发送方式
 *
 * 本地文件路径检测 + 文件类型推断。
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import type { MediaKind } from './outbound-service.js';

/**
 * 规范化本地路径
 * - 剥离 file:// 前缀
 * - 展开 ~ 为 home 目录
 * - URL decode
 */
export function normalizePath(p: string): string {
  let result = p;
  if (result.startsWith('file://')) {
    result = result.slice('file://'.length);
    // Windows: file:///C:/path → C:/path
    if (/^\/[a-zA-Z]:[\\/]/.test(result)) {
      result = result.slice(1);
    }
  }
  // URL decode
  try {
    result = decodeURIComponent(result);
  } catch {
    // keep raw if decode fails
  }
  // ~ 展开
  if (result === '~' || result.startsWith('~/') || result.startsWith('~\\')) {
    result = result.replace(/^~/, os.homedir());
  }
  return result;
}

/**
 * 判断一个 source 是否为本地文件路径
 */
export function isLocalFilePath(source: string): boolean {
  if (!source) return false;
  if (source.startsWith('http://') || source.startsWith('https://')) return false;
  if (source.startsWith('data:')) return false;
  if (source.startsWith('file://')) return true;
  if (source === '~' || source.startsWith('~/') || source.startsWith('~\\')) return true;
  if (source.startsWith('/')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(source)) return true;
  if (source.startsWith('\\\\')) return true;
  if (source.startsWith('./') || source.startsWith('../')) return true;
  if (source.startsWith('.\\') || source.startsWith('..\\')) return true;
  return false;
}

/**
 * 判断一个 source 是否为 Base64 data URL
 */
export function isDataUrl(source: string): boolean {
  return source.startsWith('data:');
}

/**
 * 验证本地文件存在且可读
 */
export function validateLocalFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取本地文件大小（字节），不存在返回 -1
 */
export function getFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return -1;
  }
}

// ── 扩展名 → MediaKind 映射 ──

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.ico']);
const VOICE_EXTS = new Set(['.wav', '.mp3', '.silk', '.amr', '.ogg', '.flac', '.aac', '.m4a']);
const VIDEO_EXTS = new Set(['.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv']);

/**
 * 根据文件扩展名推断 MediaKind
 */
export function inferMediaKind(filePath: string): MediaKind {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VOICE_EXTS.has(ext)) return 'voice';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'file';
}

/**
 * 根据 MIME type 推断 MediaKind
 */
export function inferMediaKindFromMime(mime: string): MediaKind {
  const lower = mime.toLowerCase();
  if (lower.startsWith('image/')) return 'image';
  if (lower.startsWith('audio/') || lower === 'voice') return 'voice';
  if (lower.startsWith('video/')) return 'video';
  return 'file';
}

/**
 * 从 data URL 提取 MIME type
 */
export function extractMimeFromDataUrl(dataUrl: string): string | undefined {
  const match = dataUrl.match(/^data:([^;,]+)/);
  return match?.[1];
}

// ── 路径安全校验 ──

/**
 * 校验本地文件真实路径是否在允许的目录列表中。
 * 同时解析符号链接和规范化路径，防止路径穿越。
 *
 * @returns true 表示路径在允许的目录内
 */
export function isPathInAllowedRoots(absPath: string, allowedRoots: string[]): boolean {
  if (!allowedRoots.length) return false;
  try {
    const real = fs.realpathSync(absPath);
    return allowedRoots.some((root) => {
      try {
        const rootReal = fs.existsSync(root) ? fs.realpathSync(root) : root;
        return real.startsWith(rootReal + path.sep) || real === rootReal;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}
