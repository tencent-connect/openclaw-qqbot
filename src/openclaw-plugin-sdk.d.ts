/**
 * OpenClaw Plugin SDK 类型声明
 * 
 * 此文件为 openclaw/plugin-sdk 模块提供 TypeScript 类型声明
 * 仅包含本项目实际使用的类型和函数
 */

declare module "openclaw/plugin-sdk" {
  // ============ 配置类型 ============

  /**
   * OpenClaw 主配置对象
   */
  export interface OpenClawConfig {
    /** 频道配置 */
    channels?: {
      qqbot?: unknown;
      telegram?: unknown;
      discord?: unknown;
      slack?: unknown;
      whatsapp?: unknown;
      [key: string]: unknown;
    };
    /** 其他配置字段 */
    [key: string]: unknown;
  }

  // ============ 插件运行时 ============

  /**
   * Channel Activity 接口
   */
  export interface ChannelActivity {
    record?: (...args: unknown[]) => void;
    recordActivity?: (key: string, data?: unknown) => void;
    [key: string]: unknown;
  }

  /**
   * Channel Routing 接口
   */
  export interface ChannelRouting {
    resolveAgentRoute?: (...args: unknown[]) => unknown;
    resolveSenderAndSession?: (options: unknown) => unknown;
    [key: string]: unknown;
  }

  /**
   * Channel Reply 接口
   */
  export interface ChannelReply {
    handleIncomingMessage?: (options: unknown) => Promise<unknown>;
    formatInboundEnvelope?: (...args: unknown[]) => unknown;
    finalizeInboundContext?: (...args: unknown[]) => unknown;
    resolveEnvelopeFormatOptions?: (...args: unknown[]) => unknown;
    handleAutoReply?: (...args: unknown[]) => Promise<unknown>;
    [key: string]: unknown;
  }

  /**
   * Channel 接口（用于 PluginRuntime）
   * 注意：这是一个宽松的类型定义，实际 SDK 中的类型更复杂
   */
  export interface ChannelInterface {
    recordInboundSession?: (options: unknown) => void;
    handleIncomingMessage?: (options: unknown) => Promise<unknown>;
    activity?: ChannelActivity;
    routing?: ChannelRouting;
    reply?: ChannelReply;
    [key: string]: unknown;
  }

  /**
   * 插件运行时接口
   * 注意：channel 属性设为 any 是因为 SDK 内部类型非常复杂，
   * 且会随 SDK 版本变化。实际使用时 SDK 会提供正确的运行时类型。
   */
  export interface PluginRuntime {
    /** OpenClaw 框架版本号，如 "2026.3.31" */
    version: string;
    /** 配置访问（运行时 config 在 config.current()，非顶层 getConfig()） */
    config?: {
      /** 获取当前运行时配置快照（只读） */
      current(): OpenClawConfig;
    };
    /** Channel 接口 */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    channel?: any;
    /** 日志函数（旧版，建议使用 logging.getChildLogger） */
    log: {
      info: (message: string, ...args: unknown[]) => void;
      warn: (message: string, ...args: unknown[]) => void;
      error: (message: string, ...args: unknown[]) => void;
      debug: (message: string, ...args: unknown[]) => void;
    };
    /** 结构化日志（框架自动追加 channel 前缀） */
    logging: {
      shouldLogVerbose: () => boolean;
      getChildLogger: (
        bindings?: Record<string, unknown>,
        opts?: { level?: string },
      ) => RuntimeLogger;
    };
    /** 其他运行时方法（不要假设 getConfig/getDataDir/setConfig 可用） */
    [key: string]: unknown;
  }

  /** 结构化日志器 */
  export interface RuntimeLogger {
    debug?: (message: string, meta?: Record<string, unknown>) => void;
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
    error: (message: string, meta?: Record<string, unknown>) => void;
  }

  // ============ 插件 API ============

  /**
   * Agent Tool 执行结果
   */
  export interface AgentToolResult {
    content: Array<{ type: "text"; text: string }>;
    details?: unknown;
  }

