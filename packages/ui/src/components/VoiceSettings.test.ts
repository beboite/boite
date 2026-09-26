import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { RpcErrorCode, SPEECH_CATALOGUE, type SpeechConfig, type SpeechStatus } from '@boite/contracts';
import { RpcFailure } from '../lib/client';
import type { Store } from '../lib/store.svelte';
import VoiceSettings from './VoiceSettings.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (mounted) await unmount(mounted); mounted = undefined; document.body.innerHTML = ''; });

const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const models = (installed: string[] = []) => SPEECH_CATALOGUE.map(entry => ({ id: entry.id, kind: 'catalogue' as const, name: entry.name, bytes: entry.bytes, tier: entry.tier, installed: installed.includes(entry.id) }));
const status = (patch: Partial<SpeechStatus> = {}): SpeechStatus => ({
  revision: 'r1', engine: 'local', ready: false, localReady: false, groqKeySet: false, openrouterKeySet: false,
  installing: false, downloadedBytes: 0, totalBytes: 198279932, error: null, canInstallRuntime: true,
  models: models(), downloading: null, runtimeOutdated: false, ...patch,
});
const config: SpeechConfig = { engine: 'local', language: '', apiProvider: 'groq', fallback: false, executable: '', modelPath: '', model: 'small-q5_1' };
const show = (call: (method: string, params?: unknown) => Promise<unknown>) => {
  mounted = mount(VoiceSettings, { target: document.body, props: {
    store: { client: { call }, connection: 'ready', owner: true, core: { hostname: 'build-box' } } as unknown as Store,
  } });
};
const text = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';
const click = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click();

test('a core without the voice engine names the machine to update, not the raw RPC error', async () => {
  show(async () => { throw new RpcFailure({ code: RpcErrorCode.MethodNotFound, message: 'unknown method speech.status' }); });
  await settle();
  expect(document.querySelector('[data-testid="voice-status"]')?.getAttribute('data-state')).toBe('unsupported');
  expect(text('voice-status')).toContain('newer Boite on build-box');
  expect(document.body.textContent).not.toContain('unknown method');
});

test('an engine that is not there yet is one click away, and choices apply without a save button', async () => {
  const call = vi.fn(async (method: string, params?: unknown) => {
    if (method === 'speech.status') return status();
    if (method === 'speech.config') return config;
    if (method === 'speech.install') return status({ installing: true, downloading: 'small-q5_1', downloadedBytes: 50_000_000 });
    if (method === 'speech.configure') return status({ engine: (params as SpeechConfig).engine });
    throw new Error(method);
  });
  show(call);
  await settle();
  expect(document.querySelector('[data-testid="voice-status"]')?.getAttribute('data-state')).toBe('local');
  expect(text('voice-status')).toContain('Whisper Small, 190 MB');
  expect(text('voice-install')).toContain('Set up dictation');

  click('voice-install');
  await settle();
  expect(call).toHaveBeenCalledWith('speech.install', {});
  expect(document.querySelector('[data-testid="voice-status"]')?.getAttribute('data-state')).toBe('downloading');
  expect(text('voice-status')).toContain('Downloading Whisper Small');
  expect(text('voice-status')).toContain('50 / 198 MB');

  click('voice-api');
  await settle();
  expect(call).toHaveBeenCalledWith('speech.configure', expect.objectContaining({ engine: 'api' }));
  expect(document.querySelector('[data-testid="voice-api"]')?.getAttribute('aria-checked')).toBe('true');
  expect(document.querySelector('.saved')).not.toBeNull();
  // Keys wait for their button, which shows only once one is typed.
  expect(document.querySelector('[data-testid="voice-save"]')).toBeNull();
  const key = document.querySelector<HTMLInputElement>('[data-testid="voice-groq-key"]')!;
  key.value = 'gsk-fixture'; key.dispatchEvent(new Event('input'));
  await settle();
  click('voice-save');
  await settle();
  expect(call).toHaveBeenLastCalledWith('speech.configure', expect.objectContaining({ engine: 'api', groqKey: 'gsk-fixture' }));
  expect(call.mock.calls.at(-1)![1]).not.toHaveProperty('openrouterKey');
});

