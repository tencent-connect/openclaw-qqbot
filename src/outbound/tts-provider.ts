/**
 * TTS（文字转语音）集成接口
 *
 * audioAsVoice 语音回复能力：
 *   text → TTS → audioPath → SILK 转换 → Base64 → sendVoice
 *
 * 本模块定义接口和桥接逻辑。实际 TTS 引擎由 openclaw 框架的
 * tts-runtime 插件提供（通过 runtime 注入），本文件不内置 TTS 实现。
 */
import { convertSilkToWav } from '@tencent-connect/qqbot-nodejs/protocol';

/**
 * TTS Provider 接口（由框架注入或用户自定义）
 */
export interface TTSProvider {
  /** 文字转语音 → 返回本地音频文件路径（wav/mp3 等） */
  textToSpeech(params: { text: string; cfg?: unknown; channel?: string; accountId?: string }): Promise<string | null>;
  /** 音频文件 → SILK Base64（用于 QQ 发送） */
  audioFileToSilkBase64?(audioPath: string): Promise<string | null>;
}

/**
 * 从 runtime 尝试获取 TTS provider
 *
 * openclaw 框架通过 `runtime.channel.runtimeContexts` 或直接挂载 `runtime.tts`
 * 提供 TTS 能力。本函数做兼容性探测。
 */
export function resolveTTSProvider(runtime: any): TTSProvider | undefined {
  // 方式 1: runtime.tts (直接挂载)
  if (runtime?.tts?.textToSpeech) {
    return runtime.tts;
  }
  // 方式 2: channel runtime context 注册
  const tts = runtime?.channel?.runtimeContexts?.get?.('tts'); // @adapter-bypass: TTS 扩展点探测，非核心 channel API
  if (tts?.textToSpeech) {
    return tts;
  }
  return undefined;
}

/**
 * 将音频文件转换为 SILK Base64（QQ 语音消息格式）
 *
 * 如果 TTS provider 提供了 audioFileToSilkBase64，使用它；
 * 否则尝试直接读取文件返回 Base64（假设已经是 SILK 格式）。
 */
export async function audioToSilkBase64(
  audioPath: string,
  provider?: TTSProvider,
): Promise<string | null> {
  // 优先使用 provider 的转换方法
  if (provider?.audioFileToSilkBase64) {
    return provider.audioFileToSilkBase64(audioPath);
  }

  // Fallback：尝试 SDK 内置的 SILK 转换
  try {
    const { default: fs } = await import('node:fs');
    const buffer = fs.readFileSync(audioPath);
    return buffer.toString('base64');
  } catch {
    return null;
  }
}

/**
 * 完整的 TTS → SILK → Base64 流程
 *
 * 返回可以直接传给 sendVoice({ base64 }) 的 Base64 字符串。
 */
export async function textToVoiceBase64(
  text: string,
  provider: TTSProvider,
  opts?: { cfg?: unknown; accountId?: string },
): Promise<string | null> {
  const audioPath = await provider.textToSpeech({
    text,
    cfg: opts?.cfg,
    channel: 'qqbot',
    accountId: opts?.accountId,
  });
  if (!audioPath) return null;
  return audioToSilkBase64(audioPath, provider);
}
