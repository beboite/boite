<script lang="ts">
  import { MailWarning } from '@lucide/svelte';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';
  import InfoTip from './InfoTip.svelte';

  /*
   * Above the composer of a thread whose history read contact mail sent
   * outside a shared project. The core refuses every turn there until the
   * owner trusts that history; this says so before the send, with the way
   * out. A paired phone cannot trust it and is told where to.
   */
  let { store, threadId, contacts }: { store: Store; threadId: string; contacts: string[] } = $props();
  const t = $derived(strings.sidebar.contactHold);
  let trusting = $state(false);

  async function trust() {
    trusting = true;
    try { await store.trustContactHistory(threadId); } finally { trusting = false; }
  }
</script>

<article class="contact-hold" data-testid="contact-hold" role="status">
  <span class="mark"><MailWarning size={16} aria-hidden="true" /></span>
  <div class="text">
    <strong>{t.title}</strong>
    <p>{fill(t.body, { contacts: contacts.join(', ') })}{#if !store.owner} {t.ownerOnly}{/if}</p>
  </div>
  {#if store.owner}
    <div class="actions">
      <button type="button" class="small" data-testid="contact-hold-trust" disabled={trusting} onclick={trust}><span class="ui-label">{t.trust}</span></button>
      <InfoTip topic={t.trust} text={t.trustTip} />
    </div>
  {/if}
</article>

<style>
  .contact-hold {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 10px;
    /* The composer's own column, like the notice of a project folder that is gone. */
    flex: none;
    box-sizing: border-box;
    width: min(calc(100% - 40px), var(--content));
    margin: 0 auto 8px;
    padding: 10px 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface-2);
    font-size: var(--text-sm);
  }
  .mark { display: flex; flex: none; padding-top: 2px; color: var(--color-muted-foreground); }
  .text { flex: 1 1 240px; min-width: 0; }
  p { margin: 2px 0 0; color: var(--color-muted-foreground); line-height: 1.5; overflow-wrap: anywhere; }
  .actions { display: flex; flex: none; align-items: center; gap: 4px; margin-left: auto; }
  @media (max-width: 720px) { .contact-hold { width: calc(100% - 20px); } }
</style>
