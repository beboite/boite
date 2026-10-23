import { expect, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { test } from '../../test/fake-client';
import { AgentsView, openAgent } from '../../lib/agents.svelte';
import { setExperiment } from '../../lib/experiments';
import AgentDesk from './AgentDesk.svelte';

const chips = () => [...document.querySelectorAll('[data-testid=desk-chip]')].map(chip => chip.textContent?.trim());
const card = (title: string) => [...document.querySelectorAll<HTMLElement>('[data-testid=desk-card]')].find(node => node.querySelector('.desk-card-title')?.textContent === title);

test('Nova\'s desk shows its live step, every card state in order, answers a question in place, drops a card and meters its day', async ({ ready }) => {
  setExperiment('resident-agents', true);
  let desk: ReturnType<typeof mount> | null = null;
  try {
    const { store } = await ready({ delayMs: 0, agentsDemo: true });
    const view = AgentsView.of(store);
    await view.refresh();
    const nova = view.snapshot!.profiles.find(p => p.name === 'Nova')!;
    store.showAgents();
    await openAgent(store, nova.id);
    desk = mount(AgentDesk, { target: document.body, props: { store } });
    await vi.waitFor(() => expect(chips()).toHaveLength(5));
    flushSync();

    // Now: the step its turn is on, live, and the calls so far on the rail.
    expect(document.querySelector('[data-testid=desk-now]')?.getAttribute('data-state')).toBe('working');
    expect(document.querySelector('[data-testid=desk-now-step]')?.textContent).toBe('Run the UI tests');
    expect(document.querySelector('[data-testid=desk-now]')?.textContent).toContain('4 steps so far');
    expect(document.querySelectorAll('[data-testid=desk-steps] li')).toHaveLength(4);
    expect(document.querySelector('[data-testid=desk-steps] li:last-child')?.getAttribute('data-status')).toBe('running');

    // Work: what needs the user first, then the silent turn, the work, the open pull request with failing checks, the merged one.
    expect(chips()).toEqual(['Needs you', 'Stalled', 'Working', 'PR open', 'Merged']);
    expect(card('Migrate the settings store')?.textContent).toContain('silent for 24 min');
    expect(card('Fix login redirect loop')?.querySelector('[data-testid=desk-card-pr]')?.textContent).toMatch(/PR #482\s*checks failing/);
    expect(card('Release notes 2.0.4')?.querySelector('[data-testid=desk-card-pr]')?.textContent).toContain('PR #479 merged');

    // The question is answered from the card, and leaves the desk.
    const icons = card('Pick the release icon set')!;
    expect(icons.querySelector('[data-testid=desk-question]')?.textContent).toContain('Which one should the app ship with?');
    const asked = store.pendingQuestions.find(q => q.text.includes('icon sets'))!;
    [...icons.querySelectorAll<HTMLButtonElement>('[data-testid=desk-answer]')].find(b => b.textContent === 'Phosphor')!.click();
    await vi.waitFor(() => expect(store.pendingQuestions.some(q => q.id === asked.id)).toBe(false));
    await vi.waitFor(() => expect(document.querySelector('[data-testid=desk-question]')).toBeNull());

    // The cross takes a thread off the desk.
    card('Release notes 2.0.4')!.querySelector<HTMLButtonElement>('[data-testid=desk-card-drop]')!.click();
    await vi.waitFor(() => expect(card('Release notes 2.0.4')).toBeUndefined());
    expect(view.snapshot!.watches.some(w => w.title === 'Release notes 2.0.4')).toBe(false);

    // Its memory, rendered, and the day against its budget.
    await vi.waitFor(() => expect(document.querySelector('[data-testid=desk-memory-text]')?.textContent).toContain('The login fix ships in it'));
    expect(document.querySelector('[data-testid=desk-memory-pass]')?.textContent).toMatch(/Updated 37 min\. ago\s*PR #482 fails its e2e redirect test/);
    await vi.waitFor(() => expect(document.querySelector('[data-testid=desk-budget]')?.textContent).toContain('$1.35 of $2.00'));
    expect(document.querySelector('[data-testid=desk-schedule]')?.textContent).toContain('Release check');
  } finally {
    if (desk) await unmount(desk);
    document.body.innerHTML = '';
    setExperiment('resident-agents', false);
  }
});
