/**
 * QQBot Approval Handler
 *
 * 监听 Gateway 的 exec/plugin approval 事件，
 * 直接调用 QQ API 发送带 Inline Keyboard 的审批消息。
 * 参考 DiscordExecApprovalHandler 的实现模式。
 *
 * 兼容性：gateway-runtime / approval-runtime 模块在 openclaw < 3.22 上不存在，
 * 使用动态 import 避免插件整体加载失败，旧版框架上审批功能自动降级（不可用）。
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { getBotForAccount } from "../bot-instance.js";
import type { PluginLogger } from '../utils/plugin-logger.js';
import type { InlineKeyboard, KeyboardButton } from "../types.js";

import { loadApprovalGatewayRuntime, type ApprovalGatewayClient } from '../adapter/gateway.js';
type EventFrame = {
  event: string;
  payload: unknown;
};

/** approval-runtime 中的审批请求/结果类型（内联定义，避免顶层 import） */
interface ExecApprovalRequest {
  id: string;
  expiresAtMs: number;
  request: {
    commandPreview?: string;
    command?: string;
    cwd?: string;
    agentId?: string;
    turnSourceAccountId?: string;
    sessionKey?: string;
    turnSourceTo?: string;
    [key: string]: unknown;
  };
}

interface ExecApprovalResolved {
  id: string;
  decision: string;
  resolvedBy?: string;
  [key: string]: unknown;
}

interface PluginApprovalRequest {
  id: string;
  request: {
    timeoutMs?: number;
    severity?: "critical" | "info" | string;
    title: string;
    description?: string;
    toolName?: string;
    pluginId?: string;
    agentId?: string;
    turnSourceAccountId?: string;
    sessionKey?: string;
    turnSourceTo?: string;
    [key: string]: unknown;
  };
}

interface PluginApprovalResolved {
  id: string;
  decision: string;
  resolvedBy?: string;
  [key: string]: unknown;
}

// ─── 类型 ───────────────────────────────────────────────────

export interface QQBotApprovalHandlerOpts {
  accountId: string;
  appId: string;
  clientSecret: string;
  cfg: OpenClawConfig;
  gatewayUrl?: string;
  log?: PluginLogger;
}

type ApprovalKind = "exec" | "plugin";

type CachedApprovalRequest =
  | { kind: "exec"; request: ExecApprovalRequest }
  | { kind: "plugin"; request: PluginApprovalRequest };

type PendingEntry = {
  targets: Array<{ type: "c2c" | "group"; id: string }>;
  timeoutId: ReturnType<typeof setTimeout>;
};

// ─── 辅助函数 ───────────────────────────────────────────────

function toShortId(approvalId: string): string {
  return approvalId.replace(/^(exec|plugin):/, "").slice(0, 8);
}

function resolveApprovalKind(approvalId: string): ApprovalKind {
  return approvalId.startsWith("plugin:") ? "plugin" : "exec";
}

function buildExecApprovalText(request: ExecApprovalRequest): string {
  const expiresIn = Math.max(
    0,
    Math.round((request.expiresAtMs - Date.now()) / 1000)
  );
  const lines: string[] = ["🔐 命令执行审批", ""];
  const cmd = request.request.commandPreview ?? request.request.command ?? "";
  if (cmd) lines.push(`\`\`\`\n${cmd.slice(0, 300)}\n\`\`\``);
  if (request.request.cwd) lines.push(`📁 目录: ${request.request.cwd}`);
  if (request.request.agentId) lines.push(`🤖 Agent: ${request.request.agentId}`);
  lines.push("", `⏱️ 超时: ${expiresIn} 秒`);
  return lines.join("\n");
}

function buildPluginApprovalText(request: PluginApprovalRequest): string {
  const timeoutSec = Math.round((request.request.timeoutMs ?? 120_000) / 1000);
  const severityIcon =
    request.request.severity === "critical" ? "🔴"
    : request.request.severity === "info" ? "🔵"
    : "🟡";

  const lines: string[] = [`${severityIcon} 审批请求`, ""];
  lines.push(`📋 ${request.request.title}`);
  if (request.request.description) lines.push(`📝 ${request.request.description}`);
  if (request.request.toolName) lines.push(`🔧 工具: ${request.request.toolName}`);
  if (request.request.pluginId) lines.push(`🔌 插件: ${request.request.pluginId}`);
  if (request.request.agentId) lines.push(`🤖 Agent: ${request.request.agentId}`);
  lines.push("", `⏱️ 超时: ${timeoutSec} 秒`);
  return lines.join("\n");
}

