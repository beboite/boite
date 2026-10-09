<!--
  What the companion shows under itself besides its panel: the reminders that
  rang, its reply, the other conversations that finished, and a word when
  Boite is out of reach. Each block takes clicks (`data-hit`).
-->
<script lang="ts">
  import { BellRing, CircleAlert, ExternalLink, Square, X } from '@lucide/svelte';
  import { fill, strings } from '../../lib/strings';
  import { showMain } from '../../lib/companion/shell';
  import type { Talk } from '../../lib/companion/talk.svelte';
  import type { Notes } from '../../lib/companion/notes.svelte';

  interface Props {
    talk: Talk;
    notes: Notes;
    /** The panel is open: the notices wait behind it. */
    open: boolean;
    reachable: boolean;
    threadId: string | null;
  }

  let { talk, notes, open, reachable, threadId }: Props = $props();

  const copy = strings.companion;

  function openNotice(id: string, thread: string) {
    notes.dismiss(id);
    void showMain(thread);
  }
</script>

{#each notes.alarms as alarm (alarm.id)}
  <div class="card alarm" data-hit role="alert" data-testid="companion-alarm">
    <span class="mark"><BellRing size={14} /></span>
    <p class="body"><span class="label">{copy.reminder}</span>{alarm.text}</p>
    <div class="actions">
      <button class="ghost small" onclick={() => notes.snooze(alarm.id)} title={copy.snoozeLabel}>{copy.snooze}</button>
      <button class="primary small" onclick={() => notes.done(alarm.id)}>{copy.reminderDone}</button>
    </div>
  </div>
{/each}

{#if talk.shown && talk.phase !== 'none'}
  <div class="card bubble" data-hit role="status" aria-live="polite" data-testid="companion-reply">
    {#if talk.problem}
      <p class="text problem">{talk.problem}</p>
    {:else if talk.reply}
      <p class="text">{talk.reply}</p>
    {:else}
      <p class="text waiting">{copy.thinking}</p>
    {/if}
    <div class="tools">
      {#if talk.thinking}
        <button class="ghost icon" aria-label={copy.stop} title={copy.stop} onclick={() => void talk.stop()}><Square size={13} /></button>
      {/if}
      {#if threadId}
        <button class="ghost icon" aria-label={copy.openThread} title={copy.openThread} onclick={() => void showMain(threadId)}><ExternalLink size={13} /></button>
      {/if}
      <button class="ghost icon" aria-label={copy.hideReply} title={copy.hideReply} onclick={() => talk.hide()}><X size={13} /></button>
    </div>
  </div>
{/if}

{#if !open}
  {#each notes.notices as notice (notice.id)}
    <div class="card notice" class:failed={notice.failed} data-hit role="status" data-testid="companion-notice">
      <button class="ghost open" title={copy.openNotice} onclick={() => openNotice(notice.id, notice.threadId)}>
        {#if notice.failed}<span class="mark"><CircleAlert size={13} /></span>{/if}
        <span class="lines">
          <span class="title">{fill(notice.failed ? copy.failedThread : copy.finished, { title: notice.title })}</span>
          {#if notice.line}<span class="line">{notice.line}</span>{/if}
        </span>
      </button>
      <button class="ghost icon" aria-label={copy.dismiss} title={copy.dismiss} onclick={() => notes.dismiss(notice.id)}><X size={13} /></button>
    </div>
  {/each}
{/if}

{#if !reachable && open}
  <p class="card toast problem" data-hit role="alert">{copy.unreachable}</p>
{/if}

<style>
  .card {
    max-width: 380px;
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    box-shadow: var(--shadow-e2);
    animation: rise var(--dur-2) var(--ease-out-quint);
  }

  .bubble {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    width: max-content;
    padding: 8px 6px 8px 12px;
    border-radius: var(--radius-lg);
  }
  .text {
    max-height: 220px;
    overflow-y: auto;
    font-size: var(--text-sm);
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    scrollbar-width: thin;
  }
  .waiting {
    color: var(--color-muted-foreground);
  }
  .problem {
    font-size: var(--text-sm);
    color: var(--color-danger);
  }
  .tools {
    flex: none;
    display: flex;
  }
  .tools button {
    width: 24px;
    height: 24px;
  }

  .alarm {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 380px;
    padding: 8px 8px 8px 12px;
    border-color: var(--color-accent);
    border-radius: var(--radius-lg);
  }
  .alarm .mark {
    flex: none;
    display: grid;
    color: var(--color-accent);
  }
  .alarm .body {
    flex: 1;
    min-width: 0;
    font-size: var(--text-sm);
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .label {
    display: block;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }
  .actions {
    flex: none;
    display: flex;
    gap: 4px;
  }
  .small {
    height: var(--control-sm);
    padding: 0 10px;
    font-size: var(--text-xs);
  }

  .notice {
    display: flex;
    align-items: flex-start;
    gap: 2px;
    width: max-content;
    padding: 3px;
    border-radius: var(--radius-lg);
  }
  .notice .open {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    min-width: 0;
    height: auto;
    padding: 4px 6px 4px 9px;
    text-align: start;
    white-space: normal;
  }
  .notice .mark {
    flex: none;
    display: grid;
    padding-top: 2px;
    color: var(--color-danger);
  }
  .lines {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .title {
    font-size: var(--text-xs);
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .line {
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .notice .icon {
    flex: none;
    width: 24px;
    height: 24px;
  }

  .toast {
    padding: 5px 12px;
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }
</style>
