<script lang="ts">
  import type { ContactRequest, HeldContactLetter } from '@boite/contracts';
  import { untrack } from 'svelte';
  import { ArrowRight, Bell, Check, Mail, X } from '@lucide/svelte';
  import { Closing } from '../../lib/closing.svelte';
  import { contactsShown } from '../../lib/contacts-rail.svelte';
  import { openContact, watchContacts, type ContactsView } from '../../lib/contacts.svelte';
  import { count } from '../../lib/format';
  import type { Store } from '../../lib/store.svelte';
  import { fill, strings } from '../../lib/strings';
  import { machineName, workspace, type Machine } from '../../lib/workspace.svelte';

  /**
   * What waits for the owner from contacts, on every listed machine, oldest
   * first: a request opens its contact's page; a message outside a shared
   * project is read here and delivered, refused or opened on that page.
   */
  let { store }: { store: Store } = $props();
  type Row = { machine: Machine; view: ContactsView; key: string; createdAt: number }
    & ({ request: ContactRequest; letter?: undefined } | { letter: HeldContactLetter; request?: undefined });
  const watched = watchContacts(() => workspace.machinesOr(store).filter(machine => contactsShown(machine.store)));
  const waiting = $derived(watched().flatMap(({ machine, view }): Row[] => [
    ...(view.state?.requests ?? []).filter(request => request.direction === 'in' && request.status === 'pending')
      .map(request => ({ machine, view, key: `${machine.id}:${request.id}`, createdAt: request.createdAt, request })),
    ...(view.state?.mail ?? []).map(letter => ({ machine, view, key: `${machine.id}:mail:${letter.id}`, createdAt: letter.createdAt, letter }))
  ]).sort((a, b) => a.createdAt - b.createdAt));
  const pending = $derived(waiting.filter(row => row.machine.store.connection === 'ready'));
  const first = $derived(pending[0]);
  const label = $derived([
    [strings.contacts.requests.pending, pending.filter(row => row.request).length] as const,
    [strings.contacts.mail.pending, pending.filter(row => row.letter).length] as const
  ].filter(([, total]) => total > 0).map(([text, total]) => fill(text, { count: count(total) })).join(', '));
  let seen = $state<string[]>([]);
  $effect(() => {
    const live = new Set(waiting.map(row => row.key));
    if (seen.some(id => !live.has(id))) seen = seen.filter(id => live.has(id));
  });
  const next = $derived(pending.find(row => !seen.includes(row.key)));
  let displayed = $state<Row>();
  let failed = $state('');
  const toast = new Closing();
  $effect(() => {
    if (next) {
      if (next.key !== untrack(() => displayed?.key)) failed = '';
      displayed = next;
      toast.show();
    } else toast.hide();
  });
  function dismiss() { if (displayed) seen = [...seen, displayed.key]; }
  function review(row: Row) {
    seen = [...seen, row.key];
    void openContact(row.machine.store, (row.request ?? row.letter).coreId);
  }
  async function decide(row: Row, accept: boolean) {
    if (!row.letter) return;
    failed = await row.view.decideMail(row.letter.id, accept) ? '' : row.view.error;
  }
</script>