  /**
   * Agent Tool 定义
   */
  export interface AnyAgentTool {
    name: string;
    label?: string;
    description: string;
    parameters: unknown;
    execute: (toolCallId: string, params: unknown) => Promise<AgentToolResult> | AgentToolResult;
  }

  /**
   * Tool 注册选项
   */
  export interface ToolRegistrationOptions {
    name?: string;
    names?: string[];
    optional?: boolean;
  }

  /**
   * OpenClaw 插件 API
   */
  export interface OpenClawPluginApi {
    /** 运行时实例 */
    runtime: PluginRuntime;
    /** 当前配置 */
    config: OpenClawConfig;
    /** 日志 */
    logger: {
      info?: (msg: string) => void;
      warn?: (msg: string) => void;
      error?: (msg: string) => void;
      debug?: (msg: string) => void;
    };
    /** 注册频道 */
    registerChannel<TAccount = unknown>(options: { plugin: ChannelPlugin<TAccount> }): void;
    /** 注册工具 */
    registerTool(tool: AnyAgentTool, opts?: ToolRegistrationOptions): void;
    /** 其他 API 方法 */
    [key: string]: unknown;
  }

  // ============ 插件配置 Schema ============

  /**
   * 空的插件配置 Schema
   */
  export function emptyPluginConfigSchema(): unknown;

  // ============ 频道插件 ============

  /**
   * 频道插件 Meta 信息
   */
  export interface ChannelPluginMeta {
    id: string;
    label: string;
    selectionLabel?: string;
    docsPath?: string;
    blurb?: string;
    order?: number;
    [key: string]: unknown;
  }

  /**
   * 频道插件能力配置
   */
  export interface ChannelPluginCapabilities {
    chatTypes?: ("direct" | "group" | "channel")[];
    media?: boolean;
    reactions?: boolean;
    threads?: boolean;
    blockStreaming?: boolean;
    [key: string]: unknown;
  }

  /**
   * 账户描述
   */
  export interface AccountDescription {
    accountId: string;
    name?: string;
    enabled: boolean;
    configured: boolean;
    tokenSource?: string;
    [key: string]: unknown;
  }

  /**
   * 频道插件配置接口（泛型）
   */
  export interface ChannelPluginConfig<TAccount> {
    listAccountIds: (cfg: OpenClawConfig) => string[];
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => TAccount;
    defaultAccountId: (cfg: OpenClawConfig) => string;
    setAccountEnabled?: (ctx: { cfg: OpenClawConfig; accountId: string; enabled: boolean }) => OpenClawConfig;
    deleteAccount?: (ctx: { cfg: OpenClawConfig; accountId: string }) => OpenClawConfig;
    isConfigured?: (account: TAccount | undefined) => boolean;
    describeAccount?: (account: TAccount | undefined) => AccountDescription;
    [key: string]: unknown;
  }

  /**
   * Setup 输入参数（扩展类型以支持 QQBot 特定字段）
   */
  export interface SetupInput {
    token?: string;
    tokenFile?: string;
    useEnv?: boolean;
    name?: string;
    [key: string]: unknown;
  }

  /**
   * 频道插件 Setup 接口
   */
  export interface ChannelPluginSetup {
    resolveAccountId?: (ctx: { accountId?: string }) => string;
    applyAccountName?: (ctx: { cfg: OpenClawConfig; accountId: string; name: string }) => OpenClawConfig;
    validateInput?: (ctx: { input: SetupInput }) => string | null;
    applyConfig?: (ctx: { cfg: OpenClawConfig; accountId: string; input: SetupInput }) => OpenClawConfig;
    applyAccountConfig?: (ctx: { cfg: OpenClawConfig; accountId: string; input: SetupInput }) => OpenClawConfig;
    [key: string]: unknown;
  }

  /**
   * 消息目标解析结果
   */
  export interface NormalizeTargetResult {
    ok: boolean;
    to?: string;
    error?: string;
  }

  /**
   * 目标解析器
   */
  export interface TargetResolver {
    looksLikeId?: (id: string) => boolean;
    hint?: string;
  }

