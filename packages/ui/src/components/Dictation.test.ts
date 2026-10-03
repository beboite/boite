import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { RpcErrorCode } from '@boite/contracts';
import { RpcFailure } from '../lib/client';
import { Store } from '../lib/store.svelte';
import { FakeClient } from '../lib/fake-client';
import Dictation from './Dictation.svelte';

const recorder = vi.hoisted(() => ({ ended: () => {}, stop: vi.fn(async () => new Uint8Array(3244)), dispose: vi.fn() }));
vi.mock('../lib/speech-recorder', () => ({
  SpeechRecorder: class {
    async start(_level: unknown, ended: () => void) { recorder.ended = ended; }
    stop = recorder.stop;
    dispose = recorder.dispose;
    async snapshot() { return null; }
    async takeChunk() { return null; }
  },
  audioBase64: () => 'AQ==', microphoneError: (error: Error) => error.message,
}));
let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (mounted) await unmount(mounted); mounted = undefined; document.body.innerHTML = ''; vi.clearAllMocks(); vi.unstubAllGlobals(); });

test('a microphone ending before speech status resolves finishes instead of sticking in recording', async () => {
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
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
  // The model started loading when the recording did; no preview ran, so the final request detects the language.
  expect(call).toHaveBeenCalledWith('speech.warm', {});
  expect(call).toHaveBeenLastCalledWith('speech.transcribe', { requestId: expect.any(String), revision: 'revision', audio: 'AQ==' });
  expect(document.querySelector('[data-testid="dictation"]')?.getAttribute('data-phase')).toBe('idle');
});

test('a core without the voice engine names the machine to update instead of the raw RPC error', async () => {
  const call = vi.fn(async () => { throw new RpcFailure({ code: RpcErrorCode.MethodNotFound, message: 'unknown method speech.status' }); });
  const onpreview = vi.fn();
  mounted = mount(Dictation, { target: document.body, props: {
    store: { client: { call }, connection: 'ready', owner: true, core: { hostname: 'build-box' } } as unknown as Store,
    ontext: vi.fn(), onbusy: vi.fn(), onpreview,
  } });
  flushSync();
  document.querySelector<HTMLButtonElement>('[data-testid="dictation-start"]')!.click();
  for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); }
  expect(document.querySelector('[data-testid="dictation"]')?.getAttribute('data-phase')).toBe('error');
  expect(onpreview).toHaveBeenLastCalledWith('', expect.stringContaining('newer Boite on build-box'), true);
  expect(JSON.stringify(onpreview.mock.calls)).not.toContain('unknown method');
});

test('cancelling a streaming finalization cancels its request and suppresses the late transcript', async () => {
  let finish!: (result: { text: string }) => void;
  const call = vi.fn((method: string) => method === 'speech.status'
    ? Promise.resolve({ ready: true, engine: 'local', streaming: true, revision: 'revision' })
    : method === 'speech.streamFinish' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true }));
  const ontext = vi.fn();
  mounted = mount(Dictation, { target: document.body, props: {
    store: { client: { call }, connection: 'ready', owner: true } as unknown as Store,
    ontext, onbusy: vi.fn(), onpreview: vi.fn(),
  } });
  flushSync(); document.querySelector<HTMLButtonElement>('[data-testid="dictation-start"]')!.click();
  for (let i = 0; i < 25; i++) { await Promise.resolve(); flushSync(); }
  document.querySelector<HTMLButtonElement>('[data-testid="dictation-stop"]')!.click();
  for (let i = 0; i < 25; i++) { await Promise.resolve(); flushSync(); }
  expect(call).toHaveBeenCalledWith('speech.streamFinish', expect.objectContaining({ sequence: 0 }));
  document.querySelector<HTMLButtonElement>('[data-testid="dictation-cancel"]')!.click();
  finish({ text: 'Too late.' });
  for (let i = 0; i < 25; i++) { await Promise.resolve(); flushSync(); }
  expect(call).toHaveBeenCalledWith('speech.cancel', expect.objectContaining({ requestId: expect.any(String) }));
  expect(ontext).not.toHaveBeenCalled();
  expect(document.querySelector('[data-testid="dictation"]')?.getAttribute('data-phase')).toBe('idle');
});


test('HTTP capabilities boot a real Store and fake core, then finish mounted dictation', async () => {
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  try {
    store.attach(client); await store.connect();
    expect(store.connection).toBe('ready');
    const status = await client.call('speech.status', {});
    const config = await client.call('speech.config', {});
    const changed = await client.call('speech.configure', { ...config, model: 'small-q5_1', modelPath: '/fixture/whisper-model.bin', language: 'french' });
    expect(changed.revision).not.toBe(status.revision);
    const ontext = vi.fn(), onpreview = vi.fn();
    mounted = mount(Dictation, { target: document.body, props: { store, ontext, onbusy: vi.fn(), onpreview } });
    flushSync();
    document.querySelector<HTMLButtonElement>('[data-testid="dictation-start"]')!.click();
    await vi.waitFor(() => { flushSync(); expect(document.querySelector('[data-testid="dictation"]')?.getAttribute('data-phase')).toBe('recording'); });
    document.querySelector<HTMLButtonElement>('[data-testid="dictation-stop"]')!.click();
    await vi.waitFor(() => { flushSync(); expect(ontext).toHaveBeenCalledWith('Please add a test for this change.'); });
    expect(document.querySelector('[data-testid="dictation"]')?.getAttribute('data-phase')).toBe('idle');
    // Entropy failures use the same visible recording error boundary.
    vi.stubGlobal('crypto', { getRandomValues: () => { throw new Error('Random source unavailable'); } });
    document.querySelector<HTMLButtonElement>('[data-testid="dictation-start"]')!.click();
    await vi.waitFor(() => { flushSync(); expect(document.querySelector('[data-testid="dictation"]')?.getAttribute('data-phase')).toBe('recording'); });
    document.querySelector<HTMLButtonElement>('[data-testid="dictation-stop"]')!.click();
    await vi.waitFor(() => { flushSync(); expect(document.querySelector('[data-testid="dictation"]')?.getAttribute('data-phase')).toBe('error'); });
    expect(onpreview).toHaveBeenLastCalledWith('', 'Random source unavailable', true);
    expect(ontext).toHaveBeenCalledOnce();
  } finally {
    if (mounted) { await unmount(mounted); mounted = undefined; }
    store.detach(); client.close();
  }
});
