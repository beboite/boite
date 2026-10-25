/*
 * What this app tells each core it is connected to about itself
 * (`client.preferences`): an id kept on the device, the language it speaks, the experiments it has on
 * and the names it gives settings in that language. An agent then reads the
 * screen the user reads (`boite settings`), and a card about an experiment
 * settles once this app reports the switch moved. Sent after every hello and
 * on every change; an older core without the method is left alone.
 */
import { EXPERIMENT_IDS, REQUESTABLE_SETTING_KEYS, SETTINGS_PAGES, type ClientPreferences, type ExperimentId } from '@boite/contracts';
import { untrack } from 'svelte';
import type { ObservableClient } from './client';
import { experimentCopy } from './experiment-copy';
import { readExperiments, subscribeExperiments } from './experiments';
import { activeLocale } from './i18n.svelte';
import { secureId } from './secure-id';
import { settingLabel, settingsPageLabel } from './setting-requests';

const APP_ID_KEY = 'boite.appId';
let appId: string | null = null;

/** This device's id across reconnects and restarts; one per page when storage is refused. */
function deviceAppId(): string {
  if (appId !== null) return appId;
  try {
    const stored = localStorage.getItem(APP_ID_KEY);
    if (stored !== null && /^[A-Za-z0-9_-]{8,64}$/.test(stored)) return (appId = stored);
    appId = secureId();
    localStorage.setItem(APP_ID_KEY, appId);
  } catch {
    appId ??= secureId();
  }
  return appId;
}

export function clientPreferences(): ClientPreferences {
  const copy = experimentCopy();
  const labels: Record<string, string> = {};
  for (const key of REQUESTABLE_SETTING_KEYS) labels[key] = settingLabel(key);
  for (const id of EXPERIMENT_IDS) labels[`experiment.${id}`] = copy[id].title;
  for (const page of SETTINGS_PAGES) labels[page] = settingsPageLabel(page);
  return { app: deviceAppId(), language: activeLocale(), experiments: readExperiments(), labels };
}

/**
 * Reports to `client` while `current` holds, and hands `desktop` what the core
 * answers of its desktop app's experiments. Returns what stops it.
 */
export function reportPreferences(client: ObservableClient, current: () => boolean, desktop: (experiments: ExperimentId[] | null) => void = () => {}): () => void {
  let sent = '';
  const send = (again: boolean): void => {
    if (!current() || client.state !== 'ready') return;
    const preferences = clientPreferences();
    const said = JSON.stringify(preferences);
    if (!again && said === sent) return;
    sent = said;
    client.call('client.preferences', preferences).then((answer) => {
      // An older core answers without it.
      if (current()) desktop(answer.desktop ?? null);
    }, () => {
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
