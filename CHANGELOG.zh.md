# 更新日志

本文件记录项目的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/)。

## [2.0.4] - 2026-09-11

### 新增

- **Send-only 网关降级**：出站 `sendText` / `sendMedia` / `sendVoice` / `sendVideo` 在机器人未运行时懒加载构建 send-only 网关（不含中间件、会话与引用索引），缓存复用，并在无网关日志时回退到真实 logger。

### 变更

- **拆分 dispatch 投递通道**：启用 block streaming，将 static-blocks / native-stream 投递拆分到独立的 `dispatch-deliver` 通道，新增 reply-options 事件订阅。
- **`send-proactive` 脚本**：更新为指向迁移后的 `features/proactive` 模块。
- **README**：安装/升级流程改为基于交互式向导（`npx -y @tencent-connect/openclaw-qqbot-cli@latest`）。

### 改进

- **调试日志**：在 debug 日志中预览出站文本，便于排查问题。

### 修复

- **升级脚本**：安装/更新时传递 `--accept-capabilities` 参数，适配 OpenClaw 2026.8.0+ 引入的 capability consent 校验（此前会报 "requires capability consent" 失败）。

### 移除

- 移除 README 中的 Star History 图表。

---

## [2.0.3] - 2026-08-25

### 修复

- 修复 `/bot-version` 指令仍返回旧 GitHub 仓库地址的问题。
- 同步 `upgradeUrl` 配置项文档中的默认升级指引链接。

---

## [2.0.2] - 2026-08-25

### 修复

- 修复 `/bot-upgrade` 升级指引链接。

---

## [2.0.1] - 2026-08-09

### 改进

- 优化消息调度流程，提升调度稳定性与异常处理能力。
- 放宽运行时能力校验，增强对不同 OpenClaw 版本的兼容性。

---

## [2.0.0] - 2026-07-13

### 新增

- **模块化分层架构**：代码重构为 12 个子模块（adapter / dispatch / gateway / middleware / outbound / transport 等），提升可维护性和扩展性。
- **Runtime Adapter**：新增运行时适配层，支持多版本 OpenClaw SDK 自动适配，兼容低版本 OpenClaw。
- **出站流水线**：统一出站分发管道（TTS 语音 → 媒体 → 文本 debounce），新增流式控制器、回复限速、出站文本清理（剥离 thinking 标签）。
- **中间件层**：新增访问控制、附件处理、策略注入三个中间件，支持灵活编排。
- **新增斜杠指令**：`/bot-pairing`（QR 码配对）。

### 变更

- 构建方式改为 `tsup` 预编译（`dist/index.cjs`），提升加载速度。
- `qqbot_channel_api` 工具重命名为 `qqbot_platform_api`。
- 依赖升级：`@tencent-connect/qqbot-connector` 1.2.0，新增 `@tencent-connect/qqbot-nodejs ^1.0.3`。

### 改进

- 启动时 runtime contract 预检，提前发现 API 缺失。
- 统一日志体系（`PluginLogger`），支持前缀分级。
- 新增 Markdown 表格分块和文本清理单元测试。

---

## [1.7.2] - 2026-06-05

### 新增

- **Webhook 传输模式**：新增 HTTP 回调入站方式，与 WebSocket 并列为两种可选传输模式。支持 Ed25519 签名鉴权，多账户场景下基于签名自动路由到对应账户。
- **群聊 @触发规则灵活配置**：新增账户级 `defaultRequireMention` 字段，形成「具体群 > 通配符 `*` > 账户级 > 默认值」四级优先级链，可针对不同群设置仅@回复或自主发言。
- **`/bot-group-allways` 指令**：运行时动态切换群响应模式（`on` / `off`），修改即时持久化到 `openclaw.json`，无需重启网关。

## [1.7.1] - 2026-04-10

### 修复

- **升级脚本适配OpenClaw 2026.4.9版本**：
  - 修复独立版插件安装失败问题。
  - 修复独立版与融合版兼容问题。
  - 新增通道配置自动修复（`additional properties` 校验错误）

