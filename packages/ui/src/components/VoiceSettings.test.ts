import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { RpcErrorCode, type SpeechConfig, type SpeechStatus } from '@boite/contracts';
import { RpcFailure } from '../lib/client';
import type { Store } from '../lib/store.svelte';
import VoiceSettings from './VoiceSettings.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (mounted) await unmount(mounted); mounted = undefined; document.body.innerHTML = ''; });

const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const status = (patch: Partial<SpeechStatus> = {}): SpeechStatus => ({
  revision: 'r1', engine: 'local', ready: false, localReady: false, groqKeySet: false, openrouterKeySet: false,
  installing: false, downloadedBytes: 0, totalBytes: 198279932, error: null, canInstallRuntime: true, ...patch,
});
const config: SpeechConfig = { engine: 'local', language: '', apiProvider: 'groq', fallback: false, executable: '', modelPath: '' };
const show = (call: (method: string, params?: unknown) => Promise<unknown>) => {
  mounted = mount(VoiceSettings, { target: document.body, props: {
    store: { client: { call }, connection: 'ready', owner: true, core: { hostname: 'build-box' } } as unknown as Store,
  } });
};
const text = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';

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
    if (method === 'speech.install') return status({ installing: true, downloadedBytes: 50_000_000 });
    if (method === 'speech.configure') return status({ engine: (params as SpeechConfig).engine });
    throw new Error(method);
  });
  show(call);
  await settle();
  expect(document.querySelector('[data-testid="voice-status"]')?.getAttribute('data-state')).toBe('local');
  expect(text('voice-install')).toContain('Set up dictation');

  document.querySelector<HTMLButtonElement>('[data-testid="voice-install"]')!.click();
  await settle();
  expect(call).toHaveBeenCalledWith('speech.install', {});
  expect(document.querySelector('[data-testid="voice-status"]')?.getAttribute('data-state')).toBe('downloading');
  expect(text('voice-status')).toContain('50 / 198 MB');

  document.querySelector<HTMLButtonElement>('[data-testid="voice-api"]')!.click();
  await settle();
  expect(call).toHaveBeenCalledWith('speech.configure', expect.objectContaining({ engine: 'api' }));
  expect(document.querySelector('[data-testid="voice-api"]')?.getAttribute('aria-checked')).toBe('true');
  expect(document.querySelector('.saved')).not.toBeNull();
  // Keys still wait for their button: nothing typed, nothing to save.
  expect(document.querySelector<HTMLButtonElement>('[data-testid="voice-save"]')!.disabled).toBe(true);
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
    document.querySelector<HTMLButtonElement>('[data-testid="voice-install"]')!.click();
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