  /**
   * 频道插件 Messaging 接口
   */
  export interface ChannelPluginMessaging {
    normalizeTarget?: (target: string) => string | undefined;
    targetResolver?: TargetResolver;
    [key: string]: unknown;
  }

  /**
   * 发送文本结果
   */
  export interface SendTextResult {
    channel: string;
    messageId?: string;
    error?: Error;
  }

  /**
   * 发送文本上下文
   */
  export interface SendTextContext {
    to: string;
    text: string;
    accountId?: string;
    replyToId?: string;
    cfg: OpenClawConfig;
  }

  /**
   * 发送媒体上下文
   */
  export interface SendMediaContext {
    to: string;
    text?: string;
    mediaUrl?: string;
    accountId?: string;
    replyToId?: string;
    cfg: OpenClawConfig;
  }

  /**
   * 频道插件 Outbound 接口
   */
  export interface ChannelPluginOutbound {
    deliveryMode?: "direct" | "queued";
    chunker?: (text: string, limit: number) => string[];
    chunkerMode?: "markdown" | "plain";
    textChunkLimit?: number;
    sendText?: (ctx: SendTextContext) => Promise<SendTextResult>;
    sendMedia?: (ctx: SendMediaContext) => Promise<SendTextResult>;
    [key: string]: unknown;
  }

  /**
   * 账户状态
   */
  export interface AccountStatus {
    running?: boolean;
    connected?: boolean;
    lastConnectedAt?: number;
    lastError?: string;
    [key: string]: unknown;
  }