### ⚠️ OpenClaw 2026.4.5 注意事项

OpenClaw 2026.4.5 对通道配置引入了严格的合法性校验，流式输出、群聊等独立插件扩展的新增的配置字段会被判定为非法属性，导致 gateway 无法启动。升级脚本已自动备份原配置并移除不被识别的字段以恢复启动。如需使用流式输出、群聊等独立插件专属能力，建议将 OpenClaw 降级到 2026.4.2 及以下版本。

## [1.7.1] - 2026-04-03

### 新增

- **命令执行审批**：AI 执行命令前通过 QQ 消息发送带按钮（✅ 允许一次 / ⭐ 始终允许 / ❌ 拒绝）的审批请求，用户点击按钮即可完成审批。
- **`/bot-approve` 指令**：新增审批配置管理指令，支持 `on`（打开白名单模式审批）、`off`（关闭审批）、`always`（严格模式）、`reset`（恢复默认）、`status`（查看配置）。

## [1.7.0] - 2026-04-02

### 新增

- **消息引用优化**：支持解析 QQ 消息事件中新增的引用消息字段，换设备也支持引用，使 AI 能够感知用户在回复哪条消息，从而在对话中准确理解引用上下文、实现更连贯的回复。
- **`qqbot-upgrade` Skill**：新增插件升级引导 Skill，支持自然语言触发版本更新；优化 Skill 升级交互体验。

### 修复

- **Windows 文件路径编码异常**：修复 Windows 下路径编码异常导致文件无法正常发送的问题。

### 变更

- **升级脚本重构 v4**：重构降级架构，兼容OpenClaw 2026.3.31版本，提升升级流程的稳定性与兼容性。

### ⚠️ 特别注意：OpenClaw 2026.3.31 内置插件冲突

OpenClaw 于 2026.3.31 版本起已内置 QQBot 插件。若直接将 OpenClaw 升级到最新版，可能与独立插件产生冲突，导致新增功能不可用。

**解决方案（二选一）：**

**方案一：使用升级脚本更新本插件到最新版**（推荐）

本版本已适配内置插件冲突，升级后自动接管优先级：

```bash
curl -fsSL https://raw.githubusercontent.com/tencent-connect/openclaw-qqbot/main/scripts/upgrade-via-npm.sh | bash
```

**方案二：通过配置禁用内置版本**

可通过以下命令禁用 OpenClaw 内置的 QQBot 插件：

```bash
openclaw config set plugins.entries.qqbot.enabled false
```

## [1.6.7] - 2026-03-30

### 修复

- **多账户提醒投递失败**：修复 cron 任务 delivery 缺少 `accountId`，导致多账户场景下提醒消息无法通过正确的机器人账户发送。`accountId` 改为必填，使用 `getRequestAccountId() || "default"` 确保永不为空；delivery 结构迁移到 job 顶层。
- **升级脚本与 `/bot-upgrade` 改进**：完善 `--version` 参数解析逻辑，优化版本检查流程；升级脚本（npm/source）增强兼容性。
- **`postinstall-link-sdk` 脚本优化**：改进安装后 SDK 链接脚本的健壮性。

### 升级方式

执行此指令可以升级为最新版：

```bash
curl -fsSL https://raw.githubusercontent.com/tencent-connect/openclaw-qqbot/main/scripts/upgrade-via-npm.sh | bash
```

> ⚠️ v1.6.6 及以下版本暂不支持通过 `/bot-upgrade` 执行热更新，请使用上述命令进行升级。

## [1.6.6] - 2026-03-26

### 新增

- **大文件分片上传**：新增 `chunked-upload.ts` 模块，支持对大文件自动分片并行上传，包含分片级重试、进度回调和超时控制。同时支持 C2C 和群聊场景。
- **`/bot-clear-storage` 指令**：新增存储清理指令，可清理插件本地缓存数据。
- **文件下载 SSRF 防护**：新增 `ssrf-guard.ts` 模块，下载远程文件前对 URL 做 DNS 解析并校验 IP，拒绝内网/保留网段地址，防止模型输出的恶意链接触达内网服务。

