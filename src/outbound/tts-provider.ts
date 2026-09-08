/**
 * TTS integration for the runtime-to-QQ voice pipeline.
 *
 * The runtime provider remains the preferred integration. When the runtime
 * does not expose one, MiniMax can be resolved from the OpenClaw model config
 * and used without changing the existing deliver pipeline.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * TTS Provider 接口（由框架注入或用户自定义）
 */
export interface TTSProvider {
  /** Convert text to speech and return a local audio path. */
  textToSpeech(params: { text: string; cfg?: unknown; channel?: string; accountId?: string }): Promise<string | null>;
  /** Convert an audio file to SILK Base64 for QQ, when the runtime supplies it. */
  audioFileToSilkBase64?(audioPath: string): Promise<string | null>;
}

const MINIMAX_SPEECH_MODELS = [
  'speech-2.8-hd',
  'speech-2.8-turbo',
  'speech-2.6-hd',
  'speech-2.6-turbo',
  'speech-02-hd',
  'speech-02-turbo',
  'speech-01-hd',
  'speech-01-turbo',
] as const;

const AUDIO_FORMATS = new Set(['mp3', 'wav', 'flac', 'pcm']);
const MINIMAX_SPEECH_ENDPOINTS = {
  global_en: 'https://api.minimax.io/v1/t2a_v2',
  cn_zh: 'https://api.minimaxi.com/v1/t2a_v2',
} as const;

export interface MiniMaxTTSConfig {
  apiKey: string;
  endpoint: string;
  model: string;
  outputFormat: 'mp3' | 'wav' | 'flac' | 'pcm';
  voiceSetting?: Record<string, unknown>;
  audioSetting?: Record<string, unknown>;
  languageBoost?: unknown;
  pronunciationDict?: unknown;
  voiceModify?: unknown;
  subtitleEnable?: boolean;
  timeoutMs: number;
}

/** Resolve the MiniMax provider, model, and regional endpoint from runtime config. */
export function resolveMiniMaxTTSConfig(cfg: unknown): MiniMaxTTSConfig | null {
  const root = asRecord(cfg);
  if (!root) return null;

  const channels = asRecord(root.channels);
  const qqbot = asRecord(channels?.qqbot);
  const channelTts = asRecord(qqbot?.tts);
  if (channelTts?.enabled === false) return null;

  const messages = asRecord(root.messages);
  const messageTts = asRecord(messages?.tts);
  const tts = channelTts ?? messageTts;
  if (tts?.enabled === false) return null;

  const models = asRecord(root.models);
  const providers = asRecord(models?.providers);
  const requestedProvider = readString(tts, 'provider');
  const providerId = requestedProvider ?? findMiniMaxProvider(providers);
  const provider = providerId ? asRecord(providers?.[providerId]) : undefined;

  const providerLooksLikeMiniMax = /minimax/i.test([
    providerId,
    readString(provider, 'name'),
    readString(provider, 'baseUrl'),
    readString(tts, 'endpoint'),
    readString(tts, 'baseUrl'),
  ].filter(Boolean).join(' '));
  if (!providerLooksLikeMiniMax) return null;

  const endpoint = resolveEndpoint(tts, provider);
  const apiKey = readString(tts, 'apiKey') ?? readString(provider, 'apiKey');
  if (!apiKey || !endpoint) return null;

  const model = readString(tts, 'model')
    ?? findConfiguredSpeechModel(provider)
    ?? MINIMAX_SPEECH_MODELS[0];
  const outputFormat = resolveOutputFormat(tts, provider);
  const voiceSetting = resolveObject(tts, 'voiceSetting')
    ?? resolveObject(provider, 'voiceSetting')
    ?? (readString(tts, 'voice') ? { voice_id: readString(tts, 'voice') } : undefined);
  const audioSetting = {
    ...(resolveObject(provider, 'audioSetting') ?? {}),
    ...(resolveObject(tts, 'audioSetting') ?? {}),
    format: outputFormat,
  };

  return {
    apiKey,
    endpoint,
    model,
    outputFormat,
    voiceSetting,
    audioSetting,
    languageBoost: tts?.languageBoost ?? provider?.languageBoost,
    pronunciationDict: tts?.pronunciationDict ?? provider?.pronunciationDict,
    voiceModify: tts?.voiceModify ?? provider?.voiceModify,
    subtitleEnable: readBoolean(tts, 'subtitleEnable') ?? readBoolean(provider, 'subtitleEnable'),
    timeoutMs: readNumber(tts, 'timeoutMs') ?? 30_000,
  };
}

