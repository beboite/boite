<!--
  The threads the companion hands to other agents (`[[task: …]]`): a card per
  task waiting for the user's word, with the project and the instruction, to
  launch or cancel; then a card per thread launched, opening it in Boite on a
  click. Each card takes clicks (`data-hit`).
-->
<script lang="ts">
  import { GitBranch, Rocket, X } from '@lucide/svelte';
  import type { Tasks } from '../../lib/companion/tasks.svelte';
  import { fill, strings } from '../../lib/strings';

  interface Props {
    tasks: Tasks;
    onopen: (threadId: string) => void;
  }

  let { tasks, onopen }: Props = $props();

  const copy = strings.companion;

  function open(threadId: string) {
    tasks.dismiss(threadId);
    onopen(threadId);
  }
</script>

{#each tasks.pending as task (task.id)}
  <div class="card ask" data-hit role="group" aria-label={fill(copy.task.confirmTitle, { project: task.project })} data-testid="companion-task-confirm">
    <header>
      <span class="mark" aria-hidden="true"><Rocket size={14} /></span>
      <span class="title">{fill(copy.task.confirmTitle, { project: task.project })}</span>
      {#if task.worktree}<span class="branch" aria-hidden="true"><GitBranch size={12} /></span>{/if}
    </header>
    <p class="prompt">{task.prompt}</p>
    <div class="actions">
      <button class="ghost small" disabled={tasks.launching === task.id} onclick={() => tasks.cancel(task.id)} data-testid="companion-task-cancel">{copy.task.cancel}</button>
      <button class="primary small" disabled={tasks.launching !== null} onclick={() => void tasks.confirm(task.id)} data-testid="companion-task-launch">{copy.task.launch}</button>
    </div>
  </div>
{/each}

{#each tasks.launched as task (task.threadId)}
  <div class="card launched" data-hit role="status" data-testid="companion-task-launched">
    <button class="ghost row" title={copy.task.openHint} onclick={() => open(task.threadId)}>
      <span class="mark" aria-hidden="true"><Rocket size={14} /></span>
      <span class="body">
        <span class="title">{fill(copy.task.launched, { project: task.project })}</span>
        <span class="hint">{task.title || copy.untitled}</span>
      </span>
    </button>
    <button class="ghost icon" aria-label={copy.dismiss} title={copy.dismiss} onclick={() => tasks.dismiss(task.threadId)}><X size={13} /></button>
  </div>
{/each}

<style>
  .card {
    width: 340px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
    box-shadow: var(--shadow-e2);
    animation: rise var(--dur-2) var(--ease-out-quint);
  }

  .ask {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 8px 8px 12px;
    border-color: var(--color-accent);
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .mark,
  .branch {
    flex: none;
    display: grid;
    color: var(--color-accent);
  }
  .branch {
    color: var(--color-muted-foreground);
  }
  .title {
    min-width: 0;
    font-size: var(--text-sm);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .prompt {
    margin: 0;
    max-height: 96px;
    overflow-y: auto;
    scrollbar-width: thin;
    font-size: var(--text-xs);
    line-height: 1.45;
    color: var(--color-muted-foreground);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }
  .small {
    height: var(--control-sm);
    padding: 0 10px;
    font-size: var(--text-xs);
  }

  .launched {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px;
  }
  .row {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    height: auto;
    padding: 4px 8px;
    justify-content: flex-start;
    font-weight: 400;
    text-align: start;
  }
  .body {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .hint {
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .icon {
    flex: none;
    width: 24px;
    height: 24px;
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .card {
      animation: none;
    }
  }
</style>