### 变更

- **下载目录按账户/对话隔离**：附件下载路径从统一的 `~/.openclaw/media/qqbot/downloads/` 改为 `downloads/{appId}/{peerId}/`，按账户和对话隔离，避免多账户文件互相覆盖。
- **附件下载失败提示优化**：下载失败时区分"超时"和"失败"，给模型更明确的上下文提示。

## [1.6.5] - 2026-03-24

### OpenClaw 3.23 兼容适配

OpenClaw 3.23 在 CLI 启动时引入了严格配置校验——任何 `openclaw` 子命令（包括 `plugins install`、`plugins update`、`gateway stop`）执行前都会校验整个 `openclaw.json`。由于 `channels.qqbot` 是本插件注册的（非内置 channel id），当插件尚未加载时执行这些命令会报 `"Config invalid: unknown channel id: qqbot"` 直接失败（鸡生蛋问题）。

本版本对所有升级路径进行了 3.23+ 适配：

- **CLI 命令前配置暂存/恢复**：`upgrade-via-npm.sh` 和 `upgrade-via-source.sh` 在执行任何 openclaw CLI 命令前临时移除 `channels.qqbot`，完成后恢复。
- **安装前预停 Gateway**：`upgrade-via-source.sh` 在 `plugins install` 前先停止 gateway，防止 chokidar 在配置中间状态（`channels.qqbot` 已移除）时触发 restart，避免同样的校验错误。

### 修复

- **启动问候 marker 路径**：修复 marker 目录使用 `$CMD` 变量替代硬编码路径，支持多 CLI 环境。

### 变更

- **静默非升级启动问候**：启动问候仅在 `/bot-upgrade` 热更新触发时发送，常规 gateway 重启不再发送，减少消息干扰。

## [1.6.4] - 2026-03-20

### 新增

- **一键热更新指令 `/bot-upgrade`**：在私聊中直接完成版本升级，无需登录服务器。支持 `--latest`（升级到最新）、`--version X`（指定版本）、`--force`（强制重装）参数。升级前自动校验版本是否存在于 npm。
- **频道 API 代理工具 `qqbot_channel_api`**：AI 可直接调用 QQ 开放平台频道 HTTP 接口，自动 Token 鉴权，内置 SSRF 防护。支持频道/子频道管理、成员查询、论坛发帖、公告发布、日程管理等操作。
- **凭证备份保护**：新增 `credential-backup.ts` 模块，热更新前自动备份 `appId`/`clientSecret` 到独立文件。`isConfigured` 增加备份兜底检查——配置丢失但备份存在时仍可启动并自动恢复凭证。
- **指令用法查询**：所有斜杠指令支持 `?` 后缀查看详细用法（如 `/bot-upgrade ?`）。

### 变更

- **版本检查改为实时查询**：`getUpdateInfo()` 从同步缓存改为 `async` 实时请求 npm registry，每次调用 `/bot-version` 或 `/bot-upgrade` 都拿最新数据。
- **`/bot-logs` 支持多日志源聚合**：超长日志自动截断并附带说明。

### 改进

- **`switchPluginSourceToNpm` 写后校验**：写回 `openclaw.json` 前验证 `channels.qqbot` 数据未被破坏，防止竞态写入导致凭证丢失。
- **升级脚本增加凭证备份逻辑**：`upgrade-via-npm.sh` 和 `upgrade-via-source.sh` 升级前自动保存凭证快照。

## [1.6.3] - 2026-03-18

### 变更

- **版本检查改用 HTTPS 原生请求 + 多 registry 兜底**：使用 HTTPS 直接请求 npm registry API 替代 `npm view` CLI 调用；支持 npmjs.org → npmmirror.com 自动降级，解决国内网络环境下版本检查失败的问题。
- **升级脚本多 registry 兜底**：`upgrade-via-npm.sh` 现在依次尝试 npmjs.org → npmmirror.com → 默认 registry，提升受限网络下的升级可靠性。

