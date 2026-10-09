<!--
  A field to answer a thread from the companion, under the card that told of
  it: Enter sends, Shift+Enter goes to the next line, Escape gives up. Words
  that could not go stay in the field.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { ArrowUp } from '@lucide/svelte';
  import { fill, strings } from '../../lib/strings';
  import { focusCompanion, inShell } from '../../lib/companion/shell';

  interface Props {
    /** The thread answered, for the field's label. */
    title: string;
    /** Sends the words; false keeps them in the field. */
    onsend: (text: string) => Promise<boolean>;
    oncancel: () => void;
    problem?: string;
  }

  let { title, onsend, oncancel, problem = '' }: Props = $props();

  const copy = strings.companion.reply;
  let text = $state('');
  let sending = $state(false);
  let field = $state<HTMLTextAreaElement | null>(null);

  onMount(() => {
    // The companion takes the keyboard only when asked: typing goes to the app in front otherwise.
    if (inShell()) void focusCompanion().catch(() => {});
    field?.focus();
  });

  async function send() {
    const words = text.trim();
    if (!words || sending) return;
    sending = true;
    try {
      if (await onsend(words)) text = '';
    } finally {
      sending = false;
    }
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void send();
    } else if (event.key === 'Escape') {
      // The window's Escape would close the panel or hide the bubbles.
      event.stopPropagation();
      oncancel();
    }
  }
</script>

<form
  class="reply"
  onsubmit={(event) => {
    event.preventDefault();
    void send();
  }}
>
  <div class="row">
    <textarea bind:this={field} bind:value={text} rows="2" aria-label={fill(copy.label, { title })} placeholder={copy.placeholder} readonly={sending} {onkeydown} data-testid="companion-reply-field"></textarea>
    <button type="submit" class="primary icon" aria-label={copy.send} title={copy.send} disabled={sending || !text.trim()} data-testid="companion-reply-send"><ArrowUp size={15} /></button>
  </div>
  {#if problem}<p class="problem" role="alert">{problem}</p>{/if}
</form>

<style>
  .reply {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .row {
    display: flex;
    align-items: flex-end;
    gap: 4px;
  }
  textarea {
    flex: 1;
    min-width: 0;
    min-height: 48px;
    max-height: 120px;
    padding: 6px 8px;
    resize: none;
    font: inherit;
    font-size: var(--text-sm);
    line-height: 1.4;
    scrollbar-width: thin;
  }
  .problem {
    font-size: var(--text-xs);
    color: var(--color-danger);
    overflow-wrap: anywhere;
  }
</style>
