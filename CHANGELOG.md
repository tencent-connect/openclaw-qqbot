# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [2.0.4] - 2026-09-11

### Added

- **Send-only gateway fallback**: Outbound `sendText` / `sendMedia` / `sendVoice` / `sendVideo` now lazily construct a send-only gateway (no middleware, session, or ref-index) when the bot is not running, caching it for reuse and falling back to a real logger when no gateway log exists.

### Changed

- **Dispatch delivery lanes refactor**: Enabled block streaming and split static-blocks / native-stream delivery into a dedicated `dispatch-deliver` lane, adding reply-options event subscription.
- **`send-proactive` script**: Updated to point at the relocated `features/proactive` module.
- **README**: Reworked the installation/upgrade flow around the interactive wizard (`npx -y @tencent-connect/openclaw-qqbot-cli@latest`).

### Improved

- **Debug logging**: Preview outbound text in debug logs to aid troubleshooting.

### Fixed

- **Upgrade scripts**: Pass `--accept-capabilities` on install/update for OpenClaw 2026.8.0+, which introduced capability consent validation (previously failed with "requires capability consent").

### Removed

- Removed the Star History chart from README.

---

## [2.0.3] - 2026-08-25

### Fixed

- Fixed the `/bot-version` command still returning an outdated GitHub repository URL.
- Synced the default upgrade guide URL in the `upgradeUrl` config documentation.

---

## [2.0.2] - 2026-08-25

### Fixed

- Fixed the `/bot-upgrade` upgrade guide link.

---

## [2.0.1] - 2026-08-09

### Improved

- Enhanced message dispatch stability with better handling and logging for skipped dispatches.
- Relaxed runtime capability checks for broader OpenClaw version compatibility.

---

## [2.0.0] - 2026-07-13

### Added

- **Modular Layered Architecture**: Refactored codebase into 12 sub-modules (adapter / dispatch / gateway / middleware / outbound / transport, etc.) for better maintainability and extensibility.
- **Runtime Adapter**: New runtime adaptation layer supporting automatic multi-version OpenClaw SDK compatibility, including older OpenClaw versions.
- **Outbound Pipeline**: Unified outbound delivery pipeline (TTS voice → media → text debounce) with streaming controller, reply rate limiter, and outbound text sanitization (strips thinking tags).
- **Middleware Layer**: Three new middlewares — access control, attachment processing, and policy injection — with flexible composition support.
- **New Slash Command**: `/bot-pairing` (QR code pairing).

### Changed

- Build switched to `tsup` pre-compilation (`dist/index.cjs`) for faster loading.
- `qqbot_channel_api` tool renamed to `qqbot_platform_api`.
- Dependency upgrades: `@tencent-connect/qqbot-connector` 1.2.0, added `@tencent-connect/qqbot-nodejs ^1.0.3`.

### Improved

- Runtime contract pre-check at startup to detect missing APIs early.
- Unified logging system (`PluginLogger`) with prefix levels.
- Added Markdown table chunking and text sanitization unit tests.

---

## [1.7.2] - 2026-06-05

### Added

- **Webhook Transport Mode**: Added HTTP webhook inbound transport alongside WebSocket as an alternative transport mode. Supports Ed25519 signature verification with automatic account routing for multi-account setups.
- **Flexible Group @Trigger Rules**: New account-level `defaultRequireMention` field introduces a 4-tier priority chain — per-group > wildcard `*` > account-level > default — allowing groups to be configured as @-only or autonomous.
- **`/bot-group-allways` Command**: Toggle group response mode at runtime (`on` / `off`). Changes are persisted to `openclaw.json` instantly; no gateway restart required.

## [1.7.1] - 2026-04-10

### Fixed

- **Upgrade script adapted for OpenClaw 2026.4.9**:
  - Fixed standalone plugin installation failure.
  - Fixed compatibility issues between the standalone and built-in plugin.
  - Added automatic channel config repair for `additional properties` validation errors.

### ⚠️ OpenClaw 2026.4.5 Notice

OpenClaw 2026.4.5 introduced strict validation for channel configurations. New config fields added by the standalone plugin — such as streaming output and group chat settings — are rejected as illegal properties, preventing the gateway from starting. The upgrade script now automatically backs up the original config and removes unrecognized fields to restore startup. If you need standalone-plugin-exclusive features like streaming output and group chat, downgrade OpenClaw to **2026.4.2 or earlier**.

## [1.7.1] - 2026-04-03

### Added

