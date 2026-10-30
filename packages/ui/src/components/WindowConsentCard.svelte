<script lang="ts">
  import { AppWindow, ShieldCheck, ShieldX } from '@lucide/svelte';
  import type { MessagePart, WindowConsentAnswer } from '@boite/contracts';
  import { errorText } from '../lib/errors';
  import { keepFocus } from '../lib/focus';
  import { dayClock } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /**
   * An agent asked to capture an app its project does not allow (docs/windows.md):
   * Allow once, Always for this project or Refuse, from any of the owner's
   * devices. The core holds the capture until `expiresAt`; past it, or once
   * answered, the card shrinks to one quiet row like an answered question.
   */
  let { store, threadId, agent, part }: {
    store: Store;
    threadId: string;
    /** Who asks: the agent's own name, else its provider's. */
    agent: string;
    part: Extract<MessagePart, { type: 'window_consent' }>;
  } = $props();
  const s = strings.windows.consent;

  let busy = $state(false), error = $state(''), now = $state(Date.now());
  const outcome = $derived(part.answer ?? (now >= part.expiresAt ? 'expired' : null));
  const what = $derived(part.kind === 'clip' ? s.clip : part.kind === 'stream' ? s.stream : part.kind === 'read' ? s.read : s.screenshot);
  const asks = $derived(fill(part.kind === 'read' ? s.asksRead : s.asks, { agent, process: part.process }));
  const verdict = $derived(outcome === 'once' ? s.allowedOnce : outcome === 'always' ? s.allowedAlways : outcome === 'refuse' ? s.refused : s.expired);

  // The card turns itself over when the wait ends, without waiting for the core's word.
  $effect(() => {
    if (part.answer !== null) return;
    const left = part.expiresAt - Date.now();
    if (left <= 0) { now = Date.now(); return; }
    const timer = setTimeout(() => { now = Date.now(); }, left + 50);
    return () => clearTimeout(timer);
  });

  async function answer(given: WindowConsentAnswer): Promise<void> {
    const client = store.client;
    if (busy || !client) return;
    busy = true; error = '';
    try { await client.call('windows.consent', { threadId, requestId: part.requestId, answer: given }); }
    catch (cause) { error = errorText(cause); busy = false; }
  }
</script>

{#if outcome !== null}
  <div class="consent resolved" data-testid="window-consent" data-state="answered" data-outcome={outcome} title={part.path}>
    <span class="glyph">{#if outcome === 'once' || outcome === 'always'}<ShieldCheck size={15} strokeWidth={1.75} />{:else}<ShieldX size={15} strokeWidth={1.75} />{/if}</span>
    <span class="verdict ui-label" data-testid="window-consent-verdict">{fill(verdict, { process: part.process })}</span>
  </div>
{:else}
  <div class="consent" data-testid="window-consent" data-state="pending" role="group" aria-label={asks}>
    <div class="head">
      <span class="glyph"><AppWindow size={15} strokeWidth={1.75} /></span>
      <span class="reason" data-testid="window-consent-asks">{asks}</span>
    </div>
    <div class="delta">
      <span>{what}</span>
      <code class="path" title={part.path}>{part.path}</code>
    </div>
    <p class="hint">{fill(part.kind === 'read' ? s.readWaits : s.waits, { time: dayClock(part.expiresAt) })}</p>
    {#if error}<p class="error" role="status" data-testid="window-consent-error">{error}</p>{/if}
    <div class="actions">
      <button type="button" class="primary" data-testid="window-consent-once" disabled={busy} onmousedown={keepFocus} onclick={() => answer('once')}><span class="ui-label">{s.once}</span></button>
      <button type="button" class="ghost" data-testid="window-consent-always" disabled={busy} onmousedown={keepFocus} onclick={() => answer('always')}><span class="ui-label">{s.always}</span></button>
      <button type="button" class="ghost" data-testid="window-consent-refuse" disabled={busy} onmousedown={keepFocus} onclick={() => answer('refuse')}><span class="ui-label">{s.refuse}</span></button>
    </div>
  </div>
{/if}

<style>
  .consent {
    border: 1px solid var(--color-edge);
    border-left-style: dashed;
    border-radius: var(--radius-md);
    background: var(--color-surface);
    box-shadow: var(--shadow-e1);
    padding: 8px 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  .head { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .glyph { display: inline-flex; flex: none; color: var(--color-accent); }
  .reason { font-weight: 500; overflow-wrap: anywhere; }
  .delta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--color-surface-2);
    font-size: var(--text-sm);
    min-width: 0;
  }
  .path { font-size: var(--text-xs); color: var(--color-muted-foreground); overflow-wrap: anywhere; }
  .hint { margin: 0; font-size: var(--text-sm); color: var(--color-muted-foreground); }
  .error { margin: 0; font-size: var(--text-sm); color: var(--color-danger); overflow-wrap: anywhere; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; }

  /* Answered or expired: one quiet row in the timeline, like an answered question. */
  .consent.resolved {
    flex-direction: row;
    align-items: center;
    gap: var(--activity-gap);
    border: none;
    background: transparent;
    box-shadow: none;
    min-height: var(--control);
    padding: var(--activity-padding);
    color: var(--color-muted-foreground);
  }
  .resolved .glyph { width: var(--activity-glyph); justify-content: center; color: var(--color-subtle); }
  .verdict { min-width: 0; font-size: var(--text-sm); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
</style>
