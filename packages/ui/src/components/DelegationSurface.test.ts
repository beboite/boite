import { expect, test, vi } from 'vitest';
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

test('editing limits never sends an empty or fractional value and lowering the team size clamps concurrency', async () => {
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
    const save = vi.spyOn(store, 'configureDelegation').mockResolvedValue();
    const fields = [...document.querySelectorAll<HTMLInputElement>('input[type=number]')];
    expect(fields).toHaveLength(4);
    for (const field of fields) {
      for (const value of ['', '1.5']) {
        field.value = value;
        field.dispatchEvent(new Event('change', { bubbles: true }));
        flushSync();
      }
    }
    expect(save).not.toHaveBeenCalled();
    fields[0]!.value = '1';
    fields[0]!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ maxAgents: 1, maxConcurrent: 1 }));
  } finally {
    if (component) await unmount(component);
    store.detach(); client.close(); document.body.innerHTML = '';
  }
});
