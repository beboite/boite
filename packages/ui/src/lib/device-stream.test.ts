import { afterEach, expect, test, vi } from 'vitest';
import type { MobileDeviceStream } from '@boite/contracts';
import { playDeviceStream, type StreamFallback } from './device-stream';

afterEach(() => { vi.unstubAllGlobals(); });

function stubDecoder() {
  const decoded: string[] = [];
  class FakeChunk {
    type: string;
    constructor(init: { type: string }) { this.type = init.type; }
  }
  class FakeDecoder {
    static isConfigSupported = async (config: VideoDecoderConfig) => ({ supported: true, config });
    state = 'unconfigured'; decodeQueueSize = 0;
    configure() { this.state = 'configured'; }
    decode(chunk: FakeChunk) { decoded.push(chunk.type); }
    reset() { this.state = 'unconfigured'; }
    close() { this.state = 'closed'; }
  }
  vi.stubGlobal('VideoDecoder', FakeDecoder);
  vi.stubGlobal('EncodedVideoChunk', FakeChunk);
  return decoded;
}

const live = (chunks: MobileDeviceStream['chunks']): MobileDeviceStream => ({
  deviceId: 'phone', state: 'live', id: 'run', codec: 'avc1.42c01e', width: 72, height: 160, screen: { width: 1080, height: 2400 }, chunks,
});
const key = (seq: number) => ({ seq, key: true, pts: seq * 1000, base64: 'AAAAAWc=' });

test('a failed call clears once one answers, a chunk the browser cannot read restarts from a key frame, and anything unexpected falls back to screenshots', async () => {
  const decoded = stubDecoder();
  const asked: ({ id: string; seq: number } | undefined)[] = [];
  const events: string[] = [];
  const fallbacks: StreamFallback[] = [];
  const answers: (() => MobileDeviceStream)[] = [
    () => { throw new Error('the link dropped'); },
    // `%` is not base64: decoding that chunk throws in the player, not in the decoder.
    () => live([key(1), { seq: 2, key: false, pts: 2000, base64: '%%%' }]),
    () => live([key(3)]),
    // An answer that breaks the player's own assumptions.
    () => ({ ...live([]), chunks: undefined as unknown as MobileDeviceStream['chunks'] }),
  ];
  const player = playDeviceStream({
    ask: async (after) => {
      asked.push(after);
      const next = answers.shift();
      return next ? next() : new Promise<MobileDeviceStream>(() => {});
    },
    canvas: () => null,
    live: () => {},
    fallback: (reason) => { fallbacks.push(reason); },
    error: (message) => { events.push(`error: ${message}`); },
    ok: () => { events.push('ok'); },
  });
  await vi.waitFor(() => expect(fallbacks).toHaveLength(1), { timeout: 3000 });
  player.stop();

  expect(events).toEqual(['error: the link dropped', 'ok']);
  // The unreadable delta asked again from no chunk at all, which the core answers with its latest key frame.
  expect(asked.slice(1, 3)).toEqual([undefined, undefined]);
  expect(decoded).toEqual(['key', 'key']);
  expect(fallbacks[0]!.why).toBe('failed');
});
