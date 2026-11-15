/**
 * 远程 URL 安全校验
 *
 * 下载外部资源前，确保目标地址不会命中内部网络或云元数据端点，
 * 避免模型输出的恶意链接触达内网服务。
 */

import net from "node:net";
import dns from "node:dns/promises";

/* ---------- 内网 / 保留地址判定 ---------- */

/** IPv4 保留网段前缀（覆盖 RFC 1918、链路本地、回环等） */
const RESERVED_V4_PREFIXES = [
  "127.",       // loopback
  "10.",        // class-A private
  "192.168.",   // class-C private
  "169.254.",   // link-local / cloud metadata
] as const;

/** 172.16.0.0 – 172.31.255.255 需要单独用正则匹配 */
const PRIVATE_172_RE = /^172\.(1[6-9]|2\d|3[01])\./;

/**
 * 检查给定 IP 是否落在不可路由 / 私有网段内。
 *
 * 覆盖：
 * - IPv4: 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 0.0.0.0
 * - IPv6: ::1, ::, fe80 (link-local), fc/fd (ULA)
 */
export function isReservedAddr(ip: string): boolean {
  // --- IPv4 ---
  if (ip === "0.0.0.0") return true;
  for (const pfx of RESERVED_V4_PREFIXES) {
    if (ip.startsWith(pfx)) return true;
  }
  if (PRIVATE_172_RE.test(ip)) return true;

  // --- IPv6 ---
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:")) return true;           // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
  return false;
}

/* ---------- URL 合法性校验 ---------- */

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/** QQ 官方媒体/API 域名白名单，匹配时跳过 DNS 解析检查 */
const QQ_TRUSTED_DOMAINS = new Set([
  // QQ Bot API
  "api.sgroup.qq.com",
  "sandbox.api.sgroup.qq.com",
  // QQ Bot Token
  "bots.qq.com",
  // QQ 多媒体上传/下载
  "multimedia.nt.qq.com.cn",
  "multimedia.nt.qq.com",
  // QQ 群文件
  "grouppro.grouppro.qq.com",
]);

/** 检查 hostname 是否匹配 QQ 白名单（支持子域名通配 *.example.com） */
function isQQTrustedDomain(hostname: string): boolean {
  if (QQ_TRUSTED_DOMAINS.has(hostname)) return true;
  // 检查一级子域名：*.multimedia.nt.qq.com.cn
  const dot = hostname.indexOf('.');
  if (dot > 0) {
    const parent = hostname.slice(dot + 1);
    return QQ_TRUSTED_DOMAINS.has(parent);
  }
  return false;
}

/**
 * 校验远程 URL 是否可安全请求。
 *
 * 规则：
 * 1. 仅放行 http / https 协议
 * 2. QQ 白名单域名直接放行（免 DNS 解析）
 * 3. 若 URL 直接携带 IP 则即时判定
 * 4. 若为域名则先做 DNS 解析，逐条检查解析结果
 *
 * @throws {Error} 当 URL 指向受限地址时
 */
export async function validateRemoteUrl(raw: string): Promise<void> {
  const url = new URL(raw);

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new Error(
      `不支持的协议 "${url.protocol}"，仅允许 http/https（URL: ${raw}）`,
    );
  }

  // 去掉 IPv6 方括号
  const host = url.hostname.replace(/^\[|\]$/g, "");

  // QQ 官方域名 → 免 DNS 检查直接放行
  if (isQQTrustedDomain(host)) return;

  if (net.isIP(host)) {
    assertPublicAddr(host, raw);
    return;
  }

  // 域名 → 解析后逐条检查
  try {
    const ips = await dns.resolve(host);
    for (const ip of ips) {
      assertPublicAddr(ip, raw, host);
    }
  } catch (err) {
    // 已经是我们自己抛的安全错误，继续向上传播
    if (err instanceof Error && err.message.includes("内网")) throw err;
    // DNS 查询失败不阻塞，后续 fetch 会产生网络错误
    console.warn(`[url-check] DNS 解析 "${host}" 失败: ${err}`);
  }
}

/* ---------- 内部辅助 ---------- */

/** 断言 IP 为公网地址，否则抛出错误 */
function assertPublicAddr(ip: string, originalUrl: string, domain?: string): void {
  if (!isReservedAddr(ip)) return;

  const target = domain ? `域名 "${domain}" 解析到内网地址 "${ip}"` : `内网地址 "${ip}"`;
  throw new Error(
    `禁止访问${target}，已拦截潜在的 SSRF 请求（URL: ${originalUrl}）`,
  );
}