- **Command Execution Approval**: Before the AI executes a command, an approval request with Inline Keyboard buttons (✅ Allow Once / ⭐ Always Allow / ❌ Deny) is sent via QQ message. Users can approve or deny by tapping a button. Supports both C2C and group chat scenarios.
- **`/bot-approve` Command**: New slash command for managing approval configuration — supports `on` (allowlist mode), `off` (disable approval), `always` (strict mode), `reset` (restore defaults), and `status` (view current config).

## [1.7.0] - 2026-04-02

### Added

- **Message Reference Improvements**: Supports parsing the new quoted-message field in QQ message events — quoted context now works across devices, enabling the AI to understand which message a user is replying to and deliver more contextually coherent responses.
- **`qqbot-upgrade` Skill**: New guided upgrade Skill that supports natural-language version update requests; improved Skill upgrade interaction flow.

### Fixed

- **Windows file path encoding**: Fixed a path encoding issue on Windows that prevented files from being sent correctly.

### Changed

- **Upgrade script refactor v4**: Rebuilt the downgrade architecture for compatibility with OpenClaw 2026.3.31+, improving upgrade stability and reliability.

### ⚠️ Important: Built-in Plugin Conflict in OpenClaw 2026.3.31

Starting from OpenClaw 2026.3.31, a built-in QQBot plugin is included. Upgrading OpenClaw directly to the latest version without taking action may cause conflicts with this plugin, resulting in new features such as message reference parsing and large file uploads being unavailable.

**Resolution (choose one):**

**Option 1: Upgrade this plugin to the latest version** (recommended)

This release includes built-in conflict handling and will automatically take priority after upgrade:

```bash
curl -fsSL https://raw.githubusercontent.com/tencent-connect/openclaw-qqbot/main/scripts/upgrade-via-npm.sh | bash
```

**Option 2: Disable the built-in plugin via config**

Disable the OpenClaw built-in QQBot plugin with the following command:

```bash
openclaw config set plugins.entries.qqbot.enabled false
```

## [1.6.7] - 2026-03-30

### Fixed

- **Multi-account reminder delivery failure**: Fixed missing `accountId` in cron job delivery, causing reminders to fail sending through the correct bot account in multi-account setups. `accountId` is now required, using `getRequestAccountId() || "default"` to ensure it's never empty; delivery structure moved to job top level.
- **Upgrade scripts & `/bot-upgrade` improvements**: Fixed `--version` argument parsing logic, improved version check flow; upgrade scripts (npm/source) enhanced for better compatibility.
- **`postinstall-link-sdk` script optimization**: Improved robustness of the post-install SDK linking script.

### Upgrade

Run the following command to upgrade to the latest version:

```bash
curl -fsSL https://raw.githubusercontent.com/tencent-connect/openclaw-qqbot/main/scripts/upgrade-via-npm.sh | bash
```

> ⚠️ v1.6.6 and below do not support hot upgrade via `/bot-upgrade`. Please use the command above to upgrade.


## [1.6.6] - 2026-03-26

### Added

- **Large file chunked upload**: New `chunked-upload.ts` module that automatically splits large files into parallel uploads with per-part retry, progress callback, and timeout control. Supports both C2C and group scenarios.
- **`/bot-clear-storage` command**: New storage cleanup command for clearing plugin local cache data.
- **SSRF guard module `ssrf-guard.ts`**: Standalone SSRF protection utility that performs DNS resolution and IP validation before downloading remote files, blocking internal/reserved network addresses to prevent malicious URLs from reaching internal services.

### Changed

- **Download directory isolated by account/conversation**: Attachment download path changed from a shared `~/.openclaw/media/qqbot/downloads/` to `downloads/{appId}/{peerId}/`, isolating files by account and conversation to prevent multi-account file overwrites.
- **Attachment download failure messages improved**: Download failures now distinguish "timeout" vs. "failure", providing clearer context hints to the model.

## [1.6.5] - 2026-03-24

### OpenClaw 3.23 Compatibility

OpenClaw 3.23 introduced strict config validation at CLI startup — any `openclaw` subcommand (including `plugins install`, `plugins update`, `gateway stop`) now validates the entire `openclaw.json` before execution. Since `channels.qqbot` is registered by this plugin (not a built-in channel id), running these commands when the plugin is not yet loaded causes `"Config invalid: unknown channel id: qqbot"` and the command fails entirely (chicken-and-egg problem).

This release adapts all upgrade paths for 3.23+:

- **Config stash/restore for CLI commands**: `upgrade-via-npm.sh` and `upgrade-via-source.sh` temporarily remove `channels.qqbot` from `openclaw.json` before running any openclaw CLI command, then restore it after completion.
- **Gateway pre-stop before install**: `upgrade-via-source.sh` now stops the gateway before `plugins install` to prevent chokidar from triggering a restart on the intermediate config state (with `channels.qqbot` removed), which would also hit the validation error.

