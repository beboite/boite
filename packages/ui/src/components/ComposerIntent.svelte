<script lang="ts">
  import { MessageCircleQuestionMark, Pencil, X } from '@lucide/svelte';
  import type { QuestionRequest } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';

  /**
   * One quiet line above the box when Send does something else than send a
   * message: replace a sent one, or answer a question. The way out is on its right.
   */
  let { editing, reply, oncancel, onignore }: {
    editing: boolean;
    reply: QuestionRequest | null;
    oncancel: () => void;
    onignore: () => void;
  } = $props();
</script>

{#if editing}
  <div class="intent" data-testid="composer-editing">
    <Pencil size={13} />
    <span>{strings.composer.editing}</span>
    <button type="button" class="ghost small icon" data-testid="composer-editing-cancel" title={strings.composer.editingCancel} aria-label={strings.composer.editingCancel} onclick={oncancel}><X size={13} /></button>
  </div>
{:else if reply}
  <div class="intent" data-testid="composer-reply" data-question={reply.id}>
    <MessageCircleQuestionMark size={13} />
    <span class="question" title={reply.text}>{fill(strings.composer.replying, { question: reply.text })}</span>
    <button type="button" class="ghost small" data-testid="composer-reply-ignore" title={strings.composer.replyIgnoreHint} onclick={onignore}>{strings.composer.replyIgnore}</button>
  </div>
{/if}

<style>
  .intent {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 6px 0 14px;
    color: var(--color-accent);
    font-size: var(--text-xs);
  }
  .intent span { flex: 1; min-width: 0; }
  .question { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
</style>