/**
 * Inline Keyboard（内嵌回调型按钮）
 * type=1(Callback)：点击触发 INTERACTION_CREATE，button_data = data 字段
 * group_id 相同 → 点一个后其余变灰（三选一语义）
 * click_limit=1 → 每人只能点一次
 * permission.type=2 → 所有人可操作
 */
function buildApprovalKeyboard(approvalId: string): InlineKeyboard {
  const makeBtn = (
    id: string,
    label: string,
    visitedLabel: string,
    data: string,
    style: 0 | 1
  ): KeyboardButton => ({
    id,
    render_data: { label, visited_label: visitedLabel, style },
    action: {
      type: 1,
      data,
      permission: { type: 2 },
      click_limit: 1,
    },
    group_id: "approval",
  });
  return {
    content: {
      rows: [
        {
          buttons: [
            makeBtn("allow",  "✅ 允许一次", "已允许",    `approve:${approvalId}:allow-once`,  1),
            makeBtn("always", "⭐ 始终允许", "已始终允许", `approve:${approvalId}:allow-always`, 1),
            makeBtn("deny",   "❌ 拒绝",     "已拒绝",    `approve:${approvalId}:deny`,         0),
          ],
        },
      ],
    },
  };
}

/** 从 sessionKey 或 turnSourceTo 提取投递目标 */
function resolveTarget(
  sessionKey: string | null | undefined,
  turnSourceTo: string | null | undefined
): { type: "c2c" | "group"; id: string } | null {
  // 优先从 sessionKey 解析（如 agent:main:qqbot:direct:OPENID）
  const sk = sessionKey ?? turnSourceTo;
  if (!sk) return null;
  const m = sk.match(/qqbot:(c2c|direct|group):([A-F0-9]+)/i);
  if (!m) return null;
  const type = m[1]!.toLowerCase() === "group" ? "group" : "c2c";
  return { type, id: m[2]! };
}

// ─── Handler 类 ──────────────────────────────────────────────

export class QQBotApprovalHandler {
  private gatewayClient: ApprovalGatewayClient | null = null;
  private pending = new Map<string, PendingEntry>();
  private requestCache = new Map<string, CachedApprovalRequest>();
  private opts: QQBotApprovalHandlerOpts;
  private started = false;
  private connected = false;

  constructor(opts: QQBotApprovalHandlerOpts) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const { log } = this.opts;
    log?.debug?.(`[qqbot:${this.opts.accountId}] approval-handler: starting`);

    // 动态加载 gateway-runtime（兼容旧版框架 / pnpm 环境）
    const gatewayRuntime = loadApprovalGatewayRuntime();
    if (!gatewayRuntime) {
      log?.debug?.(`[qqbot:${this.opts.accountId}] approval-handler: gateway-runtime not available, approval disabled`);
      this.started = false;
      return;
    }

    try {
      this.gatewayClient = await gatewayRuntime.createOperatorApprovalsGatewayClient({
        config: this.opts.cfg,
        gatewayUrl: this.opts.gatewayUrl,
        clientDisplayName: "QQBot Approval Handler",
        onEvent: (evt: EventFrame) => this.handleGatewayEvent(evt),
        onHelloOk: () => {
          this.connected = true;
          log?.debug?.(`[qqbot:${this.opts.accountId}] approval-handler: connected to gateway`);
        },
        onConnectError: (err: { message: string }) => log?.error(`[qqbot:${this.opts.accountId}] approval-handler: connect error: ${err.message}`),
        onClose: (code: number, reason: string) => {
          this.connected = false;
          log?.debug?.(`[qqbot:${this.opts.accountId}] approval-handler: gateway closed: ${code} ${reason}`);
        },
      });
      this.gatewayClient.start();
      setApprovalFeatureAvailable(true);
    } catch (err) {
      log?.error(`[qqbot:${this.opts.accountId}] approval-handler: failed to create gateway client: ${err}`);
      this.started = false;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    for (const entry of this.pending.values()) clearTimeout(entry.timeoutId);
    this.pending.clear();
    this.requestCache.clear();
    await this.gatewayClient?.stop();
    this.gatewayClient = null;
    this.opts.log?.debug(`[qqbot:${this.opts.accountId}] approval-handler: stopped`);
  }

