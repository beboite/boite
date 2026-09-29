import { expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import DelegationSurface from './DelegationSurface.svelte';

test('reloading the same thread preserves the launch task and selected profile', async () => {
  const client = new FakeClient({ delayMs: 0, delegationDemo: true });
  const store = new Store();
  store.attach(client);
  let component;
  try {
    await store.connect();
    await store.open('t-trace');
    await store.loadDelegation();
    component = mount(DelegationSurface, { target: document.body, props: { store } });
    flushSync();
    const task = document.querySelector<HTMLTextAreaElement>('[data-testid=delegation-task]')!;
    const profiles = document.querySelectorAll<HTMLButtonElement>('.profile-picks button');
    profiles[1]!.click();
    task.value = 'Review the parser';
    task.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    await store.open('t-trace', false);
    flushSync();
    expect(task.value).toBe('Review the parser');
    expect(profiles[1]!.getAttribute('aria-checked')).toBe('true');
    await store.open('t-scheduler');
    flushSync();
    await store.open('t-trace');
    flushSync();
    expect(document.querySelector<HTMLTextAreaElement>('[data-testid=delegation-task]')?.value).toBe('');
  } finally {
    if (component) await unmount(component);
    store.detach(); client.close(); document.body.innerHTML = '';
  }
});

test('delegation exposes launch controls without numeric quotas', async () => {
  const client = new FakeClient({ delayMs: 0, delegationDemo: true });
  const store = new Store();
  store.attach(client);
  let component;
  try {
    await store.connect();
    await store.open('t-trace');
    await store.loadDelegation();
    component = mount(DelegationSurface, { target: document.body, props: { store } });
    flushSync();
    expect(document.querySelectorAll('input[type=number]')).toHaveLength(0);
    const task = document.querySelector<HTMLTextAreaElement>('[data-testid=delegation-task]')!;
    task.value = 'Review the parser';
    task.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect(document.querySelector<HTMLButtonElement>('[data-testid=delegation-spawn]')?.disabled).toBe(false);
  } finally {
    if (component) await unmount(component);
    store.detach(); client.close(); document.body.innerHTML = '';
  }
});
