import type { ResolvedQQBotAccount, QQBotAccountConfig, ToolPolicy, GroupConfig } from "./types.js";
import type { OpenClawConfig, GroupPolicy } from "openclaw/plugin-sdk";

// ============ Agent-aware mentionPatterns 解析 ============

type AgentEntry = { id?: string; groupChat?: { mentionPatterns?: string[]; historyLimit?: number } };

/**
 * 解析 mentionPatterns（agent → global → 空数组）
 *
 * 优先级：
 *   1. agents.list[agentId].groupChat.mentionPatterns
 *   2. messages.groupChat.mentionPatterns
 *   3. []
 */
export function resolveMentionPatterns(cfg: OpenClawConfig, agentId?: string): string[] {
  // 1. agent 级别
  if (agentId) {
    const agents = (cfg as Record<string, unknown>).agents as { list?: AgentEntry[] } | undefined;
    const entry = agents?.list?.find((a) => a.id?.trim().toLowerCase() === agentId.trim().toLowerCase());
    const agentGroupChat = entry?.groupChat;
    if (agentGroupChat && Object.hasOwn(agentGroupChat, "mentionPatterns")) {
      return agentGroupChat.mentionPatterns ?? [];
    }
  }
  // 2. 全局级别
  const globalGroupChat = (cfg as any)?.messages?.groupChat;
  if (globalGroupChat && typeof globalGroupChat === "object" && Object.hasOwn(globalGroupChat, "mentionPatterns")) {
    return (globalGroupChat as { mentionPatterns?: string[] }).mentionPatterns ?? [];
  }
  // 3. 空数组
  return [];
}

export const DEFAULT_ACCOUNT_ID = "default";

// 内联 evaluateMatchedGroupAccessForPolicy（openclaw dist 尚未导出，本地实现）

type MatchedGroupAccessReason = "allowed" | "disabled" | "missing_match_input" | "empty_allowlist" | "not_allowlisted";

interface MatchedGroupAccessDecision {
  allowed: boolean;
  groupPolicy: GroupPolicy;
  reason: MatchedGroupAccessReason;
}

function evaluateMatchedGroupAccessForPolicy(params: {
  groupPolicy: GroupPolicy;
  allowlistConfigured: boolean;
  allowlistMatched: boolean;
  requireMatchInput?: boolean;
  hasMatchInput?: boolean;
}): MatchedGroupAccessDecision {
  if (params.groupPolicy === "disabled") {
    return { allowed: false, groupPolicy: params.groupPolicy, reason: "disabled" };
  }
  if (params.groupPolicy === "allowlist") {
    if (params.requireMatchInput && !params.hasMatchInput) {
      return { allowed: false, groupPolicy: params.groupPolicy, reason: "missing_match_input" };
    }
    if (!params.allowlistConfigured) {
      return { allowed: false, groupPolicy: params.groupPolicy, reason: "empty_allowlist" };
    }
    if (!params.allowlistMatched) {
      return { allowed: false, groupPolicy: params.groupPolicy, reason: "not_allowlisted" };
    }
  }
  return { allowed: true, groupPolicy: params.groupPolicy, reason: "allowed" };
}

interface QQBotChannelConfig extends QQBotAccountConfig {
  /** HTTP/WebSocket User-Agent 追加后缀 */
  userAgentSuffix?: string;
  accounts?: Record<string, QQBotAccountConfig>;
}

// ============ 群消息策略 ============

const DEFAULT_GROUP_POLICY: GroupPolicy = "open";

/** 群历史缓存条数默认值 */
const DEFAULT_GROUP_HISTORY_LIMIT = 20;

/** 单条消息默认处理超时（0 = 不限制） */
const DEFAULT_PROCESSING_TIMEOUT_MS = 0;

const DEFAULT_GROUP_CONFIG: Omit<Required<GroupConfig>, "prompt"> = {
  requireMention: true,
  ignoreOtherMentions: false,
  toolPolicy: "restricted",
  name: "",
  historyLimit: DEFAULT_GROUP_HISTORY_LIMIT,
};

