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
    await vi.waitFor(() => expect(chips()).toHaveLength(6));
    flushSync();

    // The overview keeps followed work visible and gives secondary content its own tab.
    expect(document.querySelector('[data-testid=desk-tab-work]')?.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector<HTMLElement>('[data-testid=desk-schedule]')?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('[data-testid=desk-memory]')?.hidden).toBe(true);
    expect(document.querySelector<HTMLDetailsElement>('[data-testid=desk-activity]')?.open).toBe(false);
    expect(document.querySelector<HTMLDetailsElement>('[data-testid=desk-today]')?.open).toBe(false);

    // Now: the step its turn is on, live, and the calls so far on the rail.
    expect(document.querySelector('[data-testid=desk-now]')?.getAttribute('data-state')).toBe('working');
    expect(document.querySelector('[data-testid=desk-now-step]')?.textContent).toBe('Run the UI tests');
    expect(document.querySelector('[data-testid=desk-now]')?.textContent).toContain('4 steps so far');
    expect(document.querySelectorAll('[data-testid=desk-steps] li')).toHaveLength(4);
    expect(document.querySelector('[data-testid=desk-steps] li:last-child')?.getAttribute('data-status')).toBe('running');

    // Work: what needs the user first, then the silent turn, the work, the open pull request with failing checks, the merged one, the other machine's quiet thread.
    expect(chips()).toEqual(['Needs you', 'Stalled', 'Working', 'PR open', 'Merged', 'Idle']);
    expect(card('Migrate the settings store')?.textContent).toContain('silent for 24 min');
    expect(card('Fix login redirect loop')?.querySelector('[data-testid=desk-card-pr]')?.textContent).toMatch(/PR #482\s*checks failing/);
    expect(card('Release notes 2.0.4')?.querySelector('[data-testid=desk-card-pr]')?.textContent).toContain('PR #479 merged');
    // A thread of another machine names it, says it cannot be reached, and opens nowhere this client does not reach.
    const away = card('Fix the save migration')!;
    expect(away.querySelector('[data-testid=desk-card-machine]')?.textContent).toBe('skoll');
    expect(away.querySelector('[data-testid=desk-card-unreachable]')?.getAttribute('title')).toContain('its events reach you once it is back');
    expect(away.querySelector('.desk-card-open')).toBeNull();

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

    // Arrow keys move both focus and selection; Home returns to the overview.
    const work = document.querySelector<HTMLButtonElement>('[data-testid=desk-tab-work]')!;
    work.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    flushSync();
    expect(document.activeElement?.getAttribute('data-testid')).toBe('desk-tab-routines');
    expect(document.querySelector<HTMLElement>('[data-testid=desk-schedule]')?.hidden).toBe(false);
    // Run now waits while Nova works: the core refuses a second turn in flight.
    const run = document.querySelector<HTMLButtonElement>('[data-testid=routine-run]')!;
    expect(run.disabled).toBe(true);
    expect(run.title).toBe('It is at work: run it again once its turn ends');
    expect(document.querySelector('[data-testid=desk-schedule]')?.textContent).toContain('Release check');

    // Returning to a tab preserves a routine draft rather than losing typed work.
    document.querySelector<HTMLButtonElement>('[data-testid=routine-add]')!.click();
    flushSync();
    const prompt = document.querySelector<HTMLTextAreaElement>('[data-testid=desk-schedule] textarea')!;
    prompt.value = 'Check the next release';
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector<HTMLButtonElement>('[data-testid=desk-tab-memory]')!.click();
    flushSync();
    expect(document.querySelector<HTMLElement>('[data-testid=desk-work]')?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('[data-testid=desk-memory]')?.hidden).toBe(false);

    // Its memory is rendered on demand, and its day still meters the same budget.
    await vi.waitFor(() => expect(document.querySelector('[data-testid=desk-memory-text]')?.textContent).toContain('The login fix ships in it'));
    expect(document.querySelector('[data-testid=desk-memory-pass]')?.textContent).toMatch(/Updated 37 min\. ago\s*·\s*PR #482 fails its e2e redirect test/);
    await vi.waitFor(() => expect(document.querySelector('[data-testid=desk-today]')?.textContent).toContain('$1.35 of $2.00'));
    // A new snapshot flags a failed background memory update on its tab.
    view.snapshot = { ...view.snapshot!, status: view.snapshot!.status.map(s => s.agentId === nova.id
      ? { ...s, memory: { ...s.memory!, status: 'error', summary: 'The rewritten memory ran past 8000 characters; it was kept as it is.' } } : s) };
    flushSync();
    expect(document.querySelector('[data-testid=desk-tab-memory]')?.getAttribute('aria-label')).toBe('Memory: Memory update failed');
    expect(document.querySelector('[data-testid=desk-memory-pass]')?.textContent).toContain('8000 characters');
    document.querySelector<HTMLButtonElement>('[data-testid=desk-tab-routines]')!.click();
    flushSync();
    expect(document.querySelector<HTMLTextAreaElement>('[data-testid=desk-schedule] textarea')?.value).toBe('Check the next release');
    document.querySelector<HTMLButtonElement>('[data-testid=desk-tab-routines]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    flushSync();
    expect(document.activeElement).toBe(work);
    expect(document.querySelector<HTMLElement>('[data-testid=desk-work]')?.hidden).toBe(false);
    // Cost updates preserve the user's choice to read usage details.
    const usage = document.querySelector<HTMLDetailsElement>('[data-testid=desk-today]')!;
    usage.open = true;
    usage.dispatchEvent(new Event('toggle'));
    flushSync();
    view.snapshot = { ...view.snapshot!, status: view.snapshot!.status.map(s => s.agentId === nova.id
      ? { ...s, today: { ...s.today, costUsd: 1.5 } } : s) };
    flushSync();
    expect.soft(usage.open).toBe(true);
    usage.open = false;
    usage.dispatchEvent(new Event('toggle'));
    flushSync();
    // Reaching the budget reveals the warning once.
    view.snapshot = { ...view.snapshot!, status: view.snapshot!.status.map(s => s.agentId === nova.id
      ? { ...s, today: { ...s.today, costUsd: 3 } } : s) };
    flushSync();
    expect(usage.open).toBe(true);
    expect(usage.textContent).toContain('Budget reached: wakes wait until tomorrow.');
    // Dismissing that warning stays respected while more costs arrive.
    usage.open = false;
    usage.dispatchEvent(new Event('toggle'));
    flushSync();
    view.snapshot = { ...view.snapshot!, status: view.snapshot!.status.map(s => s.agentId === nova.id
      ? { ...s, today: { ...s.today, costUsd: 3.1 } } : s) };
    flushSync();
    expect.soft(usage.open).toBe(false);
  } finally {
    if (desk) await unmount(desk);
    document.body.innerHTML = '';
    setExperiment('resident-agents', false);
  }
});
