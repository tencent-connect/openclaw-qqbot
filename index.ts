/**
 * @tencent-connect/openclaw-qqbot
 *
 * 独立版 QQ Bot 通道插件 — 基于 @tencent-connect/qqbot-nodejs SDK 重构。
 *
 * 直接依赖：
 * - openclaw/plugin-sdk：OpenClaw 插件框架
 * - @tencent-connect/qqbot-nodejs：QQ 开放平台 Node.js SDK
 */
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { emptyPluginConfigSchema } from 'openclaw/plugin-sdk/core';

import { qqbotPlugin } from './src/channel.js';
import { setQQBotRuntime } from './src/runtime.js';
import { registerPlatformTool } from './src/tools/platform.js';
import { registerRemindTool } from './src/tools/remind.js';
import { verifyRuntimeContract } from './src/adapter/contract.js';

let registered = false;

const plugin = {
  id: 'openclaw-qqbot',
  name: 'QQ Bot',
  description: 'QQ Bot channel plugin',
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setQQBotRuntime(api.runtime);

    if (!registered) {
      registered = true;
      const contract = verifyRuntimeContract(api.runtime);
      if (!contract.ok) {
        throw new Error(
          `openclaw-qqbot incompatible with openclaw ${contract.version}: ` +
          `missing required APIs: ${contract.missing.join(', ')}. ` +
          `Please upgrade openclaw or downgrade the plugin.`,
        );
      }
    }

    api.registerChannel({ plugin: qqbotPlugin as any });
    registerPlatformTool(api);
    registerRemindTool(api);
  },
};

export default plugin;

// ── Public API exports ──

export { qqbotPlugin } from './src/channel.js';
export { setQQBotRuntime, getQQBotRuntime } from './src/runtime.js';
export { getBotForAccount, tryGetBotForAccount, buildUserAgent } from './src/bot-instance.js';
export { qqbotOnboardingAdapter } from './src/features/onboarding.js';
export { QQBotGateway } from './src/gateway/index.js';
export { sendText, sendMedia } from './src/outbound/outbound-service.js';
export { parseTarget } from './src/outbound/target.js';
export { dispatchToOpenClaw } from './src/dispatch/index.js';
export {
  PersistedRefIndexStore,
  getPersistedRefIndexStore,
  flushAllRefIndexStores,
} from './src/features/ref-index-store.js';
export {
  StreamingController,
  shouldUseStreaming,
} from './src/outbound/streaming-controller.js';
export * from './src/types.js';
export * from './src/config.js';