{#if first}
  <button type="button" class="ghost icon indicator" data-testid="contact-request-open" title={label} aria-label={label} onclick={() => review(first)}>
    <Bell size={17} strokeWidth={1.75} /><span class="badge">{count(pending.length)}</span>
  </button>
{/if}
{#if displayed && toast.shown}
  <div class="notice" class:closing={toast.closing} use:toast.attach onanimationend={toast.end} role="status" data-testid="contact-request-notice" data-kind={displayed.letter ? 'mail' : 'request'}>
    {#if displayed.letter}
      {@const letter = displayed.letter}
      {@const busy = displayed.view.isBusy(`mail:${letter.id}`) || toast.closing}
      <div class="row letter">
        <span class="bell"><Mail size={18} strokeWidth={1.75} /></span>
        <span class="copy">
          <span class="heading"><span>{fill(strings.contacts.mail.writes, { contact: letter.contact, thread: letter.thread })}</span><span class="machine">{machineName(displayed.machine)}</span></span>
          <span class="excerpt full" data-testid="contact-mail-notice-text">{letter.text}</span>
          {#if failed}<span class="failed" role="alert">{failed}</span>{/if}
          <span class="actions">
            <button type="button" class="primary small" disabled={busy} title={fill(strings.contacts.mail.deliverTip, { thread: letter.thread })}
              onclick={() => void decide(displayed!, true)} data-testid="contact-mail-notice-deliver"><Check size={14} strokeWidth={2.25} /><span class="ui-label">{strings.contacts.mail.deliver}</span></button>
            <button type="button" class="ghost small" disabled={busy} title={strings.contacts.mail.refuseTip}
              onclick={() => void decide(displayed!, false)} data-testid="contact-mail-notice-refuse"><X size={14} /><span class="ui-label">{strings.contacts.mail.refuse}</span></button>
            <button type="button" class="ghost small details" onclick={() => review(displayed!)} data-testid="contact-mail-notice-details"><span class="ui-label">{strings.contacts.mail.details}</span><ArrowRight size={14} strokeWidth={1.75} /></button>
          </span>
        </span>
        {#if pending.length > 1}<span class="count">{count(pending.length)}</span>{/if}
      </div>
    {:else}
      <button type="button" class="row request" data-testid="contact-request-review"
        title={strings.contacts.requests.review} onclick={() => review(displayed!)}>
        <span class="bell"><Bell size={18} strokeWidth={1.75} /></span>
        <span class="copy">
          <span class="heading"><span>{fill(strings.contacts.requests.asks, { contact: displayed.request.contact })}</span><span class="machine">{machineName(displayed.machine)}</span></span>
          <span class="excerpt">{displayed.request.text}</span>
        </span>
        {#if pending.length > 1}<span class="count">{count(pending.length)}</span>{/if}
        <ArrowRight size={16} strokeWidth={1.75} />
      </button>
    {/if}
    <button type="button" class="ghost icon dismiss" aria-label={strings.common.dismiss} title={strings.common.dismiss} onclick={dismiss} data-testid="contact-request-dismiss"><X size={14} /></button>
  </div>
{/if}

<style>
  .indicator { position: relative; flex: none; color: var(--color-accent); }
  .badge { position: absolute; top: -2px; right: -4px; min-width: 15px; padding: 1px 3px; font-size: var(--text-xs); line-height: 14px; border-radius: var(--radius-full); background: var(--color-accent); color: var(--color-accent-ink); }
  .notice { position: fixed; z-index: 80; top: calc(var(--titlebar) + 12px); left: 50%; transform: translateX(-50%); width: min(440px, calc(100vw - 32px)); animation: fade var(--dur-2) var(--ease-out-quint); }
  .notice.closing { animation: fade-out var(--dur-2) var(--ease-out-quint) forwards; }
  .dismiss { position: absolute; top: 2px; right: 2px; width: 24px; height: 24px; color: var(--color-subtle); }
  .row { display: flex; align-items: center; gap: 12px; width: 100%; height: auto; min-height: 64px; padding: 12px 30px 12px 14px; text-align: left; background: var(--color-surface-2); border: 1px solid var(--color-accent); border-radius: var(--radius-lg); box-shadow: var(--shadow-e3); color: var(--color-foreground); }
  .request:hover { background: var(--color-hover); }
  /* No arrow closes this row: keep the machine name clear of the dismiss button. */
  .letter { align-items: flex-start; padding-right: 40px; }
  .bell { display: grid; place-items: center; flex: none; width: 32px; height: 32px; border-radius: var(--radius-md); background: var(--color-accent-soft); color: var(--color-accent); }
  .copy { display: grid; flex: 1; gap: 4px; min-width: 0; }
  .heading { display: flex; align-items: baseline; gap: 8px; min-width: 0; font-size: var(--text-sm); font-weight: 600; }
  .heading > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .machine { margin-left: auto; font-size: var(--text-xs); font-weight: 400; color: var(--color-subtle); }
  .excerpt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); font-weight: 400; color: var(--color-muted-foreground); }
  /* A message is read here before it is delivered: a few lines of it, the rest on its contact's page. */
  .excerpt.full { display: -webkit-box; -webkit-line-clamp: 4; line-clamp: 4; -webkit-box-orient: vertical; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--color-foreground); }
  .failed { font-size: var(--text-xs); color: var(--color-danger); overflow-wrap: anywhere; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 4px; }
  .details { margin-left: auto; color: var(--color-muted-foreground); }
  .count { flex: none; font-size: var(--text-xs); color: var(--color-accent); }
  .letter .count { margin-top: 2px; }
  .request > :global(svg) { flex: none; color: var(--color-accent); }
  @media (max-width: 720px) {
    .notice { top: calc(68px + env(safe-area-inset-top)); width: calc(100vw - 24px); }
    .machine { max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .actions > button { min-height: var(--touch-target); }
  }
  @media (prefers-reduced-motion: reduce) { .notice { animation-duration: 1ms; } }
  :global(html[data-motion='reduced']) .notice { animation-duration: 1ms; }
</style>