### Fixed

- **Startup greeting marker path**: Fixed marker directory to use `$CMD` variable instead of hardcoded path, supporting multi-CLI environments.

### Changed

- **Silence non-upgrade startup greeting**: Startup greeting is now suppressed unless triggered by a `/bot-upgrade` hot update, reducing noise during routine gateway restarts.

## [1.6.4] - 2026-03-20

### Added

- **One-click hot upgrade `/bot-upgrade`**: Upgrade the plugin directly from private chat — no server login needed. Supports `--latest` (upgrade to latest), `--version X` (specific version), and `--force` (force reinstall). Version existence is verified against npm before proceeding.
- **Channel API proxy tool `qqbot_channel_api`**: AI can call QQ Open Platform channel HTTP APIs directly with automatic Token authentication and SSRF protection. Supports guild/channel management, member queries, forum threads, announcements, schedules, and more.
- **Credential backup protection**: New `credential-backup.ts` module auto-saves `appId`/`clientSecret` to a standalone file before hot upgrade. `isConfigured` now falls back to backup check — if config is lost but backup exists, the account still starts and credentials are auto-restored.
- **Command usage help**: All slash commands support `?` suffix to show detailed usage (e.g. `/bot-upgrade ?`).

### Changed

- **Real-time version check**: `getUpdateInfo()` changed from synchronous cache to `async` live npm registry query — every `/bot-version` or `/bot-upgrade` call fetches the latest data.
- **`/bot-logs` multi-source aggregation**: Long logs are auto-truncated with explanation.

### Improved

- **`switchPluginSourceToNpm` post-write validation**: Verifies `channels.qqbot` data integrity before writing back to `openclaw.json`, preventing race-condition credential loss.
- **Upgrade scripts with credential backup**: `upgrade-via-npm.sh` and `upgrade-via-source.sh` now save credential snapshots before upgrading.

## [1.6.3] - 2026-03-18

### Changed

- **Update checker: HTTPS-native with multi-registry fallback**: Replaced `npm view` CLI call with direct HTTPS requests to npm registry API; supports automatic fallback from npmjs.org to npmmirror.com, solving network issues in mainland China.
- **Upgrade script multi-registry fallback**: `upgrade-via-npm.sh` now tries npmjs.org → npmmirror.com → default registry in sequence, improving upgrade reliability in restricted networks.

## [1.6.2] - 2026-03-18

### Changed

- **Markdown-aware text chunking**: Replaced custom `chunkText` with SDK built-in `chunkMarkdownText`, supporting auto code-fence close/reopen, bracket awareness, etc.
- **Enable block streaming**: Set `blockStreaming: true` — the framework now collects streamed responses and delivers via the `deliver` callback.
- **Reduce text chunk limit**: `textChunkLimit` lowered from 20000 to 5000 for better message readability.
- **Silent media errors**: Media send failures (image/voice/video/file) are now logged only; error messages are no longer surfaced to the user.

### Improved

- **Ref-index content untruncated**: Removed `MAX_CONTENT_LENGTH` cap when storing quoted-message content, preserving full message body in ref-index store.

### Removed

- `MSG` constants and `formatMediaErrorMessage` from `user-messages.ts` — plugin layer no longer generates user-facing error text.

## [1.6.1] - 2026-03-18

### Improved

- **Upgrade script auto-restart**: `upgrade-via-npm.sh` now automatically restarts the gateway after upgrade to apply the new version immediately.
- **Increase text chunk limit**: Raised `textChunkLimit` from 2000 to 20000, allowing longer messages to be sent without splitting.
- **Remove proactive update push**: Removed the auto-push notification to admin when a new version is detected; version info is now only available passively via `/bot-version` and `/bot-upgrade` commands, reducing noise.

### Removed

- `onUpdateFound` callback and `formatUpdateNotice` helper from `update-checker.ts` — no longer needed after removing proactive push.

## [1.6.0] - 2026-03-16

### Added

- **Slash command system**: `/bot-ping`, `/bot-version`, `/bot-help`, `/bot-upgrade`, `/bot-logs` — five plugin-level slash commands.
- **Update checker**: Background npm version check with update status in `/bot-version` and upgrade guide in `/bot-upgrade`.
- **Startup greeting**: Distinguish first install vs. restart with different greeting messages.
- **Log download**: `/bot-logs` packages the last 2000 lines of logs and sends as a file.

### Changed

- **Unified rich media tag**: Replaced `<qqimg>`, `<qqvoice>`, `<qqfile>`, `<qqvideo>` with a single `<qqmedia>` tag — the system auto-detects media type by file extension.

### Improved