  /**
   * Gateway 启动上下文
   */
  export interface GatewayStartContext<TAccount = unknown> {
    account: TAccount;
    accountId: string;
    abortSignal: AbortSignal;
    cfg: OpenClawConfig;
    log?: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
      debug: (msg: string) => void;
    };
    getStatus: () => AccountStatus;
    setStatus: (status: AccountStatus) => void;
    [key: string]: unknown;
  }

  /**
   * Gateway 登出上下文
   */
  export interface GatewayLogoutContext {
    accountId: string;
    cfg: OpenClawConfig;
    [key: string]: unknown;
  }

  /**
   * Gateway 登出结果
   */
  export interface GatewayLogoutResult {
    ok: boolean;
    cleared: boolean;
    updatedConfig?: OpenClawConfig;
    error?: string;
  }

  /**
   * 频道插件 Gateway 接口
   */
  export interface ChannelPluginGateway<TAccount = unknown> {
    startAccount?: (ctx: GatewayStartContext<TAccount>) => Promise<void>;
    logoutAccount?: (ctx: GatewayLogoutContext) => Promise<GatewayLogoutResult>;
    [key: string]: unknown;
  }

  // ============ 群消息适配器 ============

  /** 群消息策略适配器（resolveRequireMention / resolveToolPolicy / resolveGroupIntroHint） */
  export interface ChannelGroupAdapter {
    /** 是否需要 @机器人才响应 */
    resolveRequireMention?: (ctx: { cfg: OpenClawConfig; accountId?: string; groupId: string }) => boolean | undefined;
    /** 群聊 AI 工具使用范围 */
    resolveToolPolicy?: (
      ctx: { cfg: OpenClawConfig; accountId?: string; groupId: string; senderId?: string }
    ) =>
      | "full"
      | "restricted"
      | "none"
      | GroupToolPolicyConfig
      | undefined;
    /** 平台特有的群聊行为提示 */
    resolveGroupIntroHint?: (ctx: { cfg: OpenClawConfig; accountId?: string; groupId: string }) => string | undefined;
    /** 其他适配器方法 */
    [key: string]: unknown;
  }

  /** 工具策略配置（用于把 none/restricted/full 映射为 allow/deny） */
  export type GroupToolPolicyConfig = {
    allow: string[];
    deny?: string[];
  };

  /** @mention 检测与清理适配器（stripMentionText / detectWasMentioned） */
  export interface ChannelMentionAdapter {
    /** 清理 @mention 文本：平台格式→可读格式，去除 @机器人自身 */
    stripMentionText?: (text: string, mentions?: Array<{ member_openid?: string; nickname?: string; is_you?: boolean }>) => string;
    /** stripMentions：框架回调型（一次性拿到 text + ctx） */
    stripMentions?: (params: { text: string; ctx: unknown }) => string;
    /** 检测当前消息是否 @了机器人 */
    detectWasMentioned?: (ctx: {
      eventType?: string;
      mentions?: Array<{ is_you?: boolean; bot?: boolean }>;
      content?: string;
      mentionPatterns?: string[];
    }) => boolean;
    /** 其他适配器方法 */
    [key: string]: unknown;
  }

  /** 状态摘要构建（仅覆盖当前项目用到的字段） */
  export interface ChannelPluginStatus {
    defaultRuntime: Record<string, unknown>;
    buildChannelSummary?: (ctx: { snapshot: any }) => Record<string, unknown>;
    buildAccountSnapshot?: (ctx: { account: any; runtime: any }) => Record<string, unknown>;
    [key: string]: unknown;
  }

  /**
   * 频道插件接口（泛型）
   */
  export interface ChannelPlugin<TAccount = unknown> {
    /** 插件 ID */
    id: string;
    /** 插件 Meta 信息 */
    meta?: ChannelPluginMeta;
    /** 插件版本 */
    version?: string;
    /** 插件能力 */
    capabilities?: ChannelPluginCapabilities;
    /** 重载配置 */
    reload?: { configPrefixes?: string[] };
    /** Onboarding 适配器 */
    onboarding?: ChannelOnboardingAdapter;
    /** 配置方法 */
    config?: ChannelPluginConfig<TAccount>;
    /** Setup 方法 */
    setup?: ChannelPluginSetup;
    /** Messaging 配置 */
    messaging?: ChannelPluginMessaging;
    /** Outbound 配置 */
    outbound?: ChannelPluginOutbound;
    /** Gateway 配置 */
    gateway?: ChannelPluginGateway<TAccount>;
    /** 群消息策略适配器 */
    groups?: ChannelGroupAdapter;
    /** @mention 检测与清理适配器 */
    mentions?: ChannelMentionAdapter;
    /** 状态摘要构建（可选） */
    status?: ChannelPluginStatus;
    /** 启动函数 */
    start?: (runtime: PluginRuntime) => void | Promise<void>;
    /** 停止函数 */
    stop?: () => void | Promise<void>;
    /** deliver 函数 - 发送消息 */
    deliver?: (ctx: unknown) => Promise<unknown>;
    /** 其他插件属性 */
    [key: string]: unknown;
  }

  // ============ Onboarding 类型 ============

  /**
   * Onboarding 状态结果
   */
  export interface ChannelOnboardingStatus {
    channel?: string;
    configured: boolean;
    statusLines?: string[];
    selectionHint?: string;
    quickstartScore?: number;
    [key: string]: unknown;
  }

  /**
   * Onboarding 状态字符串枚举（部分 API 使用）
   */
  export type ChannelOnboardingStatusString =
    | "not-configured"
    | "configured"
    | "connected"
    | "error";

  /**
   * Onboarding 状态上下文
   */
  export interface ChannelOnboardingStatusContext {
    /** 当前配置 */
    config: OpenClawConfig;
    /** 账户 ID */
    accountId?: string;
    /** Prompter */
    prompter?: unknown;
    /** 其他上下文 */
    [key: string]: unknown;
  }

  /**
   * Onboarding 配置上下文
   */
  export interface ChannelOnboardingConfigureContext {
    /** 当前配置 */
    config: OpenClawConfig;
    /** 账户 ID */
    accountId?: string;
    /** 输入参数 */
    input?: Record<string, unknown>;
    /** Prompter */
    prompter?: unknown;
    /** 其他上下文 */
    [key: string]: unknown;
  }

  /**
   * Onboarding 结果
   */
  export interface ChannelOnboardingResult {
    /** 是否成功 */
    success: boolean;
    /** 更新后的配置 */
    config?: OpenClawConfig;
    /** 错误信息 */
    error?: string;
    /** 消息 */
    message?: string;
    /** 其他结果字段 */
    [key: string]: unknown;
  }

  /**
   * Onboarding 适配器接口
   */
  export interface ChannelOnboardingAdapter {
    /** 获取状态 */
    getStatus?: (ctx: ChannelOnboardingStatusContext) => ChannelOnboardingStatus | Promise<ChannelOnboardingStatus>;
    /** 配置函数 */
    configure?: (ctx: ChannelOnboardingConfigureContext) => ChannelOnboardingResult | Promise<ChannelOnboardingResult>;
    /** 其他适配器方法 */
    [key: string]: unknown;
  }

  // ============ 配置辅助函数 ============

  /**
   * 将账户名称应用到频道配置段
   */
  export function applyAccountNameToChannelSection(ctx: {
    cfg: OpenClawConfig;
    channelKey: string;
    accountId: string;
    name: string;
  }): OpenClawConfig;

  /**
   * 从配置段删除账户
   */
  export function deleteAccountFromConfigSection(ctx: {
    cfg: OpenClawConfig;
    sectionKey: string;
    accountId: string;
    clearBaseFields?: string[];
  }): OpenClawConfig;

  /**
   * 设置账户启用状态
   */
  export function setAccountEnabledInConfigSection(ctx: {
    cfg: OpenClawConfig;
    sectionKey: string;
    accountId: string;
    enabled: boolean;
    allowTopLevel?: boolean;
  }): OpenClawConfig;

  // ============ 群访问策略引擎（核心框架标准） ============

  /** 群组访问策略类型："open" | "disabled" | "allowlist" */
  export type GroupPolicy = "open" | "disabled" | "allowlist";

  /** 基于白名单匹配的群访问决策原因 */
  export type MatchedGroupAccessReason =
    | "allowed"
    | "disabled"
    | "missing_match_input"
    | "empty_allowlist"
    | "not_allowlisted";

  /** 基于白名单匹配的群访问决策结果 */
  export type MatchedGroupAccessDecision = {
    allowed: boolean;
    groupPolicy: GroupPolicy;
    reason: MatchedGroupAccessReason;
  };

  /**
   * 核心框架标准群访问策略评估引擎（基于 policy + allowlist 匹配）
   * @see openclaw/src/plugin-sdk/group-access.ts
   */
  export function evaluateMatchedGroupAccessForPolicy(params: {
    groupPolicy: GroupPolicy;
    allowlistConfigured: boolean;
    allowlistMatched: boolean;
    requireMatchInput?: boolean;
    hasMatchInput?: boolean;
  }): MatchedGroupAccessDecision;

  // ============ 审批运行时类型（minimal） ============
  // 这些类型只覆盖本项目真实使用到的字段，
  // 用来消除 strict/noImplicitAny 下的连锁报错。

  export interface ExecApprovalRequest {
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

  export interface ExecApprovalResolved {
    id: string;
    decision: string;
    [key: string]: unknown;
  }

  export interface PluginApprovalRequest {
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

  export interface PluginApprovalResolved {
    id: string;
    decision: string;
    [key: string]: unknown;
  }

  // ============ 其他导出 ============

  /** 默认账户 ID 常量 */
  export const DEFAULT_ACCOUNT_ID: string;

  /** 规范化账户 ID */
  export function normalizeAccountId(accountId: string | undefined | null): string;
}

declare module "openclaw/plugin-sdk/setup" {
  export interface ChannelSetupWizardStatus {
    channelLabel: string;
    configuredLabel: string;
    unconfiguredLabel: string;
    configuredHint?: string;
    unconfiguredHint?: string;
    configuredScore?: number;
    unconfiguredScore?: number;
    includeStatusLine?: boolean;
    resolveConfigured: (params: { cfg: unknown; accountId: string }) => boolean;
  }

  export interface ChannelSetupWizard {
    channel: string;
    status: ChannelSetupWizardStatus;
    /** 解析配置时使用哪个账户 ID：无账户时默认 'default' */
    resolveAccountIdForConfigure?: (params: {
      cfg: unknown;
      prompter: unknown;
      options?: unknown;
      accountOverride?: string;
      shouldPromptAccountIds: boolean;
      listAccountIds: (cfg: unknown) => string[];
      defaultAccountId: string;
    }) => string | Promise<string>;
    resolveShouldPromptAccountIds?: (params: {
      cfg: unknown;
      options?: unknown;
      shouldPromptAccountIds: boolean;
    }) => boolean;
    credentials?: Array<{ id: string; label: string }>;
    textInputs?: Array<{ id: string; label: string; placeholder?: string }>;
    onStatusChange?: (params: { cfg: unknown }) => void | Promise<void>;
    configure?: (params: { cfg: unknown; accountId: string; prompter: unknown; runtime: unknown }) => Promise<unknown>;
    finalize: (params: { cfg: unknown; accountId: string; prompter: unknown; runtime: unknown }) => Promise<unknown>;
    enable?: (cfg: unknown) => unknown;
    disable?: (cfg: unknown) => unknown;
  }

  export function createStandardChannelSetupStatus(
    opts: ChannelSetupWizardStatus,
  ): ChannelSetupWizardStatus;

  export function setSetupChannelEnabled(
    cfg: unknown,
    channel: string,
    enabled: boolean,
  ): void;

  export const DEFAULT_ACCOUNT_ID: string;
}

declare module "openclaw/plugin-sdk/setup-tools" {
  export function formatDocsLink(href: string, text?: string): string;
}

declare module "openclaw/plugin-sdk/approval-runtime" {
  export interface ExecApprovalReplyMetadata {
    approvalId: string;
    approvalSlug: string;
    allowedDecisions?: string[];
  }
  export type ExecApprovalRequest = import("openclaw/plugin-sdk").ExecApprovalRequest;
  export type ExecApprovalResolved = import("openclaw/plugin-sdk").ExecApprovalResolved;
  export type PluginApprovalRequest = import("openclaw/plugin-sdk").PluginApprovalRequest;
  export type PluginApprovalResolved = import("openclaw/plugin-sdk").PluginApprovalResolved;
  export function getExecApprovalReplyMetadata(payload: { channelData?: unknown }): ExecApprovalReplyMetadata | null;
}

declare module "openclaw/plugin-sdk/core" {
  export type OpenClawConfig = import("openclaw/plugin-sdk").OpenClawConfig;
  export type ChannelPlugin<TAccount = unknown> =
    import("openclaw/plugin-sdk").ChannelPlugin<TAccount>;

  export const applyAccountNameToChannelSection: typeof import("openclaw/plugin-sdk")
    .applyAccountNameToChannelSection;
  export const deleteAccountFromConfigSection: typeof import("openclaw/plugin-sdk")
    .deleteAccountFromConfigSection;
  export const setAccountEnabledInConfigSection: typeof import("openclaw/plugin-sdk")
    .setAccountEnabledInConfigSection;

  // 允许其它 core 导出被逐步补齐（避免引入大量严格类型时频繁改代码）
  export * from "openclaw/plugin-sdk";
}

declare module "openclaw/plugin-sdk/gateway-runtime" {
  export interface EventFrame {
    event: string;
    payload: unknown;
  }

  export interface GatewayClient {
    start: () => void | Promise<void>;
    stop: () => void | Promise<void>;
    request: (method: string, params: unknown) => Promise<unknown>;
  }

  export function createOperatorApprovalsGatewayClient(options: {
    config: import("openclaw/plugin-sdk").OpenClawConfig;
    gatewayUrl?: string;
    clientDisplayName?: string;
    onEvent: (evt: EventFrame) => void;
    onHelloOk?: () => void;
    onConnectError?: (err: { message: string }) => void;
    onClose?: (code: number, reason: string) => void;
  }): Promise<GatewayClient>;
}
