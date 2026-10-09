<!--
  The cards of the pomodoro and the focus, under the character with its other
  cards: the break the companion takes with the user, with a way to skip it,
  and once a focus ends, the threads that finished meanwhile, each opening in
  Boite on a click. Each card takes clicks (`data-hit`).
-->
<script lang="ts">
  import { CircleAlert, Coffee, X } from '@lucide/svelte';
  import type { Focus, PomodoroTimer } from '../../lib/companion/focus.svelte';
  import { count } from '../../lib/companion/describe';
  import { fill, strings } from '../../lib/strings';

  interface Props {
    timer: PomodoroTimer;
    focus: Focus;
    onopen: (threadId: string) => void;
  }

  let { timer, focus, onopen }: Props = $props();

  const copy = strings.companion;
  const breakMinutes = $derived(timer.current ? Math.round(timer.current.breakMs / 60_000) : 0);

  function open(threadId: string) {
    focus.drop(threadId);
    onopen(threadId);
  }
</script>

{#if timer.phase === 'break'}
  <div class="card rest" data-hit role="status" data-testid="companion-break">
    <span class="mark" aria-hidden="true"><Coffee size={15} /></span>
    <p class="body">
      <span class="title">{fill(copy.pomodoro.breakTitle, { minutes: String(breakMinutes) })}</span>
      <span class="hint">{copy.pomodoro.breakHint}</span>
    </p>
    <button class="ghost small" onclick={() => timer.skip()} data-testid="companion-break-skip">{copy.pomodoro.skip}</button>
  </div>
{/if}

{#if focus.recap.length > 0 && !focus.active}
  <div class="card recap" data-hit role="status" data-testid="companion-focus-recap">
    <header>
      <span class="title">{count(focus.recap.length, copy.focus.recapOne, copy.focus.recapMany)}</span>
      <button class="ghost icon" aria-label={copy.dismiss} title={copy.dismiss} onclick={() => focus.drop(null)}><X size={13} /></button>
    </header>
    <ul>
      {#each focus.recap as item (item.threadId)}
        <li>
          <button class="ghost row" title={copy.openNotice} onclick={() => open(item.threadId)}>
            {#if item.failed}<span class="failed" aria-hidden="true"><CircleAlert size={12} /></span>{/if}
            <span class="name">{fill(item.failed ? copy.failedThread : copy.finished, { title: item.title || copy.untitled })}</span>
          </button>
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  .card {
    max-width: 380px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
    box-shadow: var(--shadow-e2);
    animation: rise var(--dur-2) var(--ease-out-quint);
  }

  .rest {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 340px;
    padding: 8px 8px 8px 12px;
    border-color: var(--color-success);
  }
  .mark {
    flex: none;
    display: grid;
    color: var(--color-success);
  }
  .body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
    font-size: var(--text-xs);
    line-height: 1.4;
  }
  .title {
    font-size: var(--text-sm);
    font-weight: 600;
  }
  .hint {
    color: var(--color-muted-foreground);
  }
  .small {
    flex: none;
    height: var(--control-sm);
    padding: 0 10px;
    font-size: var(--text-xs);
  }

  .recap {
    width: 320px;
    padding: 4px 4px 6px;
  }
  .recap header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding-left: 8px;
  }
  .recap header .title {
    font-size: var(--text-xs);
  }
  .recap .icon {
    width: 24px;
    height: 24px;
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
    max-height: 160px;
    overflow-y: auto;
    scrollbar-width: thin;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: auto;
    padding: 4px 8px;
    justify-content: flex-start;
    font-size: var(--text-xs);
    font-weight: 400;
    text-align: start;
  }
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .failed {
    flex: none;
    display: grid;
    color: var(--color-danger);
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
