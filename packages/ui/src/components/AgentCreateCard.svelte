<script lang="ts">
  import { Bot } from '@lucide/svelte';
  import type { AgentCreateAsk, QuestionAnswer } from '@boite/contracts';
  import { errorText } from '../lib/errors';
  import { experimentOn } from '../lib/experiments.svelte';
  import { keepFocus } from '../lib/focus';
  import { projectName } from '../lib/agent-setting-requests';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /**
   * A card asking the user to create a bot (`agents.settings.create`). Create
   * goes through `agents.settings.apply`; the core settles the card once a bot
   * of that name exists, made from here or on the Agents page.
   */
  let {
    store,
    threadId,
    questionId,
    text,
    create,
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
    create: AgentCreateAsk;
    answer: QuestionAnswer | null;
    /** False on a card that closed without an answer. */
    pending: boolean;
    /** Drawn inside the dock above the composer, whose own row names it: no frame, no heading. */
    docked?: boolean;
    /** Answers the card with `refuse`. False gives it back. */
    respond: (optionId: 'refuse') => Promise<unknown>;
  } = $props();

  let busy = $state(false);

  const words = $derived(strings.agentCreateRequest);
  const names = $derived({ projects: store.projects, providers: store.providers });
  const canShow = $derived(store.owner && experimentOn('resident-agents'));
  /** `Claude · Claude Opus 5.5 · High`, from the owning machine's providers. */
  const route = $derived.by(() => {
    const { providerId, model, effort } = create.selection;
    const provider = store.providers.find((entry) => entry.id === providerId);
    const known = provider?.models.find((entry) => entry.id === model);
    const level = effort === null ? words.defaultEffort : known?.effort?.levels.find((entry) => entry.id === effort)?.label ?? effort;
    return [provider?.name ?? providerId, known?.name ?? model ?? '', level].filter(Boolean).join(' · ');
  });
  const projects = $derived(create.projectIds.length === 0 ? words.noProjects : create.projectIds.map((id) => projectName(id, names)).join(', '));

  async function apply(): Promise<void> {
    const client = store.client;
    if (busy || !client) return;
    busy = true;
    try {
      await client.call('agents.settings.apply', { threadId, questionId });
      // The core settles the card once the bot exists; it stays busy until then.
    } catch (error) {
      store.error = errorText(error);
      busy = false;
    }
  }

  async function refuse(): Promise<void> {
    if (busy) return;
    busy = true;
    if ((await respond('refuse')) === false) busy = false;
  }

  function show(given: QuestionAnswer): void {
    if (typeof given.value === 'string') store.showAgents(given.value);
  }
</script>

<!-- An answer this client just sent clears the pending list before the card's answer arrives: it stays busy until then. -->
{#if answer !== null || (!pending && !busy)}
  <div class="agent-create-card resolved" data-testid="agent-create-card" data-state={answer === null ? 'closed' : 'answered'} data-outcome={answer?.optionIds[0]} title={text}>
    <span class="glyph"><Bot size={15} strokeWidth={1.75} /></span>
    <span class="verdict ui-label" data-testid="agent-create-verdict">{answer === null ? words.closed : answer.optionIds[0] === 'created' ? words.created : words.refused}</span>
    <span class="given ui-label">{create.name}</span>
    {#if answer?.optionIds[0] === 'created' && canShow}
      <button type="button" class="quiet" data-testid="agent-create-show" onmousedown={keepFocus} onclick={() => show(answer)}><span class="ui-label">{words.show}</span></button>
    {/if}
  </div>
{:else}
  <div class="agent-create-card" class:docked data-testid="agent-create-card" data-state="pending" role="group" aria-label={words.heading}>
    {#if !docked}
      <div class="head">
        <span class="glyph"><Bot size={15} strokeWidth={1.75} /></span>
        <span class="muted ui-label" data-testid="agent-create-heading">{words.heading}</span>
      </div>
    {/if}
    <p class="reason" data-testid="agent-create-reason">{text}</p>

    <dl class="draft" data-testid="agent-create-draft">
      <dt>{words.name}</dt>
      <dd class="name" data-testid="agent-create-name">{create.name}</dd>
      {#if create.domain}
        <dt>{words.domain}</dt>
        <dd>{create.domain}</dd>
      {/if}
      <dt>{words.model}</dt>
      <dd data-testid="agent-create-model">{route}</dd>
      <dt>{words.projects}</dt>
      <dd data-testid="agent-create-projects">{projects}</dd>
      <dt>{words.instructions}</dt>
      <dd class="instructions" class:empty={!create.instructions} data-testid="agent-create-instructions">{create.instructions || words.noInstructions}</dd>
    </dl>
    <p class="hint">{store.owner ? words.access : words.guestHint}</p>

    <div class="actions">
      {#if store.owner}
        <button type="button" class="primary" data-testid="agent-create-apply" disabled={busy} onmousedown={keepFocus} onclick={apply}><span class="ui-label">{words.create}</span></button>
      {/if}
      <button type="button" class="ghost" data-testid="agent-create-refuse" disabled={busy} onmousedown={keepFocus} onclick={refuse}><span class="ui-label">{words.refuse}</span></button>
    </div>
  </div>
{/if}

<style>
  .agent-create-card {
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

  .agent-create-card.docked {
    border: none;
    background: transparent;
    box-shadow: none;
    padding: 4px 10px 8px;
  }

  .head { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .head .muted { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .glyph { display: inline-flex; flex: none; color: var(--color-accent); }

  .reason { margin: 0; font-weight: 500; white-space: pre-wrap; overflow-wrap: anywhere; }

  .draft {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 4px 12px;
    margin: 0;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--color-surface-2);
    font-size: var(--text-sm);
  }
  dt { color: var(--color-subtle); }
  dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  dd.name { color: var(--color-accent); font-weight: 600; }
  /* The instructions can run to pages: a few lines here, the whole text once the bot exists. */
  dd.instructions {
    white-space: pre-wrap;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  dd.empty { color: var(--color-muted-foreground); }

  .hint { margin: 0; font-size: var(--text-sm); color: var(--color-muted-foreground); }

  .actions { display: flex; flex-wrap: wrap; gap: 6px; }

  /* Closed: one quiet row in the timeline, like an answered question. */
  .agent-create-card.resolved {
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
  .given { min-width: 0; flex: 1; font-size: var(--text-sm); color: var(--color-foreground); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
</style>
