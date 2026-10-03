<script lang="ts">
  import { Clock, Paperclip, X } from '@lucide/svelte';
  import type { Attachment, PreviewReference } from '@boite/contracts';
  import type { OutboxRequest } from '../lib/store/composer.svelte';
  import { fill, strings } from '../lib/strings';

  /**
   * The prompts waiting behind the running turn, drawn where they will land: a
   * user bubble on the right, outline only and dashed, since it has not gone
   * yet. A click takes one back into the box; Send now sends them together.
   * One written while the machine was away says so under it, or says why the
   * core refused it, with Send again; any of them can be removed.
   */
  let {
    queued,
    disabled,
    paused,
    sending = false,
    connected = true,
    machine = '',
    sendNow,
    onrestore,
    onremove,
    onretry,
    onsendnow
  }: {
    queued: { text: string; attachments: Attachment[]; previewReferences?: PreviewReference[]; request?: OutboxRequest }[];
    /** A prompt comes back only into an empty box, and never while one is going out. */
    disabled: boolean;
    /** A refusal held the queue: nothing goes until the user says so. */
    paused: boolean;
    /** The first prompt is going out now. */
    sending?: boolean;
    /** The machine answers: an outbox prompt waits for the thread, not for it. */
    connected?: boolean;
    machine?: string;
    /** What Send now would do: steer the turn, resume the held queue, or nothing. */
    sendNow: 'steer' | 'resume' | null;
    onrestore: (at: number) => void;
    onremove?: (at: number) => void;
    onretry?: (at: number) => void;
    onsendnow: () => void;
  } = $props();

  let outbox = $derived(queued.length > 0 && queued.every((entry) => entry.request));
</script>

<div class="queued" data-testid="composer-queued">
  {#each queued as entry, at (entry)}
    <div class="queued-item" class:failed={entry.request?.failed !== undefined} data-testid="composer-queued-item">
      <button type="button" class="queued-bubble"
        title={strings.composer.editQueued}
        {disabled}
        onclick={() => onrestore(at)}>
        <span class="queued-text ui-label">{entry.text || strings.composer.attachAlt}</span>
        {#if entry.attachments.length || entry.previewReferences?.length}
          <span class="queued-extras">
            {#if entry.attachments.length}<span><span class="ui-label">{entry.attachments.length}</span> <Paperclip size={12} /></span>{/if}
            {#if entry.previewReferences?.length}<span>@{entry.previewReferences.length}</span>{/if}
          </span>
        {/if}
      </button>
      {#if entry.request || onremove}
        <div class="queued-state">
          {#if entry.request?.failed !== undefined}
            <span class="queued-error" data-testid="composer-outbox-failed">{fill(strings.composer.outboxFailed, { reason: entry.request.failed })}</span>
            {#if onretry}
              <button type="button" class="ghost small" data-testid="composer-outbox-retry" disabled={sending} onclick={() => onretry(at)}><span class="ui-label">{strings.composer.outboxRetry}</span></button>
            {/if}
          {:else if entry.request}
            <span class="queued-pending" data-testid="composer-outbox-pending"><Clock size={12} />{sending && at === 0 ? strings.composer.outboxSending
              : connected ? strings.composer.outboxNext : fill(strings.composer.outboxWaiting, { machine })}</span>
          {/if}
          {#if onremove}
            <button type="button" class="ghost small icon" data-testid="composer-queued-remove"
              title={strings.composer.removeQueued} aria-label={strings.composer.removeQueued}
              disabled={sending && at === 0} onclick={() => onremove(at)}><X size={14} /></button>
          {/if}
        </div>
      {/if}
    </div>
  {/each}
  <div class="queued-foot">
    <span class="ui-label">{outbox ? strings.composer.outboxKept : paused ? strings.composer.queuedPaused : strings.composer.queued}</span>
    {#if sendNow}
      <button type="button" class="ghost small" data-testid="composer-send-now"
        title={sendNow === 'steer' ? strings.composer.sendNowHint : strings.composer.retryQueuedHint}
        onclick={onsendnow}><span class="ui-label">{strings.composer.sendNow}</span></button>
    {/if}
  </div>
</div>

<style>
  .queued {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
    width: 100%;
    max-width: var(--content);
    max-height: 35vh;
    margin: 0 auto 8px;
    overflow-y: auto;
  }

  /* The user bubble of the timeline, minus its fill and shadow: the dashes say
     it is written but not sent. */
  .queued-bubble {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    flex: none;
    max-width: 75%;
    height: auto;
    padding: 10px 14px;
    border: 1px dashed color-mix(in oklch, var(--color-accent) 60%, transparent);
    border-radius: var(--radius-lg);
    border-bottom-right-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-foreground);
    font-weight: 400;
    font-size: var(--text-base);
    line-height: 1.5;
    text-align: left;
    white-space: normal;
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  .queued-bubble:hover:not(:disabled) {
    background: transparent;
    border-color: var(--color-accent);
  }

  /* Still waiting to go while the box holds other text: the bubble stays legible. */
  .queued-bubble:disabled { opacity: 1; }

  .queued-text {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    overflow: hidden;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .queued-item {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    flex: none;
    max-width: 75%;
  }

  .queued-item > .queued-bubble { max-width: 100%; }

  .queued-item.failed > .queued-bubble { border-color: var(--color-danger); }

  .queued-state {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 4px;
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
  }

  .queued-pending { display: inline-flex; align-items: center; gap: 4px; }

  .queued-error {
    color: var(--color-danger);
    overflow-wrap: anywhere;
    text-align: right;
  }

  .queued-state button { font-size: var(--text-xs); }

  .queued-extras { display: flex; gap: 8px; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .queued-extras > span { display: inline-flex; align-items: center; gap: 4px; }

  .queued-foot {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: none;
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
  }

  .queued-foot button { font-size: var(--text-xs); }
</style>
