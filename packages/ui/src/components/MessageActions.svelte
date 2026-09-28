<script lang="ts">
  import { Check, Copy, GitFork, Pencil, RotateCcw } from '@lucide/svelte';
  import { contextMenu } from '../lib/context-menu.svelte';
  import { clockTime } from '../lib/format';
  import { formatLocale } from '../lib/i18n.svelte';
  import { fill, strings } from '../lib/strings';

  /**
   * The small buttons a message shows under itself while the pointer is on it,
   * or always under a finger: copy what it says, and for a turn the ways back
   * into it. Each action is offered only when its caller hands it over.
   */
  let {
    text,
    at,
    edit,
    fork,
    retry
  }: {
    /**
     * What the copy button puts on the clipboard; empty hides it. A function is
     * read at the click, so a streaming answer is not joined on every token.
     */
    text: string | (() => string);
    /** When the message was sent, shown as a clock and read in full on hover. */
    at?: number;
    /** Puts the prompt back in the composer to send again from before it. */
    edit?: () => void;
    /** Starts a new thread from here, in the same checkout or a worktree of its own. */
    fork?: (worktree: boolean) => void;
    /** Sends the same prompt again in place of this answer. */
    retry?: () => void;
  } = $props();

  let copied = $state(false);
  let reset = 0;

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(typeof text === 'function' ? text() : text);
    } catch {
      return;
    }
    copied = true;
    clearTimeout(reset);
    reset = window.setTimeout(() => { copied = false; }, 1500);
  }

  $effect(() => () => clearTimeout(reset));

  function openFork(event: MouseEvent): void {
    contextMenu.open(event, [
      { id: 'here', label: strings.chat.forkHere },
      { id: 'worktree', label: strings.chat.forkWorktree }
    ], (id) => fork?.(id === 'worktree'));
  }
</script>

<span class="message-actions" data-testid="message-actions">
  {#if at !== undefined}
    {@const full = new Date(at).toLocaleString(formatLocale(), { dateStyle: 'full', timeStyle: 'medium' })}
    <time class="stamp" data-testid="message-time" datetime={new Date(at).toISOString()} title={fill(strings.chat.sentAt, { time: full })}>{clockTime(at)}</time>
  {/if}
  {#if text}
    <button type="button" class="act" data-testid="message-copy" title={copied ? strings.chat.copied : strings.chat.copyMessage} aria-label={copied ? strings.chat.copied : strings.chat.copyMessage} onclick={() => void copy()}>
      {#if copied}<Check size={13} />{:else}<Copy size={13} />{/if}
    </button>
  {/if}
  {#if edit}
    <button type="button" class="act" data-testid="message-edit" title={strings.chat.editMessage} aria-label={strings.chat.editMessage} onclick={edit}><Pencil size={13} /></button>
  {/if}
  {#if retry}
    <button type="button" class="act" data-testid="message-retry" title={strings.chat.retry} aria-label={strings.chat.retry} onclick={retry}><RotateCcw size={13} /></button>
  {/if}
  {#if fork}
    <button type="button" class="act" data-testid="message-fork" title={strings.chat.fork} aria-label={strings.chat.fork} aria-haspopup="menu" onclick={openFork}><GitFork size={13} /></button>
  {/if}
</span>

<style>
  /* Out of the way until the message is pointed at or reached by the keyboard. */
  .message-actions {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    opacity: 0;
    transition: opacity var(--dur-2);
  }

  :global(.message:hover) .message-actions,
  .message-actions:focus-within {
    opacity: 1;
  }

  /* A finger has no hover: the buttons stay. */
  @media (hover: none) {
    .message-actions { opacity: 1; }
  }

  .stamp {
    margin: 0 4px;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .act {
    display: inline-grid;
    place-items: center;
    width: 24px;
    height: 24px;
    min-height: 0;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-muted-foreground);
  }

  .act:hover:not(:disabled) {
    background: var(--color-surface-3);
    color: var(--color-foreground);
  }

  /* A finger takes the full target, as every other phone control does. */
  @media (pointer: coarse) {
    .message-actions { gap: 0; }
    .act { width: var(--touch-target); height: var(--touch-target); }
  }
</style>
