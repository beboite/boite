<script lang="ts">
  import { Paperclip } from '@lucide/svelte';
  import type { Attachment, PreviewReference } from '@boite/contracts';
  import { strings } from '../lib/strings';

  /**
   * The prompts waiting behind the running turn, drawn where they will land: a
   * user bubble on the right, outline only and dashed, since it has not gone
   * yet. A click takes one back into the box; Send now sends them together.
   */
  let {
    queued,
    disabled,
    paused,
    sendNow,
    onrestore,
    onsendnow
  }: {
    queued: { text: string; attachments: Attachment[]; previewReferences?: PreviewReference[] }[];
    /** A prompt comes back only into an empty box, and never while one is going out. */
    disabled: boolean;
    /** A refusal held the queue: nothing goes until the user says so. */
    paused: boolean;
    /** What Send now would do: stop the turn, resume the held queue, or nothing. */
    sendNow: 'stop' | 'resume' | null;
    onrestore: (at: number) => void;
    onsendnow: () => void;
  } = $props();
</script>

<div class="queued" data-testid="composer-queued">
  {#each queued as entry, at (entry)}
    <button type="button" class="queued-bubble"
      title={strings.composer.editQueued}
      {disabled}
      onclick={() => onrestore(at)}>
      <span class="queued-text">{entry.text || strings.composer.attachAlt}</span>
      {#if entry.attachments.length || entry.previewReferences?.length}
        <span class="queued-extras">
          {#if entry.attachments.length}<span>{entry.attachments.length} <Paperclip size={12} /></span>{/if}
          {#if entry.previewReferences?.length}<span>@{entry.previewReferences.length}</span>{/if}
        </span>
      {/if}
    </button>
  {/each}
  <div class="queued-foot">
    <span>{paused ? strings.composer.queuedPaused : strings.composer.queued}</span>
    {#if sendNow}
      <button type="button" class="ghost small" data-testid="composer-send-now"
        title={sendNow === 'stop' ? strings.composer.sendNowHint : strings.composer.retryQueuedHint}
        onclick={onsendnow}>{strings.composer.sendNow}</button>
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