/** Build the documented MiniMax HTTP request body. */
export function buildMiniMaxTTSRequest(config: MiniMaxTTSConfig, text: string): Record<string, unknown> {
  const request: Record<string, unknown> = {
    model: config.model,
    text,
    stream: false,
    output_format: 'hex',
    audio_setting: config.audioSetting,
  };
  if (config.voiceSetting) request.voice_setting = config.voiceSetting;
  if (config.languageBoost !== undefined) request.language_boost = config.languageBoost;
  if (config.pronunciationDict !== undefined) request.pronunciation_dict = config.pronunciationDict;
  if (config.voiceModify !== undefined) request.voice_modify = config.voiceModify;
  if (config.subtitleEnable !== undefined) request.subtitle_enable = config.subtitleEnable;
  return request;
}

/** Parse a synchronous or streamed MiniMax response and combine audio chunks. */
export function parseMiniMaxTTSResponse(payload: unknown): { audio: string; status?: number } {
  const entries = Array.isArray(payload) ? payload : [payload];
  let status: number | undefined;
  const chunks: string[] = [];
  for (const entry of entries) {
    const object = asRecord(entry);
    const baseResponse = asRecord(object?.base_resp);
    const statusCode = baseResponse?.status_code;
    if (statusCode !== undefined && Number(statusCode) !== 0) {
      const message = readString(baseResponse, 'status_msg') ?? 'MiniMax TTS request failed';
      throw new Error(message);
    }
    const data = asRecord(object?.data);
    const currentStatus = data?.status;
    if (typeof currentStatus === 'number') status = currentStatus;
    const audio = data?.audio;
    if (typeof audio === 'string' && audio.trim()) chunks.push(audio.trim());
  }
  if (chunks.length === 0) throw new Error('MiniMax TTS returned no audio');
  return { audio: chunks.join(''), status };
}

