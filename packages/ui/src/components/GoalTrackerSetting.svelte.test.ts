import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { GoalTrackerModel, ModelInfo, Settings } from '@boite/contracts';
import type { Store } from '../lib/store.svelte';
import GoalTrackerSetting from './GoalTrackerSetting.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.innerHTML = '';
});

const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const levels = (...ids: string[]) => ids.map((id) => ({ id, label: id[0]!.toUpperCase() + id.slice(1) }));
const provider = (id: string, protocol: string, shortName: string, available = true) => ({ id, shortName, name: shortName, protocol, available, models: [] });
const MODELS: Record<string, ModelInfo[]> = {
  claude: [
    { id: 'default', name: 'Default' },
    { id: 'claude-haiku-5-5', name: 'Haiku 5.5', effort: { levels: levels('low', 'medium', 'high'), default: 'high' } },
    { id: 'claude-opus-5-5', name: 'Opus 5.5', effort: { levels: levels('low', 'medium', 'high', 'max'), default: 'high' } },
  ],
  codex: [
    { id: 'gpt-6-luna', name: 'GPT-6-Luna', effort: { levels: levels('low', 'medium'), default: 'medium' } },
    { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', effort: { levels: levels('low', 'medium', 'high'), default: 'low' } },
  ],
  pi: [{ id: 'pi-model', name: 'Pi model' }],
};

function render(goalTracker: GoalTrackerModel | null) {
  const store = $state({
    settings: { goalTracker } as Partial<Settings>,
    providers: [provider('claude', 'claude-sdk', 'Claude'), provider('codex', 'codex-appserver', 'Codex'), provider('pi', 'pi-rpc', 'Pi', false)],
    accounts: [{ id: 'claude-main', providerId: 'claude', status: 'ok' }, { id: 'codex-main', providerId: 'codex', status: 'ok' }, { id: 'pi-main', providerId: 'pi', status: 'ok' }],
    accountsOf: (providerId: string) => store.accounts.filter((account) => account.providerId === providerId),
    modelsOf: (providerId: string) => MODELS[providerId] ?? [],
    saveSettings: vi.fn(async (patch: Partial<Settings>) => {
      store.settings = { ...store.settings, ...patch };
      return true;
    }),
  });
  mounted = mount(GoalTrackerSetting, { target: document.body, props: { store: store as unknown as Store } });
  return store;
}

const trigger = (testid: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`);
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="goal-tracker-model-menu"] > *')].map((row) =>
  row.classList.contains('separator') ? '---' : `${row.querySelector('.label')!.textContent!.trim()} | ${row.querySelector('.hint')?.textContent ?? ''}`);

test('the checklist model starts on Automatic, which suggests Opus and Sol and never a small model', async () => {
  const store = render(null);
  await settle();
  expect(trigger('goal-tracker-model')!.textContent).toContain('Automatic');
  // Automatic carries its own level: no reasoning menu until a model is picked.
  expect(trigger('goal-tracker-effort')).toBeNull();

  trigger('goal-tracker-model')!.click();
  await settle();
  // Pi is not installed; Haiku and Luna are offered, never suggested.
  expect(rows()).toEqual([
    'Automatic | Opus medium or Sol high',
    '---',
    'Opus 5.5 | Claude · Automatic',
    'Haiku 5.5 | Claude',
    '---',
    'GPT-6.1-Sol | Codex · Automatic',
    'GPT-6-Luna | Codex',
  ]);

  document.querySelector<HTMLButtonElement>('[data-value=\'["codex","gpt-6.1-sol"]\']')!.click();
  await settle();
  // A model of a suggested family starts on that family's level, not on the model's own default.
  expect(store.saveSettings).toHaveBeenLastCalledWith({ goalTracker: { providerId: 'codex', model: 'gpt-6.1-sol', effort: 'high' } });
  expect(trigger('goal-tracker-model')!.textContent).toContain('GPT-6.1-Sol');
  expect(trigger('goal-tracker-effort')!.textContent).toContain('High');
});

test('a small model is the user\'s own pick, on its own default level, and its level can change', async () => {
  const store = render(null);
  await settle();
  trigger('goal-tracker-model')!.click();
  await settle();
  document.querySelector<HTMLButtonElement>('[data-value=\'["claude","claude-haiku-5-5"]\']')!.click();
  await settle();
  expect(store.saveSettings).toHaveBeenLastCalledWith({ goalTracker: { providerId: 'claude', model: 'claude-haiku-5-5', effort: 'high' } });

  trigger('goal-tracker-effort')!.click();
  await settle();
  expect([...document.querySelectorAll('[data-testid="goal-tracker-effort-menu"] .label')].map((label) => label.textContent?.trim())).toEqual(['Low', 'Medium', 'High']);
  document.querySelector<HTMLButtonElement>('[data-testid="goal-tracker-effort-menu"] [data-value="medium"]')!.click();
  await settle();
  expect(store.saveSettings).toHaveBeenLastCalledWith({ goalTracker: { providerId: 'claude', model: 'claude-haiku-5-5', effort: 'medium' } });

  trigger('goal-tracker-model')!.click();
  await settle();
  document.querySelector<HTMLButtonElement>('[data-value="auto"]')!.click();
  await settle();
  expect(store.saveSettings).toHaveBeenLastCalledWith({ goalTracker: null });
  expect(trigger('goal-tracker-model')!.textContent).toContain('Automatic');
});
