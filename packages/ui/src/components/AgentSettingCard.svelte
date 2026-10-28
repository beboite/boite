<script lang="ts">
  import { ArrowRight, Bot } from '@lucide/svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type { AgentSettingAsk, QuestionAnswer } from '@boite/contracts';
  import { errorText } from '../lib/errors';
  import { experimentOn } from '../lib/experiments.svelte';
  import { keepFocus } from '../lib/focus';
  import { agentSettingLabel, agentSettingValueText, editedProjects, projectName, projectsDelta } from '../lib/agent-setting-requests';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import AgentAvatar from './agents/AgentAvatar.svelte';

  /**
   * A card asking the user to change one setting of a persistent agent
   * (`agents.settings.request`). Apply goes through `agents.settings.apply`,
   * with the user's edit when they unticked a project; the core settles the
   * card once the agent's setting moved, from here or from its settings page.
   */
  let {
    store,
    threadId,
    questionId,
    text,
    setting,
    answer,
    pending,
    docked = false,
    respond
  }: {
    /** The store of the machine that owns the thread: its projects, providers and client. */
    store: Store;
    threadId: string;
    questionId: string;
    /** The reason the thread gave. */
    text: string;
    setting: AgentSettingAsk;
    answer: QuestionAnswer | null;
    /** False on a card that closed without an answer. */
    pending: boolean;
    /** Drawn inside the dock above the composer, whose own row names it: no frame, no heading. */
    docked?: boolean;
    /** Answers the card with `refuse`. False gives it back. */
    respond: (optionId: 'refuse') => Promise<unknown>;
  } = $props();

  let busy = $state(false);
  /** Project rows the user unticked: an addition left out, a removal kept. */
  const unticked = new SvelteSet<string>();

  const words = $derived(strings.agentSettingRequest);
  // A project of another machine of the group is named as the core read it, `<machine>/<name>`.
  // A probe names the models a provider's descriptor lists none of (Claude's).
  const probed = (providerId: string) => Object.entries(store.probedModels).flatMap(([key, models]) => (key.startsWith(`${providerId}::`) ? models : []));
  const names = $derived({ projects: [...store.projects, ...Object.entries(setting.labels ?? {}).map(([id, name]) => ({ id, name }))], providers: store.providers.map((provider) => ({ ...provider, models: [...probed(provider.id), ...provider.models] })) });
  const heading = $derived(fill(words.heading, { name: setting.agentName }));
  const delta = $derived(setting.key === 'projects' ? projectsDelta(setting) : null);
  const edited = $derived(delta !== null && unticked.size > 0 ? editedProjects(setting, unticked) : null);
  /** Unticking every row leaves nothing to apply. */
  const unchanged = $derived(edited !== null && JSON.stringify(edited) === JSON.stringify(Array.isArray(setting.previous) ? [...setting.previous].map(String).sort() : []));
  const canShow = $derived(store.owner && experimentOn('resident-agents'));

  function value(raw: unknown): string {
    return agentSettingValueText(setting.key, raw, names);
  }

  function toggle(id: string): void {
    if (unticked.has(id)) unticked.delete(id);
    else unticked.add(id);
  }

  async function apply(): Promise<void> {
    const client = store.client;
    if (busy || !client || unchanged) return;
    busy = true;
    try {
      await client.call('agents.settings.apply', { threadId, questionId, ...(edited !== null ? { value: edited } : {}) });
      // The core settles the card once the change lands; it stays busy until then.
    } catch (error) {
      store.error = errorText(error);
      busy = false;
    }
  }

  function show(): void {
    store.showAgents(setting.agentId, 'settings');
  }

  async function refuse(): Promise<void> {
    if (busy) return;
    busy = true;
    if ((await respond('refuse')) === false) busy = false;
  }

  function verdict(given: QuestionAnswer): string {
    const outcome = given.optionIds[0];
    if (outcome === 'applied') return words.applied;
    if (outcome === 'changed') return fill(words.changed, { value: value(given.value) });
    return words.refused;
  }

  function subject(given: QuestionAnswer | null): string {
    const outcome = given?.optionIds[0];
    const shown = outcome === 'applied' || outcome === 'changed' ? given?.value ?? setting.value : setting.previous;
    // A picture is a code no one reads: the row names the setting alone.
    if (setting.key === 'avatar') return `${setting.agentName} · ${agentSettingLabel(setting.key)}`;
    return `${setting.agentName} · ${agentSettingLabel(setting.key)}: ${value(shown)}`;
  }
</script>

