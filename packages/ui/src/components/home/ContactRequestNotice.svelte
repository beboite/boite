<script lang="ts">
  import { ArrowRight, Bell, X } from '@lucide/svelte';
  import { Closing } from '../../lib/closing.svelte';
  import { contactsShown } from '../../lib/contacts-rail.svelte';
  import { openContact, watchContacts } from '../../lib/contacts.svelte';
  import { count } from '../../lib/format';
  import type { Store } from '../../lib/store.svelte';
  import { fill, strings } from '../../lib/strings';
  import { machineName, workspace } from '../../lib/workspace.svelte';

  let { store }: { store: Store } = $props();
  const watched = watchContacts(() => workspace.machinesOr(store).filter(machine => contactsShown(machine.store)));
  const waiting = $derived(watched().flatMap(({ machine, view }) => (view.state?.requests ?? [])
    .filter(request => request.direction === 'in' && request.status === 'pending').map(request => ({ machine, request })))
    .sort((a, b) => a.request.createdAt - b.request.createdAt));
  const pending = $derived(waiting.filter(row => row.machine.store.connection === 'ready'));
  const first = $derived(pending[0]);
  const key = (row: NonNullable<typeof first>) => `${row.machine.id}:${row.request.id}`;
  let seen = $state<string[]>([]);
  $effect(() => {
    const live = new Set(waiting.map(key));
    if (seen.some(id => !live.has(id))) seen = seen.filter(id => live.has(id));
  });
  const next = $derived(pending.find(row => !seen.includes(key(row))));
  let displayed = $state<typeof first>();
  const toast = new Closing();
  $effect(() => {
    if (next) { displayed = next; toast.show(); }
    else toast.hide();
  });
  function dismiss() { if (displayed) seen = [...seen, key(displayed)]; }
  function review(row: NonNullable<typeof first>) {
    seen = [...seen, key(row)];
    void openContact(row.machine.store, row.request.coreId);
  }
</script>

{#if first}
  <button type="button" class="ghost icon indicator" data-testid="contact-request-open"
    title={fill(strings.contacts.requests.pending, { count: count(pending.length) })}
    aria-label={fill(strings.contacts.requests.pending, { count: count(pending.length) })} onclick={() => review(first)}>
    <Bell size={17} strokeWidth={1.75} /><span class="badge">{count(pending.length)}</span>
  </button>
{/if}
{#if displayed && toast.shown}
  <div class="notice" class:closing={toast.closing} use:toast.attach onanimationend={toast.end} role="status" data-testid="contact-request-notice">
    <button type="button" class="request" data-testid="contact-request-review"
      title={strings.contacts.requests.review} onclick={() => review(displayed!)}>
      <span class="bell"><Bell size={18} strokeWidth={1.75} /></span>
      <span class="copy">
        <span class="heading"><span>{fill(strings.contacts.requests.asks, { contact: displayed.request.contact })}</span><span class="machine">{machineName(displayed.machine)}</span></span>
        <span class="excerpt">{displayed.request.text}</span>
      </span>
      {#if pending.length > 1}<span class="count">{count(pending.length)}</span>{/if}
      <ArrowRight size={16} strokeWidth={1.75} />
    </button>
    <button type="button" class="ghost icon dismiss" aria-label={strings.common.dismiss} title={strings.common.dismiss} onclick={dismiss} data-testid="contact-request-dismiss"><X size={14} /></button>
  </div>
{/if}

<style>
  .indicator { position: relative; flex: none; color: var(--color-accent); }
  .badge { position: absolute; top: -2px; right: -4px; min-width: 15px; padding: 1px 3px; font-size: var(--text-xs); line-height: 14px; border-radius: var(--radius-full); background: var(--color-accent); color: var(--color-accent-ink); }
  .notice { position: fixed; z-index: 80; top: calc(var(--titlebar) + 12px); left: 50%; transform: translateX(-50%); width: min(440px, calc(100vw - 32px)); animation: fade var(--dur-2) var(--ease-out-quint); }
  .notice.closing { animation: fade-out var(--dur-2) var(--ease-out-quint) forwards; }
  .dismiss { position: absolute; top: 2px; right: 2px; width: 24px; height: 24px; color: var(--color-subtle); }
  .request { display: flex; align-items: center; gap: 12px; width: 100%; height: auto; min-height: 64px; padding: 12px 30px 12px 14px; text-align: left; background: var(--color-surface-2); border: 1px solid var(--color-accent); border-radius: var(--radius-lg); box-shadow: var(--shadow-e3); color: var(--color-foreground); }
  .request:hover { background: var(--color-hover); }
  .bell { display: grid; place-items: center; flex: none; width: 32px; height: 32px; border-radius: var(--radius-md); background: var(--color-accent-soft); color: var(--color-accent); }
  .copy { display: grid; flex: 1; gap: 4px; min-width: 0; }
  .heading { display: flex; align-items: baseline; gap: 8px; min-width: 0; font-size: var(--text-sm); font-weight: 600; }
  .heading > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .machine { margin-left: auto; font-size: var(--text-xs); font-weight: 400; color: var(--color-subtle); }
  .excerpt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); font-weight: 400; color: var(--color-muted-foreground); }
  .count { flex: none; font-size: var(--text-xs); color: var(--color-accent); }
  .request > :global(svg) { flex: none; color: var(--color-accent); }
  @media (max-width: 720px) { .notice { top: calc(68px + env(safe-area-inset-top)); width: calc(100vw - 24px); } .machine { max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } }
  @media (prefers-reduced-motion: reduce) { .notice { animation-duration: 1ms; } }
  :global(html[data-motion='reduced']) .notice { animation-duration: 1ms; }
</style>
