import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Store } from '../lib/store.svelte';
import Dictation from './Dictation.svelte';

const recorder = vi.hoisted(() => ({ ended: () => {}, stop: vi.fn(async () => new Uint8Array([1])), dispose: vi.fn() }));
vi.mock('../lib/speech-recorder', () => ({
  SpeechRecorder: class {
    async start(_level: unknown, ended: () => void) { recorder.ended = ended; }
    stop = recorder.stop;
    dispose = recorder.dispose;
    async snapshot() { return null; }
  },
  audioBase64: () => 'AQ==', microphoneError: (error: Error) => error.message,
}));
let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (mounted) await unmount(mounted); document.body.innerHTML = ''; vi.clearAllMocks(); });

test('a microphone ending before speech status resolves finishes instead of sticking in recording', async () => {
  let ready!: (status: object) => void;
  const call = vi.fn((method: string) => method === 'speech.status'
    ? new Promise(resolve => { ready = resolve; })
    : Promise.resolve({ text: 'Captured before unplugging.' }));
  const ontext = vi.fn();
  mounted = mount(Dictation, { target: document.body, props: {
    store: { client: { call }, connection: 'ready', owner: true } as unknown as Store,
    ontext, onbusy: vi.fn(), onpreview: vi.fn(),
  } });
  flushSync();
  document.querySelector<HTMLButtonElement>('[data-testid="dictation-start"]')!.click();
  await Promise.resolve(); flushSync();
  expect(document.querySelector('[data-testid="dictation"]')?.getAttribute('data-phase')).toBe('opening');
  recorder.ended(); ready({ ready: true, engine: 'local', revision: 'revision' });
  for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); }
  expect(recorder.stop).toHaveBeenCalledOnce();
  expect(ontext).toHaveBeenCalledWith('Captured before unplugging.');
  expect(document.querySelector('[data-testid="dictation"]')?.getAttribute('data-phase')).toBe('idle');
});