  /** gateway 是否已建立连接 */
  get isConnected(): boolean { return this.connected; }

  /** 检查是否有指定 shortId 对应的 pending 审批 */
  hasShortId(shortId: string): boolean {
    for (const id of this.pending.keys()) {
      if (toShortId(id) === shortId) return true;
    }
    return false;
  }

  /** 解析审批请求（供 Interaction 回调或 /approve 命令调用） */
  async resolveApproval(
    approvalId: string,
    decision: "allow-once" | "allow-always" | "deny"
  ): Promise<boolean> {
    if (!this.gatewayClient) {
      this.opts.log?.warn(`[qqbot:${this.opts.accountId}] approval-handler: resolve ignored ${approvalId} → gatewayClient not ready`);
      return false;
    }

    // 查找完整 ID：支持完整 ID（exec:uuid / plugin:uuid）、纯 UUID、或 shortId（8位）
    let fullId = approvalId;
    if (this.pending.has(approvalId)) {
      fullId = approvalId;
    } else {
      // 尝试在 pending keys 中匹配：纯 UUID 可能对应 exec:uuid 或 plugin:uuid
      for (const id of this.pending.keys()) {
        if (id === approvalId) { fullId = id; break; }
        // 纯 UUID 匹配：pending key 的 uuid 部分等于传入值
        if (id.replace(/^(exec|plugin):/, "") === approvalId) { fullId = id; break; }
        // shortId 匹配
        if (toShortId(id) === approvalId) { fullId = id; break; }
      }
      // 也在 requestCache 中查找（handleResolved 可能已清除 pending）
      if (fullId === approvalId && !this.requestCache.has(approvalId)) {
        for (const id of this.requestCache.keys()) {
          if (id.replace(/^(exec|plugin):/, "") === approvalId) { fullId = id; break; }
        }
      }
    }

    const kind = resolveApprovalKind(fullId);
    const method = kind === "plugin" ? "plugin.approval.resolve" : "exec.approval.resolve";
    const isPending = this.pending.has(fullId);
    const isCached = this.requestCache.has(fullId);

    this.opts.log?.debug?.(`[qqbot:${this.opts.accountId}] approval-handler: resolving ${fullId} (input=${approvalId}) kind=${kind} → ${decision}, pending=${isPending}, cached=${isCached}`);

    try {
      await this.gatewayClient.request(method, { id: fullId, decision });
      this.opts.log?.debug(`[qqbot:${this.opts.accountId}] approval-handler: RPC success ${toShortId(fullId)} → ${decision} (method=${method})`);
      return true;
    } catch (err) {
      this.opts.log?.error(`[qqbot:${this.opts.accountId}] approval-handler: resolve failed: ${err}`);
      return false;
    }
  }

  private handleGatewayEvent(evt: EventFrame): void {
    if (evt.event === "exec.approval.requested") {
      void this.handleRequested(evt.payload as ExecApprovalRequest, "exec");
    } else if (evt.event === "plugin.approval.requested") {
      void this.handleRequested(evt.payload as PluginApprovalRequest, "plugin");
    } else if (evt.event === "exec.approval.resolved") {
      void this.handleResolved(evt.payload as ExecApprovalResolved);
    } else if (evt.event === "plugin.approval.resolved") {
      void this.handleResolved(evt.payload as PluginApprovalResolved);
    }
  }

