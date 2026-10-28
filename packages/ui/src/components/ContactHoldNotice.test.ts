import { afterEach, expect, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { test } from '../test/fake-client';
import ChatView from './ChatView.svelte';

let view: ReturnType<typeof mount> | undefined;
afterEach(() => {
  if (view) unmount(view, { outro: false });
  view = undefined;
  document.body.replaceChildren();
});

const notice = () => document.querySelector('[data-testid=contact-hold]');

test('a thread held by contact mail names the contact and runs again once the owner trusts its history', async ({ ready }) => {
  const { store, client } = await ready();
  const account = (await client.call('accounts.list', {})).find(entry => entry.providerId === 'echo')!;
  const thread = await client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: account.id, title: 'Bot rounds' });
  client.holdForContactMail(thread.id, ['Chris']);
  await store.open(thread.id);
  view = mount(ChatView, { target: document.body, props: { store } });
  flushSync();

  await vi.waitFor(() => expect(notice()).not.toBeNull());
  expect(notice()!.textContent).toContain('messages from Chris');
  await expect(client.call('turns.start', { threadId: thread.id, prompt: 'next round' })).rejects.toThrow('shared file policy');

  document.querySelector<HTMLButtonElement>('[data-testid=contact-hold-trust]')!.click();
  await vi.waitFor(() => expect(notice()).toBeNull());
  await client.call('turns.start', { threadId: thread.id, prompt: 'next round' });
});