/** 默认群消息行为 PE（可通过配置覆盖） */
const DEFAULT_GROUP_PROMPT = [
  "若发送者为机器人，仅在对方明确@你提问或请求协助具体任务时，以简洁明了的内容回复，",
  "避免与其他机器人产生抢答或多轮无意义对话。",
  "在群聊中优先让人类用户的消息得到响应，机器人之间保持协作而非竞争，确保对话有序不刷屏。",
].join("");

/** 解析群消息策略 */
export function resolveGroupPolicy(cfg: OpenClawConfig, accountId?: string): GroupPolicy {
  const account = resolveQQBotAccount(cfg, accountId);
  return account.config?.groupPolicy ?? DEFAULT_GROUP_POLICY;
}

/** 解析群白名单（统一转大写） */
export function resolveGroupAllowFrom(cfg: OpenClawConfig, accountId?: string): string[] {
  const account = resolveQQBotAccount(cfg, accountId);
  return (account.config?.groupAllowFrom ?? []).map((id) => String(id).trim().toUpperCase());
}

/** 检查指定群是否被允许（使用标准策略引擎） */
export function isGroupAllowed(cfg: OpenClawConfig, groupOpenid: string, accountId?: string): boolean {
  const account = resolveQQBotAccount(cfg, accountId);
  const policy = account.config?.groupPolicy ?? DEFAULT_GROUP_POLICY;
  const allowList = (account.config?.groupAllowFrom ?? []).map((id) => String(id).trim().toUpperCase());
  const allowlistConfigured = allowList.length > 0;
  const allowlistMatched = allowList.some((id) => id === "*" || id === groupOpenid.toUpperCase());

  return evaluateMatchedGroupAccessForPolicy({
    groupPolicy: policy,
    allowlistConfigured,
    allowlistMatched,
  }).allowed;
}

export type ResolvedGroupConfig = Required<GroupConfig>;

export function resolveGroupConfigFromAccount(account: ResolvedQQBotAccount, groupOpenid: string): ResolvedGroupConfig {
  const groups = account.config?.groups ?? {};
  const wildcardCfg = groups["*"] ?? {};
  const specificCfg = groups[groupOpenid] ?? {};
  const accountDefaultRequireMention = account.config?.defaultRequireMention ?? DEFAULT_GROUP_CONFIG.requireMention;

  return {
    requireMention: specificCfg.requireMention ?? wildcardCfg.requireMention ?? accountDefaultRequireMention,
    ignoreOtherMentions: specificCfg.ignoreOtherMentions ?? wildcardCfg.ignoreOtherMentions ?? DEFAULT_GROUP_CONFIG.ignoreOtherMentions,
    toolPolicy: specificCfg.toolPolicy ?? wildcardCfg.toolPolicy ?? DEFAULT_GROUP_CONFIG.toolPolicy,
    name: specificCfg.name ?? wildcardCfg.name ?? DEFAULT_GROUP_CONFIG.name,
    prompt: specificCfg.prompt ?? wildcardCfg.prompt ?? DEFAULT_GROUP_PROMPT,
    historyLimit: specificCfg.historyLimit ?? wildcardCfg.historyLimit ?? DEFAULT_GROUP_CONFIG.historyLimit,
  };
}

export function resolveGroupConfig(cfg: OpenClawConfig, groupOpenid: string, accountId?: string): ResolvedGroupConfig {
  return resolveGroupConfigFromAccount(resolveQQBotAccount(cfg, accountId), groupOpenid);
}

/** 解析群历史消息缓存条数 */
export function resolveHistoryLimit(cfg: OpenClawConfig, groupOpenid: string, accountId?: string): number {
  return Math.max(0, resolveGroupConfig(cfg, groupOpenid, accountId).historyLimit);
}

/** 解析群行为 PE（具体群 > "*" > 默认值） */
export function resolveGroupPrompt(cfg: OpenClawConfig, groupOpenid: string, accountId?: string): string {
  return resolveGroupConfig(cfg, groupOpenid, accountId).prompt;
}

/** 解析群是否需要 @机器人才响应 */
export function resolveRequireMention(cfg: OpenClawConfig, groupOpenid: string, accountId?: string): boolean {
  return resolveGroupConfig(cfg, groupOpenid, accountId).requireMention;
}

