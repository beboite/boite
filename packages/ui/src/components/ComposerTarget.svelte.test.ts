import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import type { ComposerTarget } from '../lib/composer-target';
import Composer from './Composer.svelte';

let component: ReturnType<typeof mount> | undefined;
let client: FakeClient | undefined;
afterEach(async () => {
  if (component) await unmount(component, { outro: false });
  component = undefined;
  client?.close();
  document.body.innerHTML = '';
});

/**
 * An agent's box has no outbox: on a machine that went away it waits for the
 * machine, even while a new conversation's draft, which does queue, is open
 * on the same store.
 */
test('a message to an agent is not queued while its machine is away, whatever draft the chat holds', async () => {
  client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  store.attach(client);
  await store.connect();
  store.startDraft(store.projects.find(project => project.kind !== 'drafts')!.id, { fresh: true });
  const send = vi.fn(async () => true);
  const target: ComposerTarget = { key: 'agent:thr_helper', placeholder: 'Message the helper', provider: null, sent: [], busy: false, send };
  component = mount(Composer, { target: document.body, props: { store, target } });
  flushSync();
  store.connection = 'connecting';
  store.composerStates['agent:thr_helper'] = { text: 'are you there', attachments: [], queued: [], sending: false, paused: false };
  flushSync();
  const button = document.querySelector<HTMLButtonElement>('[data-testid=composer-send]')!;
  expect(document.querySelector<HTMLTextAreaElement>('[data-testid=composer-input]')!.placeholder).toBe('Message the helper');
  expect(button.disabled).toBe(true);
  store.connection = 'ready';
  flushSync();
  expect(button.disabled).toBe(false);
  expect(send).not.toHaveBeenCalled();
});
