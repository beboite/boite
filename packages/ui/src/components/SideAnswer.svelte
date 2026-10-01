<script lang="ts">
  import { X } from '@lucide/svelte';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import Prose from './Prose.svelte';

  let { question, answer, error, store, threadId, onclose }: {
    question: string; answer: string | null; error: string | null;
    store: Store; threadId: string; onclose: () => void;
  } = $props();

  $effect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onclose();
    };
    window.addEventListener('keydown', close, true);
    return () => window.removeEventListener('keydown', close, true);
  });
</script>

<section class="side-answer" aria-label={strings.btw.title} data-testid="btw-answer">
  <header>
    <span>{strings.btw.title}</span>
    <button type="button" class="ghost icon-button" aria-label={strings.btw.close} title={strings.btw.close} data-testid="btw-close" onclick={onclose}><X size={16} /></button>
  </header>
  <div class="content">
    <p class="question">{question}</p>
    {#if error}<p role="alert">{error}</p>
    {:else if answer === null}<p role="status">{strings.btw.loading}</p>
    {:else}<Prose text={answer} {store} {threadId} />{/if}
  </div>
</section>

<style>
  .side-answer { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-activity-surface); margin-bottom: 8px; overflow: hidden; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; font-size: 12px; color: var(--color-muted-foreground); }
  .content { padding: 0 12px 12px; max-height: 40dvh; overflow: auto; overflow-wrap: anywhere; }
  .question { margin: 0 0 10px; color: var(--color-muted-foreground); white-space: pre-wrap; }
</style>
