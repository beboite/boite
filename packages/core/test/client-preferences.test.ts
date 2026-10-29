import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { ClientPreferences, ExperimentId, SentFrom } from '@boite/contracts';
import { connect, type CoreClient } from '../src/client.ts';
import { ClientPreferencesBook } from '../src/client-preferences.ts';
import type { Connection } from '../src/router.ts';
import { startTestCore, type TestCore } from './harness.ts';

const report = (experiments: ExperimentId[], app = 'app-0000-0001'): ClientPreferences => ({ app, language: 'en', experiments, labels: {} });

test('phones follow the desktop app on this machine before one reached from elsewhere, and hear only its changes', () => {
  const moves: ExperimentId[][] = [];
  const book = new ClientPreferencesBook(() => {}, experiments => moves.push(experiments));
  let next = 0;
  const socket = (sentFrom: SentFrom | null, remote: boolean, principal = 'owner') => ({ id: `c${next++}`, subscriptions: new Set(), identity: { principal, sessionId: null, threadId: null }, sentFrom, remote, sendEvent() {}, close() {} }) as unknown as Connection;
  const phone = socket({ client: 'pwa', device: 'phone' }, true);
  const laptop = socket({ client: 'shell', device: 'laptop' }, true);
  const here = socket({ client: 'shell', device: 'pc' }, false);

  // A phone is no desktop app, nor is a paired device that calls itself one.
  book.report(phone, report(['whip']));
  book.report(socket({ client: 'shell', device: 'paired' }, true, 'session'), report(['whip'], 'app-paired-01'));
  expect(book.desktopExperiments()).toBeNull();
  // A desktop app from elsewhere stands in while this machine's has not reported.
  book.report(laptop, report(['theme-grain'], 'app-laptop-01'));
  book.report(here, report(['resident-agents'], 'app-here-0001'));
  // Once this machine's has, another desktop app's flips no longer move what phones follow.
  book.report(laptop, report(['contacts'], 'app-laptop-01'));
  // The same switches again, as after a reconnect, say nothing.
  book.report(here, report(['resident-agents'], 'app-here-0001'));
  book.report(here, report(['resident-agents', 'whip'], 'app-here-0001'));
  expect(moves).toEqual([['theme-grain'], ['resident-agents'], ['resident-agents', 'whip']]);
  expect(book.desktopExperiments()).toEqual(['resident-agents', 'whip']);
});

let h: TestCore;
const clients: CoreClient[] = [];
beforeEach(async () => { h = await startTestCore(); });
afterEach(async () => { for (const client of clients.splice(0)) client.close(); await h.stop(); });

test('a phone hears the desktop app\'s experiments in its report\'s answer and on every flip', async () => {
  const as = async (name: string) => {
    const opened = await connect(h.url, h.token, { client: { version: 'test', name } });
    clients.push(opened);
    return opened;
  };
  const phone = await as('pwa');
  const desktop = await as('shell');
  expect(await phone.call('client.preferences', report([], 'app-phone-001'))).toEqual({ ok: true, desktop: null });

  const heard = phone.next('client.desktopExperiments', ({ experiments }) => experiments.includes('whip'));
  await desktop.call('client.preferences', report(['whip', 'resident-agents'], 'app-desktop-1'));
  expect((await heard).experiments).toEqual(['resident-agents', 'whip']);
  expect(await phone.call('client.preferences', report([], 'app-phone-001'))).toEqual({ ok: true, desktop: ['resident-agents', 'whip'] });
});