test('a model already here is used at once, one that is not downloads, and a link goes to the core as typed', async () => {
  const call = vi.fn(async (method: string, params?: unknown) => {
    if (method === 'speech.status') return status({ ready: true, localReady: true, models: models(['small-q5_1', 'base-q5_1']) });
    if (method === 'speech.config') return config;
    if (method === 'speech.configure') return status({ ready: true, localReady: true, models: models(['small-q5_1', 'base-q5_1']) });
    if (method === 'speech.install') {
      if ((params as { url?: string }).url?.startsWith('http:')) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'speech.url must be an https:// link to a ggml Whisper model' });
      return status({ ready: true, localReady: true, installing: true, downloading: 'large-v3-turbo-q5_0', totalBytes: 574041195 });
    }
    throw new Error(method);
  });
  show(call);
  await settle();
  expect(text('voice-status')).toContain('Ready, Whisper Small on this machine');
  expect(document.querySelector('[data-testid="voice-model-small-q5_1"] [role=radio]')?.getAttribute('aria-checked')).toBe('true');
  expect(text('voice-model-base-q5_1')).toContain('60 MB · Fastest');

  document.querySelector<HTMLButtonElement>('[data-testid="voice-model-base-q5_1"] [role=radio]')!.click();
  await settle();
  expect(call).toHaveBeenCalledWith('speech.configure', expect.objectContaining({ model: 'base-q5_1', modelPath: '' }));
  expect(document.querySelector('[data-testid="voice-model-base-q5_1"] [role=radio]')?.getAttribute('aria-checked')).toBe('true');

  click('voice-model-download-large-v3-turbo-q5_0');
  await settle();
  expect(call).toHaveBeenCalledWith('speech.install', { model: 'large-v3-turbo-q5_0' });
  expect(text('voice-status')).toContain('Downloading Whisper Large v3 Turbo');

  const input = document.querySelector<HTMLInputElement>('[data-testid="voice-model-url"]')!;
  input.value = ' http://models.example/ggml-tiny.bin '; input.dispatchEvent(new Event('input'));
  await settle();
  input.closest('form')!.requestSubmit();
  await settle();
  expect(call).toHaveBeenCalledWith('speech.install', { url: 'http://models.example/ggml-tiny.bin' });
  expect(document.querySelector('.error')?.textContent).toContain('https://');
  // A refused link stays in the field to be corrected.
  expect(input.value).toBe('http://models.example/ggml-tiny.bin');
});

test('a link that failed while another model is ready keeps the ready line and says why below it', async () => {
  const reason = 'speech.url: ggml-medium.bin is a web page, not the file itself';
  show(async (method: string) => {
    if (method === 'speech.status') return status({ ready: true, localReady: true, models: models(['small-q5_1']), error: reason });
    if (method === 'speech.config') return config;
    throw new Error(method);
  });
  await settle();
  expect(document.querySelector('[data-testid="voice-status"]')?.getAttribute('data-state')).toBe('ready');
  expect(text('voice-download-error')).toBe(reason);
});

test('a status poll that succeeds keeps the error of a failed action, and a hidden window polls nothing', async () => {
  vi.useFakeTimers();
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  try {
    const call = vi.fn(async (method: string) => {
      if (method === 'speech.status') return status();
      if (method === 'speech.config') return config;
      if (method === 'speech.install') throw new Error('disk full');
      throw new Error(method);
    });
    show(call);
    await settle();
    click('voice-install');
    await settle();
    expect(document.querySelector('.error')?.textContent).toBe('disk full');

    const polls = () => call.mock.calls.filter(([method]) => method === 'speech.status').length;
    const before = polls();
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(polls()).toBe(before + 1);
    expect(document.querySelector('.error')?.textContent).toBe('disk full');

    hidden.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(polls()).toBe(before + 1);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(polls()).toBe(before + 2);
  } finally {
    hidden.mockRestore();
    vi.useRealTimers();
  }
});
