import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { ModelInfo, Settings, TitleModel } from '@boite/contracts';
import type { Store } from '../lib/store.svelte';
import TitleModelSetting from './TitleModelSetting.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.innerHTML = '';
});

const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const provider = (id: string, protocol: string, shortName: string, titles: boolean, available = true) => ({ id, shortName, name: shortName, protocol, titles, available, models: [] });
const MODELS: Record<string, ModelInfo[]> = {
  // As the shipped descriptor has it: Haiku 4.5 is legacy, and still the small model.
  claude: [{ id: 'default', name: 'Default' }, { id: 'claude-opus-5', name: 'Opus 5' }, { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', legacy: true }],
  codex: [{ id: 'gpt-6', name: 'GPT 6' }, { id: 'gpt-5.2', name: 'GPT 5.2', legacy: true }],
  opencode: [{ id: 'openai/gpt-5', name: 'GPT 5' }],
};

function render(titleModel: TitleModel | null, models = MODELS) {
  const store = $state({
    settings: { titleModel } as Partial<Settings>,
    providers: [
      provider('claude', 'claude-sdk', 'Claude', true),
      provider('codex', 'codex-appserver', 'Codex', true),
      provider('opencode', 'acp', 'OpenCode', false),
      provider('pi', 'pi-rpc', 'Pi', true, false),
    ],
    accounts: [
      { id: 'claude-main', providerId: 'claude', status: 'ok' },
      { id: 'codex-main', providerId: 'codex', status: 'ok' },
      { id: 'opencode-main', providerId: 'opencode', status: 'ok' },
      { id: 'pi-main', providerId: 'pi', status: 'ok' },
    ],
    accountsOf: (providerId: string) => store.accounts.filter((account) => account.providerId === providerId),
    modelsOf: (providerId: string) => models[providerId] ?? [],
    saveSettings: vi.fn(async (patch: Partial<Settings>) => {
      store.settings = { ...store.settings, ...patch };
      return true;
    }),
  });
  mounted = mount(TitleModelSetting, { target: document.body, props: { store: store as unknown as Store } });
  return store;
}

const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="setting-title-model-menu"] > *')].map((row) =>
  row.classList.contains('separator') ? '---' : `${row.querySelector('.label')!.textContent!.trim()} | ${row.querySelector('.hint')?.textContent ?? ''}`);

test('the title model lists each provider that writes titles, its small model first', async () => {
  const store = render(null);
  await settle();
  const trigger = document.querySelector<HTMLButtonElement>('[data-testid="setting-title-model"]')!;
  expect(trigger.textContent).toContain('Automatic');

  trigger.click();
  await settle();
  // OpenCode cannot write titles and Pi is not installed; the default and legacy entries stay out.
  expect(rows()).toEqual([
    "Automatic | The thread's agent, small model",
    '---',
    'Haiku 4.5 | Claude · small',
    'Opus 5 | Claude',
    '---',
    'GPT 6 Luna | Codex · small',
    'GPT 6 | Codex',
  ]);

  document.querySelector<HTMLButtonElement>('[data-value=\'["claude","claude-haiku-4-5-20251001"]\']')!.click();
  await settle();
  expect(store.saveSettings).toHaveBeenCalledWith({ titleModel: { providerId: 'claude', model: 'claude-haiku-4-5-20251001' } });
  expect(trigger.textContent).toContain('Haiku 4.5');
});

test('a pick the provider no longer lists stays in the menu, and Automatic clears it', async () => {
  const store = render({ providerId: 'codex', model: 'gpt-5.4-mini' });
  await settle();
  const trigger = document.querySelector<HTMLButtonElement>('[data-testid="setting-title-model"]')!;
  expect(trigger.textContent).toContain('GPT 5.4 mini');

  trigger.click();
  await settle();
  expect(rows()).toContain('GPT 5.4 mini | Codex');
  expect(document.querySelector('[data-value=\'["codex","gpt-5.4-mini"]\']')!.classList.contains('active')).toBe(true);

  document.querySelector<HTMLButtonElement>('[data-value="auto"]')!.click();
  await settle();
  expect(store.saveSettings).toHaveBeenCalledWith({ titleModel: null });
  expect(trigger.textContent).toContain('Automatic');
});

test('a dated pick the account no longer offers keeps its model name', async () => {
  render({ providerId: 'claude', model: 'claude-haiku-4-5-20251001' }, { ...MODELS, claude: [{ id: 'claude-opus-5', name: 'Opus 5' }] });
  await settle();
  expect(document.querySelector('[data-testid="setting-title-model"]')!.textContent).toContain('Haiku 4.5');
});
