import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { listQQBotAccountIds } from '../config.js';
import { getBotForAccount } from '../bot-instance.js';
import { getRequestAccountId } from '../request-context.js';

// ========== JSON Schema ==========

const PlatformApiSchema = {
  type: 'object',
  properties: {
    method: {
      type: 'string',
      description:
        'HTTP 请求方法。可选值：GET, POST, PUT, PATCH, DELETE',
      enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    },
    path: {
      type: 'string',
      description:
        'API 路径（不含域名），占位符需替换为实际值。' +
        '示例：/users/@me/guilds, /guilds/{guild_id}/channels, ' +
        '/v2/groups/{group_id}/bot_state',
    },
    body: {
      type: 'object',
      description:
        '请求体（JSON），用于 POST/PUT/PATCH 请求。' +
        'GET/DELETE 请求不需要此参数。',
    },
    query: {
      type: 'object',
      description:
        'URL 查询参数（键值对），会拼接到路径后面。' +
        '如 { "limit": "100", "after": "0" } 会拼接为 ?limit=100&after=0',
      additionalProperties: { type: 'string' },
    },
  },
  required: ['method', 'path'],
} as const;

// ========== 工具函数 ==========

function json(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

function validatePath(path: string): string | null {
  if (!path.startsWith('/')) return "path 必须以 / 开头";
  if (path.includes('..') || path.includes('//')) return "path 不允许包含 .. 或 //";
  if (!/^\/[a-zA-Z0-9\-._~:@!$&'()*+,;=/%]+$/.test(path) && path !== '/') {
    return 'path 包含非法字符';
  }
  return null;
}

// ========== 注册入口 ==========

/**
 * 注册 QQBot 平台统一 API 网关工具。
 * 通过 SDK 的 bot.api 网关代理所有 QQ 开放平台 HTTP 接口 — 自动鉴权、重试、结构化错误。
 *
 * 覆盖范围：
 *  - 频道（Guild/Channel/Member/Announce/Forum/Schedule）→ 见 qqbot-channel skill
 *  - 群（Group/Member）→ 见 qqbot-group skill
 */
export function registerPlatformTool(api: OpenClawPluginApi): void {
  const cfg = api.config;
  if (!cfg) return;

  const accountIds = listQQBotAccountIds(cfg);
  if (accountIds.length === 0) return;

  api.registerTool(
    {
      name: 'qqbot_platform_api',
      label: 'QQBot Platform API Gateway',
      description:
        'QQ 开放平台统一 HTTP API 网关，自动填充鉴权 Token。' +
        '常用接口速查：' +
        '【频道】GET /users/@me/guilds | /guilds/{guild_id}/channels | /channels/{channel_id} | ' +
        '【群】GET /v2/groups/{group_id}/bot_state | /v2/groups/{group_id}/members/{member_id} | /v2/groups/{group_id}/info。' +
        '更多接口和参数详情请阅读 qqbot-channel 和 qqbot-group skill。',
      parameters: PlatformApiSchema,
      async execute(_toolCallId, params) {
        const p = params as {
          method: string;
          path: string;
          body?: Record<string, unknown>;
          query?: Record<string, string>;
        };

        if (!p.method) return json({ error: 'method 为必填参数' });
        if (!p.path) return json({ error: 'path 为必填参数' });

        const method = p.method.toUpperCase();
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
          return json({ error: `不支持的 HTTP 方法: ${method}` });
        }

        const pathError = validatePath(p.path);
        if (pathError) return json({ error: pathError });

        const accountId = getRequestAccountId();
        if (!accountId) {
          return json({ error: '无法获取当前请求的账号信息，此工具仅支持在消息会话中使用' });
        }

        try {
          const bot = getBotForAccount(accountId);
          const apiGateway = bot.api;

          let data: unknown;
          switch (method) {
            case 'GET':
              data = await apiGateway.get(p.path, p.query);
              break;
            case 'POST':
              data = await apiGateway.post(p.path, p.body);
              break;
            case 'PUT':
              data = await apiGateway.put(p.path, p.body);
              break;
            case 'PATCH':
              data = await apiGateway.patch(p.path, p.body);
              break;
            case 'DELETE':
              data = await apiGateway.delete(p.path);
              break;
          }

          return json(data);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const apiErr = err as { httpStatus?: number; bizCode?: number; path?: string };
          return json({
            error: errMsg,
            status: apiErr.httpStatus,
            code: apiErr.bizCode,
            path: p.path,
          });
        }
      },
    },
    { name: 'qqbot_platform_api' },
  );
}