## [1.6.2] - 2026-03-18

### 变更

- **Markdown 感知文本分块**：使用 SDK 内置 `chunkMarkdownText` 替代自定义分块函数，支持代码块自动关闭/重开、括号感知等。
- **启用块流式（blockStreaming）**：设置 `blockStreaming: true`，框架收集流式响应后通过 `deliver` 回调统一发送。
- **降低文本分块上限**：`textChunkLimit` 从 20000 调整为 5000，提升消息可读性。
- **静默媒体发送错误**：图片/语音/视频/文件发送失败时仅写日志，不再向用户展示错误提示。

### 改进

- **引用内容不再截断**：移除存储引用消息时的 `MAX_CONTENT_LENGTH` 截断，保留完整消息原文。

### 移除

- 移除 `user-messages.ts` 中的 `MSG` 常量和 `formatMediaErrorMessage` 函数——插件层不再生成面向用户的错误提示。

## [1.6.1] - 2026-03-18

### 改进

- **升级脚本自动重启**：`upgrade-via-npm.sh` 升级完成后自动重启网关，使新版本立即生效。
- **提高文本分块上限**：`textChunkLimit` 从 2000 提升至 20000，允许更长的消息不被拆分发送。
- **移除主动推送更新通知**：不再在检测到新版本时主动推送通知给管理员，版本信息仅通过 `/bot-version` 和 `/bot-upgrade` 指令被动查询，减少消息打扰。

### 移除

- 移除 `update-checker.ts` 中的 `onUpdateFound` 回调和 `formatUpdateNotice` 辅助函数（主动推送移除后不再需要）。

## [1.6.0] - 2026-03-16

### 新增

- **斜杠指令体系**：新增 `/bot-ping`、`/bot-version`、`/bot-help`、`/bot-upgrade`、`/bot-logs` 五个插件级指令。
- **版本检查**：后台定时检查 npm 最新版本，`/bot-version` 展示更新状态，`/bot-upgrade` 提供升级指引。
- **启动问候语**：区分首次安装与普通重启，发送不同问候语。
- **日志下载**：`/bot-logs` 打包最近 2000 行日志发送文件给用户。

### 变更

- **统一富媒体标签**：将 `<qqimg>`、`<qqvoice>`、`<qqfile>`、`<qqvideo>` 统一为 `<qqmedia>` 标签，系统根据文件扩展名自动识别媒体类型。

### 改进

- **问候语防抖**：60s 内重复重启不再重复发送问候语（解决升级过程中刷屏问题）。
- **主动消息 48h 过滤**：发送启动问候前过滤超过 48h 未交互的用户，减少无效 500 错误。
- **Token 缓存刷新阈值**：从硬编码 5 分钟改为 `min(5min, remaining/3)`，修复短有效期 token 缓存失效导致每分钟重复请求的问题。
- **精简上下文注入**：优化注入给 OpenClaw 的上下文信息，减少冗余内容，降低 token 消耗。

## [1.5.7] - 2026-03-12

### 新增

- 新增 QQ `REFIDX_*` 引用消息上下文链路：从入站事件解析引用索引，缓存入站/出站消息摘要，并将引用内容注入 agent 上下文。
- 新增引用索引持久化存储（`~/.openclaw/qqbot/data/ref-index.jsonl`）：采用内存缓存 + JSONL 追加写，支持重启恢复、7 天 TTL 淘汰与 compact 压缩。
- 新增结构化引用附件摘要（图片/语音/视频/文件、local path/url、语音转录来源），提升引用回复语义完整性。

### 改进

- 机器人回复在可用时自动挂载对当前用户消息的引用，提升 QQ 会话串联可读性。

## [1.5.6] - 2026-03-10

### 新增

