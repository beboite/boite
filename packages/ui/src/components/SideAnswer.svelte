<script lang="ts">
  import { X, CornerUpRight } from '@lucide/svelte';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import Prose from './Prose.svelte';

  let { question, answer, error, store, threadId, requestId, onclose }: {
    question: string; answer: string | null; error: string | null;
    store: Store; threadId: string; requestId: string; onclose: () => void;
  } = $props();

  let forking = $state(false);
  async function fork(): Promise<void> {
    forking = true;
    try { await store.forkSideQuestion(threadId, requestId); }
    finally { forking = false; }
  }

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
  <button type="button" class="ghost icon-button close" aria-label={strings.btw.close} title={strings.btw.close} data-testid="btw-close" onclick={onclose}><X size={16} /></button>
  <div class="content">
    <p class="question"><code>/btw</code> {question}</p>
    {#if error}<p role="alert">{error}</p>
    {:else if answer === null}<p role="status">{strings.btw.loading}</p>
    {:else}<Prose text={answer} {store} {threadId} />{/if}
  </div>
  {#if answer !== null && !error && store.openThread?.projectId && !store.openThread.agentSessionId}
    <footer><button type="button" class="ghost" data-testid="btw-fork" disabled={forking} aria-busy={forking} aria-label={forking ? strings.btw.forking : strings.btw.fork} onclick={fork}><CornerUpRight size={14} /><span class="ui-label">{strings.btw.fork}</span></button></footer>
  {/if}
</section>

<style>
  .side-answer { position: relative; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-activity-surface); margin-bottom: 8px; overflow: hidden; }
  .close { position: absolute; top: 6px; right: 8px; }
  .content { padding: 8px 42px 8px 10px; max-height: 40dvh; overflow: auto; overflow-wrap: anywhere; }
  footer { display: flex; justify-content: flex-end; padding: 0 8px 6px; }
  footer button { display: flex; align-items: center; gap: 4px; min-height: 28px; font-size: 12px; }
  .question { min-height: 28px; margin: 0 0 6px; font-size: 13px; color: var(--color-muted-foreground); white-space: pre-wrap; overflow-wrap: anywhere; }
  .question code { color: var(--color-foreground); }
  @media (pointer: coarse) { footer button { min-height: 36px; } }
</style>
