import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  buildMiniMaxTTSRequest,
  createMiniMaxTTSProvider,
  parseMiniMaxTTSResponse,
  resolveMiniMaxTTSConfig,
} from '../src/outbound/tts-provider.js';

const config = {
  channels: {
    qqbot: {
      tts: {
        provider: 'minimax-speech',
        region: 'cn_zh',
        voice: 'test-voice',
        outputFormat: 'flac',
        languageBoost: 'auto',
      },
    },
  },
  models: {
    providers: {
      'minimax-speech': {
        apiKey: 'test-key',
        models: [{ id: 'speech-2.6-turbo' }],
        endpoints: [
          { region: 'global_en', url: 'https://api.minimax.io/v1/t2a_v2' },
          { region: 'cn_zh', url: 'https://api.minimaxi.com/v1/t2a_v2' },
        ],
      },
    },
  },
};

const resolved = resolveMiniMaxTTSConfig(config);
assert.ok(resolved);
assert.equal(resolved.endpoint, 'https://api.minimaxi.com/v1/t2a_v2');
assert.equal(resolved.model, 'speech-2.6-turbo');
assert.equal(resolved.outputFormat, 'flac');
assert.deepEqual(resolved.voiceSetting, { voice_id: 'test-voice' });

const defaultEndpoint = resolveMiniMaxTTSConfig({
  channels: { qqbot: { tts: { provider: 'minimax', region: 'global_en' } } },
  models: { providers: { minimax: { apiKey: 'test-key' } } },
});
assert.equal(defaultEndpoint?.endpoint, 'https://api.minimax.io/v1/t2a_v2');
assert.equal(defaultEndpoint?.model, 'speech-2.8-hd');

assert.equal(resolveMiniMaxTTSConfig({
  channels: { qqbot: { tts: { provider: 'minimax', endpoint: 'https://example.com/v1/t2a_v2' } } },
  models: { providers: { minimax: { apiKey: 'test-key' } } },
}), null);

const request = buildMiniMaxTTSRequest(resolved, 'hello');
assert.deepEqual(request, {
  model: 'speech-2.6-turbo',
  text: 'hello',
  stream: false,
  output_format: 'hex',
  audio_setting: { format: 'flac' },
  voice_setting: { voice_id: 'test-voice' },
  language_boost: 'auto',
});

assert.deepEqual(
  parseMiniMaxTTSResponse({
    data: { audio: '52494646', status: 2 },
    base_resp: { status_code: 0 },
  }),
  { audio: '52494646', status: 2 },
);
assert.throws(
  () => parseMiniMaxTTSResponse({ base_resp: { status_code: 1001, status_msg: 'invalid request' } }),
  /invalid request/,
);

let capturedUrl = '';
let capturedBody: Record<string, unknown> | undefined;
const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
  capturedUrl = String(input);
  capturedBody = JSON.parse(String(init?.body));
  return new Response(JSON.stringify({
    data: { audio: '52494646', status: 2 },
    base_resp: { status_code: 0 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const provider = createMiniMaxTTSProvider(config, { fetch: fakeFetch });
assert.ok(provider);
const audioPath = await provider.textToSpeech({ text: 'hello' });
assert.ok(audioPath);
assert.equal(capturedUrl, 'https://api.minimaxi.com/v1/t2a_v2');
assert.equal(capturedBody?.model, 'speech-2.6-turbo');
assert.deepEqual(await fs.readFile(audioPath), Buffer.from('52494646', 'hex'));
await fs.rm(path.dirname(audioPath), { recursive: true });

console.log('MiniMax TTS provider tests passed');
