/*
 * What this app tells each core it is connected to about itself
 * (`client.preferences`): the language it speaks, the experiments it has on
 * and the names it gives settings in that language. An agent then reads the
 * screen the user reads (`boite settings`), and a card about an experiment
 * settles once this app reports the switch moved. Sent after every hello and
 * on every change; an older core without the method is left alone.
 */
import { EXPERIMENT_IDS, REQUESTABLE_SETTING_KEYS, SETTINGS_PAGES, type ClientPreferences } from '@boite/contracts';
import { untrack } from 'svelte';
import type { ObservableClient } from './client';
import { experimentCopy } from './experiment-copy';
import { readExperiments, subscribeExperiments } from './experiments';
import { activeLocale } from './i18n.svelte';
import { settingLabel, settingsPageLabel } from './setting-requests';

export function clientPreferences(): ClientPreferences {
  const copy = experimentCopy();
  const labels: Record<string, string> = {};
  for (const key of REQUESTABLE_SETTING_KEYS) labels[key] = settingLabel(key);
  for (const id of EXPERIMENT_IDS) labels[`experiment.${id}`] = copy[id].title;
  for (const page of SETTINGS_PAGES) labels[page] = settingsPageLabel(page);
  return { language: activeLocale(), experiments: readExperiments(), labels };
}

/** Reports to `client` while `current` holds. Returns what stops it. */
export function reportPreferences(client: ObservableClient, current: () => boolean): () => void {
  let sent = '';
  const send = (again: boolean): void => {
    if (!current() || client.state !== 'ready') return;
    const preferences = clientPreferences();
    const said = JSON.stringify(preferences);
    if (!again && said === sent) return;
    sent = said;
    client.call('client.preferences', preferences).catch(() => {
      // An older core has no such method; a later change tries again.
      sent = '';
    });
  };
  const offState = client.onState((state) => { if (state === 'ready') send(true); });
  const offExperiments = subscribeExperiments(() => send(false));
  const offLocale = $effect.root(() => {
    $effect(() => {
      activeLocale();
      untrack(() => send(false));
    });
  });
  return () => { offState(); offExperiments(); offLocale(); };
}
