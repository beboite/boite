<script lang="ts">
  import { ArrowDownLeft, Check, X } from '@lucide/svelte';
  import type { HeldContactLetter } from '@boite/contracts';
  import type { ContactsView } from '../../lib/contacts.svelte';
  import { ago, clockTime } from '../../lib/format';
  import { fill, strings } from '../../lib/strings';

  /**
   * One message a contact sent outside a shared project, a row of a Messages
   * card. No agent reads it until the owner delivers it, as written, to the
   * conversation it names; Refuse tells its sender.
   */
  let { view, letter, now }: { view: ContactsView; letter: HeldContactLetter; now: number } = $props();
  const labels = $derived(strings.contacts.mail);
  const busy = $derived(view.isBusy(`mail:${letter.id}`) || view.store.connection !== 'ready');
</script>

<article class="mail" data-testid="contact-mail-{letter.id}">
  <header class="kicker">
    <ArrowDownLeft size={14} strokeWidth={2} aria-hidden="true" />
    <span class="ui-label">{fill(labels.writes, { contact: letter.contact, thread: letter.thread })}</span>
    <time class="age" datetime={new Date(letter.createdAt).toISOString()}>{ago(letter.createdAt, now)}</time>
  </header>
  <p class="text">{letter.text}</p>
  <p class="from"><span>{fill(labels.from, { thread: letter.from })}</span><span class="until">{fill(labels.until, { time: clockTime(letter.expiresAt, now) })}</span></p>
  <div class="buttons">
    <button type="button" class="primary" disabled={busy} title={fill(labels.deliverTip, { thread: letter.thread })}
      onclick={() => void view.decideMail(letter.id, true)} data-testid="contact-mail-deliver-{letter.id}"><Check size={14} strokeWidth={2.25} /><span class="ui-label">{labels.deliver}</span></button>
    <button type="button" class="ghost" disabled={busy} title={labels.refuseTip}
      onclick={() => void view.decideMail(letter.id, false)} data-testid="contact-mail-refuse-{letter.id}"><X size={14} /><span class="ui-label">{labels.refuse}</span></button>
  </div>
</article>

<style>
  /* A row of the Messages card, split by a rule like the Requests rows. */
  .mail { display: grid; gap: 6px; padding: 14px 0; animation: rise var(--dur-3) var(--ease-out-quint); }
  :global(.mail) + .mail { border-top: 1px solid var(--color-border); }
  :global(h2) + .mail { padding-top: 0; }
  .kicker { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--color-accent); font-size: var(--text-xs); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
  .kicker .ui-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .age { margin-left: auto; flex: none; color: var(--color-subtle); font-weight: 500; text-transform: none; letter-spacing: 0; }
  .text { margin: 0; font-size: var(--text-base); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
  .from { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); overflow-wrap: anywhere; }
  .until { color: var(--color-subtle); }
  .buttons { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 2px; }
  @media (prefers-reduced-motion: reduce) { .mail { animation: none; } }
  :global(html[data-motion='reduced']) .mail { animation: none; }
  @media (max-width: 720px) { .buttons > button { min-height: var(--touch-target); } }
</style>