  private async handleRequested(
    request: ExecApprovalRequest | PluginApprovalRequest,
    kind: ApprovalKind
  ): Promise<void> {
    const { log, appId, clientSecret, accountId } = this.opts;
    const shortId = toShortId(request.id);

    // 只处理本账号的请求
    const reqAccountId = (request.request as any).turnSourceAccountId?.trim();
    if (reqAccountId && reqAccountId !== accountId) {
      log?.debug?.(`[qqbot:${accountId}] approval-handler: ${kind} ${shortId} ignored → account mismatch (req=${reqAccountId})`);
      return;
    }

    // 解析投递目标
    const sessionKey = (request.request as any).sessionKey;
    const turnSourceTo = (request.request as any).turnSourceTo;
    const target = resolveTarget(sessionKey, turnSourceTo);
    if (!target) {
      log?.info(`[qqbot:${accountId}] approval-handler: no QQ target for ${shortId} (session=${sessionKey})`);
      return;
    }

    // 缓存请求
    this.requestCache.set(
      request.id,
      kind === "plugin"
        ? { kind: "plugin", request: request as PluginApprovalRequest }
        : { kind: "exec", request: request as ExecApprovalRequest }
    );

    log?.info(`[qqbot:${accountId}] approval-handler: sending ${kind} approval ${shortId} to ${target.type}:${target.id}`);

    const text = kind === "plugin"
      ? buildPluginApprovalText(request as PluginApprovalRequest)
      : buildExecApprovalText(request as ExecApprovalRequest);

    const keyboard = buildApprovalKeyboard(request.id);

    const timeoutMs = kind === "plugin"
      ? ((request as PluginApprovalRequest).request.timeoutMs ?? 120_000)
      : Math.max(0, (request as ExecApprovalRequest).expiresAtMs - Date.now());

    // 短暂延迟，确保框架侧 waitDecision 已就绪，避免时序竞争
    await new Promise((r) => setTimeout(r, 2000));

    try {
      const bot = getBotForAccount(accountId);
      const target_reply = {
        scope: target.type as "c2c" | "group",
        targetId: target.id,
      };
      await bot.sendTextWithKeyboard(target_reply, text, keyboard as any);
      log?.info(`[qqbot:${accountId}] approval-handler: sent ${kind} approval ${shortId}`);

      const timeoutId = setTimeout(() => {
        this.handleTimeout(request.id, target);
      }, timeoutMs + 2_000);

      this.pending.set(request.id, { targets: [target], timeoutId });
    } catch (err) {
      this.requestCache.delete(request.id);
      log?.error(`[qqbot:${accountId}] approval-handler: failed to send approval ${shortId}: ${err}`);
    }
  }

  private async handleResolved(
    resolved: ExecApprovalResolved | PluginApprovalResolved
  ): Promise<void> {
    const entry = this.pending.get(resolved.id);
    const resolvedBy = (resolved as any).resolvedBy ?? "unknown";
    const kind = resolveApprovalKind(resolved.id);

    this.opts.log?.info(
      `[qqbot:${this.opts.accountId}] approval-handler: gateway confirmed ${toShortId(resolved.id)} → ${resolved.decision} (kind=${kind}, resolvedBy=${resolvedBy}, wasPending=${!!entry})`
    );

    if (!entry) return;

    clearTimeout(entry.timeoutId);
    this.pending.delete(resolved.id);
    this.requestCache.delete(resolved.id);
    // 框架 Forwarder 负责发送 resolved 通知（已通过 buildResolvedPayload=null 抑制），此处不重复发送
  }

  private async handleTimeout(
    approvalId: string,
    target: { type: "c2c" | "group"; id: string }
  ): Promise<void> {
    const { log, accountId } = this.opts;
    if (!this.pending.has(approvalId)) return;
    this.pending.delete(approvalId);
    this.requestCache.delete(approvalId);
    log?.info(`[qqbot:${accountId}] approval-handler: timeout ${toShortId(approvalId)}`);
    // 超时由框架处理，此处仅清理状态，不重复发消息
  }
}

// ─── 模块级 handler 注册 ────────────────────────────────────

const _handlers = new Map<string, QQBotApprovalHandler>();

/** 审批功能是否可用（gateway-runtime 模块加载成功则为 true） */
let _approvalFeatureAvailable = false;

export function isApprovalFeatureAvailable(): boolean {
  return _approvalFeatureAvailable;
}

export function setApprovalFeatureAvailable(available: boolean): void {
  _approvalFeatureAvailable = available;
}

export function registerApprovalHandler(accountId: string, handler: QQBotApprovalHandler): void {
  _handlers.set(accountId, handler);
}

export function unregisterApprovalHandler(accountId: string): void {
  _handlers.delete(accountId);
}

export function getApprovalHandler(accountId: string): QQBotApprovalHandler | undefined {
  return _handlers.get(accountId);
}

export function findApprovalHandlerForShortId(shortId: string): QQBotApprovalHandler | undefined {
  for (const handler of _handlers.values()) {
    if (handler.hasShortId(shortId)) return handler;
  }
  return undefined;
}
