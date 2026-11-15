/**
 * Markdown 图片尺寸探测
 *
 * 发送前探测图片宽高，格式化为 `![img #WxH](url)` 格式。
 * QQ 客户端 Markdown 渲染时需要这个尺寸提示来优化图片显示比例。
 */

import { validateRemoteUrl } from '../utils/ssrf-guard.js';

/** 图片尺寸结果 */
export interface ImageSize {
  width: number;
  height: number;
}

/**
 * 通过 HTTP Range 请求前 N 字节解析图片尺寸
 *
 * 支持 PNG / JPEG / GIF / WebP 格式的快速头部探测（不下载完整图片）。
 * 内置 SSRF 防护：fetch 前先校验 URL 安全性。
 */
export async function getImageSize(url: string, timeoutMs = 5000): Promise<ImageSize | null> {
  try {
    // SSRF 防护：禁止访问内网 / 云元数据端点
    await validateRemoteUrl(url);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { Range: 'bytes=0-32767' }, // 请求前 32KB 足够解析头
    });
    clearTimeout(timer);

    if (!resp.ok && resp.status !== 206) return null;

    const buffer = Buffer.from(await resp.arrayBuffer());
    return parseImageDimensions(buffer);
  } catch {
    return null;
  }
}

/**
 * 从 buffer 头部解析图片尺寸
 */
function parseImageDimensions(buffer: Buffer): ImageSize | null {
  if (buffer.length < 8) return null;

  // PNG: 前 8 字节签名 + IHDR chunk (offset 16: width BE uint32, offset 20: height BE uint32)
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    if (buffer.length >= 24) {
      return {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20),
      };
    }
  }

  // JPEG: 搜索 SOFn marker (0xFF 0xC0-0xCF, 除 0xC4/0xC8/0xCC)
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length - 9) {
      if (buffer[offset] !== 0xff) { offset++; continue; }
      const marker = buffer[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      const segLen = buffer.readUInt16BE(offset + 2);
      offset += 2 + segLen;
    }
  }

  // GIF: offset 6: width LE uint16, offset 8: height LE uint16
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    if (buffer.length >= 10) {
      return {
        width: buffer.readUInt16LE(6),
        height: buffer.readUInt16LE(8),
      };
    }
  }

  // WebP: RIFF header + "WEBP" + VP8 chunks
  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8 ' && buffer.length >= 30) {
      // Lossy VP8: offset 26-27 width (LE) & offset 28-29 height (LE), masked lower 14 bits
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunk === 'VP8L' && buffer.length >= 25) {
      // Lossless VP8L: 5 bytes at offset 21, first 14 bits = width-1, next 14 bits = height-1
      const bits = buffer.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
  }

  return null;
}

/**
 * 格式化 QQ Markdown 图片标签（带尺寸提示）
 *
 * @example
 * formatQQMarkdownImage('https://x/img.png', { width: 800, height: 600 })
 * // → '![img #800x600](https://x/img.png)'
 */
export function formatQQMarkdownImage(url: string, size?: ImageSize | null): string {
  if (size) {
    return `![img #${size.width}x${size.height}](${url})`;
  }
  return `![img](${url})`;
}