- 新增语音输入汇总日志，包含 STT/ASR/fallback 来源计数和 ASR 文本预览，便于调试语音处理链路。
- 新增 `asr_refer_text` 兜底支持——当 STT 未配置或转写失败时，使用 QQ 平台内置 ASR 文本作为低置信度兜底。
- 向 agent 上下文传递语音相关元数据（`QQVoiceAsrReferTexts`、`QQVoiceTranscriptSources`、`QQVoiceInputStrategy` 等）。
- README 新增定时提醒（主动消息）功能说明及演示截图。
- 统一 `appId` 解析逻辑，同时支持数值和字符串类型（涵盖运行时和主动消息脚本）。

### 修复

- 修复语音 prompt 提示，区分 STT 已配置/未配置状态，并增加 ASR 兜底和语音转发引导说明。

## [1.5.5] - 2026-03-09

### 新增

- 新增 `npm-upgrade.sh` 脚本，支持通过 npm 包安装和升级插件。
  - 支持 `--tag` 和 `--version` 选项，默认安装 `@alpha`。
  - 自动处理通道配置备份/恢复、旧插件清理（包括 `qqbot`、`@sliverp/qqbot`、`openclaw-qqbot`、"@tencent-connect/openclaw-qqbot" 等历史版本）、网关重启。
  - 安装前临时移除 `channels.qqbot` 配置，避免 `unknown channel id` 校验错误。

### 修复

- 修复插件 ID 与包名不一致导致插件加载失败的问题。
- 修复 `normalizeTarget` 返回类型——现在返回结构化的 `{ok, to, error}` 对象。
- 修复 `pull-latest.sh` 和 `upgrade.sh` 中过时的仓库 URL 引用。
- 修复 `proactive-api-server.ts` / `send-proactive.ts` 中硬编码的配置文件路径。
- 修复 `set-markdown.sh` 的 `read` 命令缺少超时参数，在非交互式环境下导致挂起的问题。

### 改进

- 脚本现已完全兼容多种 CLI（openclaw / clawdbot / moltbot），支持自动检测配置文件路径。
- `upgrade-and-run.sh` 首次运行时若缺少 AppID/Secret，现在会显示清晰的提示。
- `upgrade-and-run.sh` 升级前后现在会显示 qqbot 插件版本号。

## [1.5.4] - 2026-03-08

### 修复

- 修复多账户并发模式下的 Token 冲突——将全局 Token 缓存从单一变量重构为按 `appId` 隔离的 `Map`，解决多机器人同时运行时的 `11255 invalid request` 错误。
- 按实例独立刷新后台 Token——`clearTokenCache()` 和 `stopBackgroundTokenRefresh()` 现在接受 `appId` 参数，实现各账户独立管理。
- 修复非默认账户使用 `openclaw message send` 发送失败的问题——不指定 `--account` 时 `accountId` 始终回退到 `"default"`，导致向其他机器人的 OpenID 发消息时返回 500 错误。

### 新增

- 多账户配置文档——在 README 中新增"多账户配置"章节。
- 增强调试日志——`channel.ts` 中的日志添加 `[qqbot:channel]` 前缀，覆盖账户解析、消息发送和网关启动流程。
- API 日志前缀——所有 API 请求日志现在包含 `[qqbot-api:${appId}]` 前缀，方便多实例调试。

## [1.5.3] - 2026-03-06

### 修复

- 优化富媒体标签解析逻辑，提高识别成功率。
- 修复文件编码和特殊路径处理问题导致无法发送文件的问题。
- 修复消息 seq 号重复导致的间歇性消息丢失问题。

### 改进

- 升级脚本现在会在升级过程中自动备份和恢复 qqbot 通道配置。
- 更新 README，添加富媒体使用说明和插件配置/升级教程。

## [1.5.2] - 2026-03-05

### 新增

- 语音/文件发送能力，支持 TTS 文字转语音。
- 富媒体增强：上传缓存、视频支持、失败自动重试。
- 默认启用 Markdown 消息格式。
- 独立升级脚本，支持用户选择前台/后台启动。