/** Create a MiniMax provider using the current OpenClaw runtime configuration. */
export function createMiniMaxTTSProvider(
  cfg: unknown,
  options: { fetch?: typeof fetch } = {},
): TTSProvider | undefined {
  const config = resolveMiniMaxTTSConfig(cfg);
  if (!config) return undefined;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return undefined;

  return {
    textToSpeech: async ({ text }) => {
      if (!text.trim()) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await fetchImpl(config.endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(buildMiniMaxTTSRequest(config, text)),
          signal: controller.signal,
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new Error(`MiniMax TTS failed (HTTP ${response.status}): ${detail.slice(0, 300)}`);
        }
        const parsed = parseMiniMaxTTSResponse(await response.json());
        const bytes = decodeAudio(parsed.audio);
        const extension = config.outputFormat === 'pcm' ? 'pcm' : config.outputFormat;
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-qqbot-tts-'));
        const audioPath = path.join(directory, `speech.${extension}`);
        await fs.writeFile(audioPath, bytes);
        return audioPath;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * 从 runtime 尝试获取 TTS provider
 *
 * openclaw 框架通过 `runtime.channel.runtimeContexts` 或直接挂载 `runtime.tts`
 * 提供 TTS 能力。本函数做兼容性探测。
 */
export function resolveTTSProvider(runtime: any, cfg?: unknown): TTSProvider | undefined {
  // 方式 1: runtime.tts (直接挂载)
  if (runtime?.tts?.textToSpeech) {
    return runtime.tts;
  }
  // 方式 2: channel runtime context 注册
  const tts = runtime?.channel?.runtimeContexts?.get?.('tts'); // @adapter-bypass: TTS 扩展点探测，非核心 channel API
  if (tts?.textToSpeech) {
    return tts;
  }
  return createMiniMaxTTSProvider(cfg);
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

function asRecord(value: unknown): Record<string, any> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
  return undefined;
}

function readString(object: Record<string, any> | undefined, key: string): string | undefined {
  const value = object?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readValueString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(object: Record<string, any> | undefined, key: string): number | undefined {
  const value = object?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readBoolean(object: Record<string, any> | undefined, key: string): boolean | undefined {
  return typeof object?.[key] === 'boolean' ? object[key] : undefined;
}

function resolveObject(object: Record<string, any> | undefined, key: string): Record<string, unknown> | undefined {
  return asRecord(object?.[key]) as Record<string, unknown> | undefined;
}

function findMiniMaxProvider(providers: Record<string, any> | undefined): string | undefined {
  if (!providers) return undefined;
  return Object.keys(providers).find((id) => {
    const provider = asRecord(providers[id]);
    return /minimax/i.test(`${id} ${readString(provider, 'name') ?? ''} ${readString(provider, 'baseUrl') ?? ''}`);
  });
}

function findConfiguredSpeechModel(provider: Record<string, any> | undefined): string | undefined {
  const models = provider?.models;
  if (!Array.isArray(models)) return undefined;
  for (const model of models) {
    const id = typeof model === 'string' ? model : readString(asRecord(model), 'id') ?? readString(asRecord(model), 'model');
    if (id && (MINIMAX_SPEECH_MODELS as readonly string[]).includes(id)) return id;
  }
  return undefined;
}

function resolveEndpoint(tts: Record<string, any> | undefined, provider: Record<string, any> | undefined): string | undefined {
  const region = readString(tts, 'region') ?? readString(provider, 'region');
  const configuredEndpoints = tts?.endpoints ?? provider?.endpoints ?? provider?.regionalEndpoints;
  if (Array.isArray(configuredEndpoints)) {
    const regional = configuredEndpoints.find((entry) => {
      const item = asRecord(entry);
      return !region || readString(item, 'region') === region;
    });
    const regionalUrl = readString(asRecord(regional), 'url') ?? readString(asRecord(regional), 'endpoint');
    if (regionalUrl) return normalizeEndpoint(regionalUrl);
  } else if (configuredEndpoints && typeof configuredEndpoints === 'object') {
    const endpoint = readValueString(asRecord(configuredEndpoints)?.[region ?? ''])
      ?? readValueString(asRecord(configuredEndpoints)?.global_en);
    if (endpoint) return normalizeEndpoint(endpoint);
  }
  return normalizeEndpoint(
    readString(tts, 'endpoint')
      ?? readString(tts, 'baseUrl')
      ?? readString(provider, 'baseUrl')
      ?? MINIMAX_SPEECH_ENDPOINTS[region === 'cn_zh' ? 'cn_zh' : 'global_en'],
  );
}

function normalizeEndpoint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const endpoint = value.replace(/\/+$/, '');
  const normalized = /\/t2a_v2$/i.test(endpoint)
    ? endpoint
    : /\/v1$/i.test(endpoint)
      ? `${endpoint}/t2a_v2`
      : `${endpoint}/v1/t2a_v2`;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'https:' || !['api.minimax.io', 'api.minimaxi.com'].includes(parsed.hostname)) return undefined;
  } catch {
    return undefined;
  }
  return normalized;
}

function resolveOutputFormat(tts: Record<string, any> | undefined, provider: Record<string, any> | undefined): MiniMaxTTSConfig['outputFormat'] {
  const requested = readString(tts, 'outputFormat') ?? readString(tts, 'audioFormat') ?? readString(provider, 'outputFormat');
  return requested && AUDIO_FORMATS.has(requested) ? requested as MiniMaxTTSConfig['outputFormat'] : 'wav';
}

function decodeAudio(audio: string): Buffer {
  if (/^[0-9a-f]+$/i.test(audio) && audio.length % 2 === 0) return Buffer.from(audio, 'hex');
  return Buffer.from(audio, 'base64');
}