/** 解析群是否忽略 @了其他人（非 bot）的消息 */
export function resolveIgnoreOtherMentions(cfg: OpenClawConfig, groupOpenid: string, accountId?: string): boolean {
  return resolveGroupConfig(cfg, groupOpenid, accountId).ignoreOtherMentions;
}

/** 解析群工具策略 */
export function resolveToolPolicy(cfg: OpenClawConfig, groupOpenid: string, accountId?: string): ToolPolicy {
  return resolveGroupConfig(cfg, groupOpenid, accountId).toolPolicy;
}

/** 解析群名称（优先配置，fallback 为 openid 前 8 位） */
export function resolveGroupName(cfg: OpenClawConfig, groupOpenid: string, accountId?: string): string {
  const name = resolveGroupConfig(cfg, groupOpenid, accountId).name;
  return name || groupOpenid.slice(0, 8);
}

/**
 * 解析 User-Agent 追加后缀（仅通道级：channels.qqbot.userAgentSuffix）
 */
export function resolveUserAgentSuffix(cfg: OpenClawConfig): string {
  const qqbot = cfg.channels?.qqbot as QQBotChannelConfig | undefined;
  return qqbot?.userAgentSuffix ? String(qqbot.userAgentSuffix).trim() : "";
}

function normalizeAppId(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  return String(raw).trim();
}

/**
 * 列出所有 QQBot 账户 ID
 */
export function listQQBotAccountIds(cfg: OpenClawConfig): string[] {
  const ids = new Set<string>();
  const qqbot = cfg.channels?.qqbot as QQBotChannelConfig | undefined;

  if (qqbot?.appId) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }

  if (qqbot?.accounts) {
    for (const accountId of Object.keys(qqbot.accounts)) {
      if (qqbot.accounts[accountId]?.appId) {
        ids.add(accountId);
      }
    }
  }

  return Array.from(ids);
}

/**
 * 获取默认账户 ID
 */
export function resolveDefaultQQBotAccountId(cfg: OpenClawConfig): string {
  const qqbot = cfg.channels?.qqbot as QQBotChannelConfig | undefined;
  // 如果有默认账户配置，返回 default
  if (qqbot?.appId) {
    return DEFAULT_ACCOUNT_ID;
  }
  // 否则返回第一个配置的账户
  if (qqbot?.accounts) {
    const ids = Object.keys(qqbot.accounts);
    if (ids.length > 0) {
      return ids[0];
    }
  }
  return DEFAULT_ACCOUNT_ID;
}

/**
 * 解析单条消息处理超时时间（ms）。
 * 优先级：账户配置 > 环境变量 OPENCLAW_PROCESSING_TIMEOUT_MS > 默认
 * 返回 0 表示不限制超时。
 */
export function resolveProcessingTimeoutMs(
  accountConfig?: QQBotAccountConfig,
): number {
  if (accountConfig?.processingTimeoutMs !== undefined) {
    return accountConfig.processingTimeoutMs;
  }
  const env = process.env.OPENCLAW_PROCESSING_TIMEOUT_MS;
  if (env) {
    const v = Number(env);
    if (!Number.isNaN(v) && v >= 0) return v;
  }
  return DEFAULT_PROCESSING_TIMEOUT_MS;
}

/**
 * 解析 QQBot 账户配置
 */