- **Greeting debounce**: Suppress duplicate greetings within 60s during rapid restarts (e.g. upgrades).
- **Proactive message 48h filter**: Skip users inactive for 48h+ when sending startup greetings, reducing 500 errors.
- **Token cache refresh threshold**: Changed from hardcoded 5-minute early refresh to `min(5min, remaining/3)`, fixing repeated token requests when API returns short-lived tokens.
- **Streamlined context injection**: Reduced redundant context injected into OpenClaw, lowering token consumption.

## [1.5.7] - 2026-03-12

### Added

- Add quoted-message context pipeline for QQ `REFIDX_*`: parse quote indices from inbound events, cache inbound/outbound message summaries, and inject quote body into agent context.
- Add persistent quote index store (`~/.openclaw/qqbot/data/ref-index.jsonl`) with in-memory cache + JSONL append, restart recovery, 7-day TTL eviction, and compact.
- Add structured quote attachment summaries (image/voice/video/file, local path/url, voice transcript source) for better reply grounding.

### Improved

- Bot replies now attach quote reference to the user's current message when available, improving threaded conversation readability in QQ.

## [1.5.6] - 2026-03-10

### Added

- Add voice input summary log with STT/ASR/fallback source counters and ASR text preview for debugging voice pipeline.
- Add `asr_refer_text` fallback support — when STT is not configured or fails, use QQ platform's built-in ASR text as low-confidence fallback.
- Pass voice-related metadata (`QQVoiceAsrReferTexts`, `QQVoiceTranscriptSources`, `QQVoiceInputStrategy`, etc.) to agent context.
- Add scheduled reminder (proactive message) section to README with demo screenshot.
- Normalize `appId` parsing to support both numeric and string values across runtime and proactive scripts.

### Fixed

- Fix voice prompt hints to distinguish STT-configured vs. unconfigured states and add ASR fallback / voice forward guidance.

## [1.5.5] - 2026-03-09

### Added

- Add `npm-upgrade.sh` script for npm-based plugin installation and upgrade.
  - Supports `--tag` and `--version` options, defaults to `@alpha`.
  - Handles channel config backup/restore, old plugin cleanup (including legacy variants like `qqbot`, `@sliverp/qqbot`), and gateway restart.
  - Temporarily removes `channels.qqbot` before install to avoid `unknown channel id` validation error.

### Fixed

- Fix plugin id not matching package name, causing plugin load failure.
- Fix `normalizeTarget` return type — now returns structured `{ok, to, error}` object.
- Fix outdated repo URL references in `pull-latest.sh` and `upgrade.sh`.
- Fix `proactive-api-server.ts` / `send-proactive.ts` hardcoded config file paths.
- Fix `set-markdown.sh` `read` missing timeout causing hang in non-interactive environments.

### Improved

- Scripts now fully compatible with multiple CLIs (openclaw / clawdbot / moltbot) with auto-detection of config file paths.
- `upgrade-and-run.sh` now shows clear prompt when AppID/Secret is missing on first run.
- `upgrade-and-run.sh` now displays qqbot plugin version before and after upgrade.

## [1.5.4] - 2026-03-08

### Fixed

- Fix Token collision in multi-account concurrent mode — refactored global Token cache from a single variable to a per-`appId` `Map`, resolving `11255 invalid request` errors when multiple bots run simultaneously.
- Per-instance background Token refresh — `clearTokenCache()` and `stopBackgroundTokenRefresh()` now accept an `appId` parameter for independent per-account management.
- Fix `openclaw message send` failing for non-default accounts — without `--account`, `accountId` always fell back to `"default"`, causing a 500 error when sending to an OpenID belonging to a different bot.

### Added

- Multi-account documentation — added "Multi-Account Setup" section to README.
- Enhanced debug logging — `[qqbot:channel]` prefixed logs in `channel.ts`, covering account resolution, message sending, and gateway startup.
- API log prefix — all API request logs now include `[qqbot-api:${appId}]` prefix for easier multi-instance debugging.

## [1.5.3] - 2026-03-06

### Fixed

- Improved rich media tag parsing logic for higher recognition success rate.
- Fixed file encoding issues and special path handling that prevented file sending.
- Fixed intermittent message loss caused by duplicate message seq numbers.

### Improved

- Upgrade script now auto-backs up and restores qqbot channel config during upgrades.
- Updated README with rich media usage instructions and plugin config/upgrade tutorial.

## [1.5.2] - 2026-03-05

### Added

- Voice/file sending capability with TTS text-to-speech support.
- Rich media enhancements: upload caching, video support, automatic retry on failure.
- Markdown messages enabled by default.
- Standalone upgrade script with user choice of foreground/background startup.