<!-- An answer this client just sent clears the pending list before the card's answer arrives: it stays busy until then. -->
{#if answer !== null || (!pending && !busy)}
  <div class="agent-setting-card resolved" data-testid="agent-setting-card" data-state={answer === null ? 'closed' : 'answered'} data-outcome={answer?.optionIds[0]} data-key={setting.key} title={text}>
    <span class="glyph"><Bot size={15} strokeWidth={1.75} /></span>
    <span class="verdict ui-label" data-testid="agent-setting-verdict">{answer === null ? words.closed : verdict(answer)}</span>
    <span class="given ui-label" data-testid="agent-setting-subject">{subject(answer)}</span>
  </div>
{:else}
  <div class="agent-setting-card" class:docked data-testid="agent-setting-card" data-state="pending" data-key={setting.key} role="group" aria-label={heading}>
    {#if !docked}
      <div class="head">
        <span class="glyph"><Bot size={15} strokeWidth={1.75} /></span>
        <span class="muted ui-label" data-testid="agent-setting-heading">{heading}</span>
      </div>
    {/if}
    <p class="reason" data-testid="agent-setting-reason">{text}</p>

    {#if delta}
      <div class="delta projects" data-testid="agent-setting-delta">
        <span class="name">{agentSettingLabel(setting.key)}</span>
        <div class="rows">
          {#each [...delta.added.map((id) => ({ id, add: true })), ...delta.removed.map((id) => ({ id, add: false }))] as row (row.id)}
            <label class="row" class:removal={!row.add}>
              <input type="checkbox" checked={!unticked.has(row.id)} disabled={busy || !store.owner} onchange={() => toggle(row.id)} data-testid="agent-setting-project" data-project={row.id} />
              <span class="action ui-label">{row.add ? words.entrust : words.takeBack}</span>
              <span class="project ui-label">{projectName(row.id, names)}</span>
            </label>
          {/each}
        </div>
      </div>
      {#if store.owner && delta.added.length + delta.removed.length > 1}<p class="place ui-label">{words.projectsHint}</p>{/if}
    {:else}
      <div class="delta" data-testid="agent-setting-delta">
        <span class="name">{agentSettingLabel(setting.key)}</span>
        {#if setting.key === 'avatar'}
          <span class="values">
            <span class="picture old" data-testid="agent-setting-previous"><AgentAvatar kind="profile" id={setting.agentId} name={setting.agentName} avatar={String(setting.previous ?? '')} size={28} /></span>
            <ArrowRight size={14} strokeWidth={1.75} aria-label={words.to} />
            <span class="picture" data-testid="agent-setting-proposed"><AgentAvatar kind="profile" id={setting.agentId} name={setting.agentName} avatar={String(setting.value ?? '')} size={28} /></span>
          </span>
        {:else}
          <span class="values">
            <span class="old" data-testid="agent-setting-previous">{value(setting.previous)}</span>
            <ArrowRight size={14} strokeWidth={1.75} aria-label={words.to} />
            <span class="new" data-testid="agent-setting-proposed">{value(setting.value)}</span>
          </span>
        {/if}
      </div>
      {#if setting.key === 'instructions' && typeof setting.value === 'string' && setting.value !== ''}
        <div class="proposed-text">
          <span class="place ui-label">{words.proposedText}</span>
          <p class="text" data-testid="agent-setting-text">{setting.value}</p>
        </div>
      {/if}
    {/if}
    {#if !store.owner}
      <p class="hint" data-testid="agent-setting-guest-hint">{words.guestHint}</p>
    {/if}

    <div class="actions">
      {#if store.owner}
        <button type="button" class="primary" data-testid="agent-setting-apply" disabled={busy || unchanged} onmousedown={keepFocus} onclick={apply}><span class="ui-label">{words.apply}</span></button>
      {/if}
      {#if canShow}
        <button type="button" class="ghost" data-testid="agent-setting-show" onmousedown={keepFocus} onclick={show}><span class="ui-label">{words.show}</span></button>
      {/if}
      <button type="button" class="ghost" data-testid="agent-setting-refuse" disabled={busy} onmousedown={keepFocus} onclick={refuse}><span class="ui-label">{words.refuse}</span></button>
    </div>
  </div>
{/if}

<style>
  .agent-setting-card {
    border: 1px solid var(--color-edge);
    border-left-style: dashed;
    border-radius: var(--radius-md);
    background: var(--color-surface);
    box-shadow: var(--shadow-e1);
    padding: 8px 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .agent-setting-card.docked {
    border: none;
    background: transparent;
    box-shadow: none;
    padding: 4px 10px 8px;
  }

  .head { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .head .muted { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .glyph { display: inline-flex; flex: none; color: var(--color-accent); }

  .reason { margin: 0; font-weight: 500; white-space: pre-wrap; overflow-wrap: anywhere; }

  .delta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 6px 12px;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--color-surface-2);
    font-size: var(--text-sm);
  }
  .delta.projects { flex-direction: column; align-items: stretch; }
  .name { min-width: 0; overflow-wrap: anywhere; }
  .values { display: inline-flex; align-items: center; gap: 8px; color: var(--color-subtle); min-width: 0; }
  .old { color: var(--color-muted-foreground); text-decoration: line-through; overflow-wrap: anywhere; }
  .new { color: var(--color-accent); font-weight: 600; overflow-wrap: anywhere; }

  .picture { display: inline-flex; }
  .picture.old { opacity: 0.55; }
  .proposed-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .proposed-text .text {
    margin: 0;
    max-height: 12lh;
    overflow: auto;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--color-surface-2);
    font-size: var(--text-sm);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .rows { display: flex; flex-direction: column; gap: 2px; }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: var(--control-sm);
    min-width: 0;
    cursor: pointer;
  }
  .row input { flex: none; margin: 0; }
  .action { flex: none; color: var(--color-subtle); }
  .project { min-width: 0; color: var(--color-accent); font-weight: 600; overflow-wrap: anywhere; }
  .row.removal .project { color: var(--color-danger); }
  .row:has(input:not(:checked)) .project { color: var(--color-muted-foreground); font-weight: 400; text-decoration: line-through; }

  .place { margin: 0; font-size: var(--text-xs); color: var(--color-subtle); }
  .hint { margin: 0; font-size: var(--text-sm); color: var(--color-muted-foreground); }

  .actions { display: flex; flex-wrap: wrap; gap: 6px; }

  /* Closed: one quiet row in the timeline, like an answered question. */
  .agent-setting-card.resolved {
    flex-direction: row;
    align-items: center;
    gap: var(--activity-gap);
    border: none;
    background: transparent;
    box-shadow: none;
    min-height: var(--control);
    padding: var(--activity-padding);
    color: var(--color-muted-foreground);
  }
  .resolved .glyph { width: var(--activity-glyph); justify-content: center; color: var(--color-subtle); }
  .verdict { flex: none; font-size: var(--text-sm); }
  .given { min-width: 0; font-size: var(--text-sm); color: var(--color-foreground); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
</style>