export function resolveQQBotAccount(
  cfg: OpenClawConfig,
  accountId?: string | null
): ResolvedQQBotAccount {
  const resolvedAccountId = accountId ?? resolveDefaultQQBotAccountId(cfg);
  const qqbot = cfg.channels?.qqbot as QQBotChannelConfig | undefined;

  // 基础配置
  let accountConfig: QQBotAccountConfig = {};
  let appId = "";
  let clientSecret = "";
  let secretSource: "config" | "file" | "env" | "none" = "none";

  if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    // 默认账户从顶层读取（展开所有字段，避免遗漏新增配置项）
    const { accounts: _accounts, ...topLevelConfig } = qqbot ?? {} as QQBotChannelConfig;
    accountConfig = {
      ...topLevelConfig,
      markdownSupport: qqbot?.markdownSupport ?? true,
    };
    appId = normalizeAppId(qqbot?.appId);
  } else {
    // 命名账户从 accounts 读取
    const account = qqbot?.accounts?.[resolvedAccountId];
    accountConfig = account ?? {};
    appId = normalizeAppId(account?.appId);
  }

  // 解析 clientSecret
  if (accountConfig.clientSecret) {
    clientSecret = accountConfig.clientSecret;
    secretSource = "config";
  } else if (accountConfig.clientSecretFile) {
    // 从文件读取（运行时处理）
    secretSource = "file";
  } else if (process.env.QQBOT_CLIENT_SECRET && resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    clientSecret = process.env.QQBOT_CLIENT_SECRET;
    secretSource = "env";
  }

  // AppId 也可以从环境变量读取
  if (!appId && process.env.QQBOT_APP_ID && resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    appId = normalizeAppId(process.env.QQBOT_APP_ID);
  }

  return {
    accountId: resolvedAccountId,
    name: accountConfig.name,
    enabled: accountConfig.enabled !== false,
    appId,
    clientSecret,
    secretSource,
    systemPrompt: accountConfig.systemPrompt,
    markdownSupport: accountConfig.markdownSupport !== false,
    userAgentSuffix: resolveUserAgentSuffix(cfg),
    processingTimeoutMs: resolveProcessingTimeoutMs(accountConfig),
    config: normalizeAccountConfig(accountConfig),
  };
}

/** 兼容旧版 streaming: boolean 格式 → { mode: "partial" | "off" }，对齐框架 schema */
function normalizeAccountConfig(raw: QQBotAccountConfig): QQBotAccountConfig {
  if (typeof (raw as any).streaming === 'boolean') {
    const { streaming, ...rest } = raw as any;
    return { ...rest, streaming: { mode: streaming ? 'partial' : 'off' } };
  }
  return raw;
}

/**
 * 应用账户配置
 */
export function applyQQBotAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
  input: { appId?: string; clientSecret?: string; clientSecretFile?: string; name?: string }
): OpenClawConfig {
  const next = { ...cfg };

  if (accountId === DEFAULT_ACCOUNT_ID) {
    // 如果没有设置过 allowFrom，默认设置为 ["*"]
    const existingConfig = (next.channels?.qqbot as QQBotChannelConfig) || {};
    const allowFrom = existingConfig.allowFrom ?? ["*"];
    
    next.channels = {
      ...next.channels,
      qqbot: {
        ...(next.channels?.qqbot as Record<string, unknown> || {}),
        enabled: true,
        allowFrom,
        ...(input.appId ? { appId: input.appId } : {}),
        ...(input.clientSecret
          ? { clientSecret: input.clientSecret }
          : input.clientSecretFile
            ? { clientSecretFile: input.clientSecretFile }
            : {}),
        ...(input.name ? { name: input.name } : {}),
      },
    };
  } else {
    // 如果没有设置过 allowFrom，默认设置为 ["*"]
    const existingAccountConfig = (next.channels?.qqbot as QQBotChannelConfig)?.accounts?.[accountId] || {};
    const allowFrom = existingAccountConfig.allowFrom ?? ["*"];
    
    next.channels = {
      ...next.channels,
      qqbot: {
        ...(next.channels?.qqbot as Record<string, unknown> || {}),
        enabled: true,
        accounts: {
          ...((next.channels?.qqbot as QQBotChannelConfig)?.accounts || {}),
          [accountId]: {
            ...((next.channels?.qqbot as QQBotChannelConfig)?.accounts?.[accountId] || {}),
            enabled: true,
            allowFrom,
            ...(input.appId ? { appId: input.appId } : {}),
            ...(input.clientSecret
              ? { clientSecret: input.clientSecret }
              : input.clientSecretFile
                ? { clientSecretFile: input.clientSecretFile }
                : {}),
            ...(input.name ? { name: input.name } : {}),
          },
        },
      },
    };
  }

  return next;
}
