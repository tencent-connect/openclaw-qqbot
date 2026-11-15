/**
 * 远程媒体下载（动态加载 plugin-sdk/media-runtime，降级到 fetch）
 *
 * 新版本 openclaw 有 openclaw/plugin-sdk/media-runtime（含 SSRF 防护/重试/大小限制），
 * 旧版本不可用时降级到原生 fetch 直连。
 */
import { createRequire } from 'node:module';
import * as dns from 'node:dns';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { getQQBotMediaDir } from '../utils/platform.js';

const req = createRequire(__filename);

type SaveRemoteMedia = (opts: {
  url: string;
  subdir?: string;
  originalFilename?: string;
  maxBytes?: number;
  timeoutMs?: number;
}) => Promise<{ path: string }>;

let _save: SaveRemoteMedia | null | undefined;

export function downloadRemoteMedia(opts: {
  url: string;
  subdir?: string;
  originalFilename?: string;
  maxBytes?: number;
  timeoutMs?: number;
}): Promise<{ path: string }> {
  if (_save === undefined) {
    try {
      const mod = req('openclaw/plugin-sdk/media-runtime') as { saveRemoteMedia: SaveRemoteMedia };
      _save = mod.saveRemoteMedia;
    } catch {
      _save = null;
    }
  }
  return _save ? _save(opts) : downloadViaFetch(opts);
}

// ── SSRF 防护 ──

const PRIVATE_RANGES: Array<[netmask: bigint, prefix: number]> = [
  [0x0A000000n, 8],      // 10.0.0.0/8
  [0xAC100000n, 12],     // 172.16.0.0/12
  [0xC0A80000n, 16],     // 192.168.0.0/16
  [0x7F000000n, 8],      // 127.0.0.0/8
  [0xA9FE0000n, 16],     // 169.254.0.0/16
  [0xE0000000n, 4],      // 224.0.0.0/4 (multicast)
];

function ipToBigInt(ip: string): bigint {
  return ip.split('.').reduce((acc, octet) => (acc << 8n) | BigInt(Number(octet)), 0n);
}

function isPrivateIP(ip: string): boolean {
  const val = ipToBigInt(ip);
  return PRIVATE_RANGES.some(([mask, prefix]) => (val >> (32n - BigInt(prefix))) === (mask >> (32n - BigInt(prefix))));
}

async function assertSafeHostname(hostname: string): Promise<void> {
  const addresses = await dns.promises.resolve4(hostname).catch(() => []);
  if (addresses.length === 0) throw new Error(`DNS resolution failed: ${hostname}`);
  for (const addr of addresses) {
    if (isPrivateIP(addr)) {
      throw new Error(`SSRF blocked: ${hostname} resolves to private IP ${addr}`);
    }
  }
}

// ── 降级 fetch ──

/** 降级：原生 fetch 直连（含 SSRF 防护、大小限制） */
async function downloadViaFetch(opts: {
  url: string;
  subdir?: string;
  originalFilename?: string;
  maxBytes?: number;
  timeoutMs?: number;
}): Promise<{ path: string }> {
  const parsed = new URL(opts.url);
  if (parsed.protocol !== 'https:') {
    throw new Error(`Only HTTPS allowed: ${parsed.protocol}`);
  }
  await assertSafeHostname(parsed.hostname);

  const dir = getQQBotMediaDir(opts.subdir ?? 'downloads');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const resp = await fetch(opts.url, {
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  if (!resp.ok) throw new Error(`Download HTTP ${resp.status}`);

  const maxBytes = opts.maxBytes ?? 500 * 1024 * 1024;
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`Download exceeds ${(maxBytes / 1024 / 1024).toFixed(0)}MB`);

  const ext = opts.originalFilename
    ? path.extname(opts.originalFilename) || '.bin'
    : '.bin';
  const name = opts.originalFilename
    ? path.basename(opts.originalFilename, path.extname(opts.originalFilename))
    : 'download';
  const rand = crypto.randomBytes(4).toString('hex');
  const filePath = path.join(dir, `${name}_${Date.now()}_${rand}${ext}`);
  fs.writeFileSync(filePath, buf);
  return { path: filePath };
}
