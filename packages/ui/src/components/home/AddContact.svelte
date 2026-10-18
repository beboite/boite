<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { Check, Copy, ExternalLink, Link2, Send, TriangleAlert } from '@lucide/svelte';
  import { inviteShare } from '../../lib/contact-link';
  import { copyText, type ContactsView } from '../../lib/contacts.svelte';
  import { time } from '../../lib/format';
  import { fill, strings } from '../../lib/strings';
  import InfoTip from '../InfoTip.svelte';
  import FingerprintWords from './FingerprintWords.svelte';

  /**
   * The two ways a contact starts: Invite makes a one-time link with Copy, its
   * expiry and how the Tailscale share went; Join takes the link another owner
   * sent and then shows the four words to compare with them. A link that
   * shares the inviter through Tailscale, pasted where no API key can accept
   * it, first offers the share to accept by hand.
   */
  let { view }: { view: ContactsView } = $props();
  const labels = $derived(strings.contacts);
  const uid = $props.id();
  const ADMIN = 'https://login.tailscale.com/admin/machines';

  let linkField = $state<HTMLInputElement>();
  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(timer));
  async function copy() {
    if (!view.invite || !(await copyText(view.invite.link, linkField))) return;
    copied = true;
    clearTimeout(timer);
    timer = setTimeout(() => { copied = false; }, 1500);
  }
  // A new invitation is not the one just copied.
  $effect(() => { void view.invite; untrack(() => { copied = false; }); });

  let pasted = $state('');
  const shareStep = $derived(view.state?.tailscale.apiKey === true ? null : inviteShare(pasted));
  async function join() {
    const link = pasted.trim();
    if (!link) return;
    if (await view.join(link)) pasted = '';
  }
</script>

<div class="tiles">
  <section class="tile" aria-labelledby="{uid}-invite">
    <header class="tile-head">
      <span class="glyph" aria-hidden="true"><Send size={18} strokeWidth={1.75} /></span>
      <h3 id="{uid}-invite" class="ui-label-box"><span class="ui-label">{labels.invite.title}</span><InfoTip topic={labels.invite.title} text={labels.invite.tip} /></h3>
    </header>
    {#if view.invite}
      {@const invite = view.invite}
      <div class="result" data-testid="contact-invite">
        <input class="mono link" bind:this={linkField} readonly spellcheck="false" autocomplete="off" aria-label={labels.invite.link} value={invite.link}
          onfocus={event => event.currentTarget.select()} data-testid="contact-invite-link" />
        <div class="row">
          <button type="button" class="primary" onclick={() => void copy()} data-testid="contact-invite-copy">
            {#if copied}<Check size={14} /><span class="ui-label">{labels.invite.copied}</span>{:else}<Copy size={14} /><span class="ui-label">{labels.invite.copy}</span>{/if}
          </button>
          <span class="expiry">{fill(labels.invite.expires, { time: time(invite.expiresAt) })}</span>
        </div>
        {#if invite.share.status === 'created'}
          <a class="share ok" href={invite.share.url} target="_blank" rel="noreferrer" data-testid="contact-invite-share" data-status="created">
            <Check size={14} strokeWidth={2.25} /><span class="ui-label">{labels.invite.shared}</span><ExternalLink size={12} />
          </a>
        {:else}
          <div class="share manual" data-testid="contact-invite-share" data-status="manual">
            <span class="share-title"><TriangleAlert size={14} strokeWidth={2} /><span class="ui-label">{labels.invite.manual}</span></span>
            <span class="reason">{invite.share.reason}</span>
            <a href={ADMIN} target="_blank" rel="noreferrer">{labels.invite.openConsole}<ExternalLink size={12} /></a>
          </div>
        {/if}
        <button type="button" class="ghost small again" disabled={view.isBusy('invite')} onclick={() => void view.createInvite()}>{labels.invite.again}</button>
      </div>
    {:else}
      <button type="button" class="primary big" disabled={view.isBusy('invite')} onclick={() => void view.createInvite()} data-testid="contact-invite-create">
        <Send size={15} /><span class="ui-label">{labels.invite.create}</span>
      </button>
    {/if}
  </section>

  <section class="tile" aria-labelledby="{uid}-join">
    <header class="tile-head">
      <span class="glyph" aria-hidden="true"><Link2 size={18} strokeWidth={1.75} /></span>
      <h3 id="{uid}-join" class="ui-label-box"><span class="ui-label">{labels.join.title}</span><InfoTip topic={labels.join.title} text={labels.join.tip} /></h3>
    </header>
    {#if view.joined}
      {@const joined = view.joined}
      <div class="result" data-testid="contact-joined">
        <p class="compare ui-label-box"><span class="ui-label">{fill(labels.join.compare, { name: joined.name })}</span><InfoTip topic={labels.words} text={labels.join.compareTip} /></p>
        <FingerprintWords fingerprint={joined.fingerprint} testid="contact-joined-words" />
        <button type="button" class="small done" onclick={() => { view.joined = null; }} data-testid="contact-joined-done">{labels.join.done}</button>
      </div>
    {:else}
      {#if shareStep}
        <!-- Stays while the link does, so it is still there after a join that could not reach the inviter. -->
        <span class="step ui-label-box">
          <a class="share manual-step" href={shareStep} target="_blank" rel="noreferrer" data-testid="contact-join-share">
            <Link2 size={14} strokeWidth={2} /><span class="ui-label">{labels.join.acceptShare}</span><ExternalLink size={12} />
          </a>
          <InfoTip topic={labels.join.acceptShare} text={labels.join.acceptShareTip} />
        </span>
      {/if}
      <form class="join" onsubmit={event => { event.preventDefault(); void join(); }}>
        <input class="mono" bind:value={pasted} placeholder={labels.join.placeholder} aria-label={labels.join.label} spellcheck="false" autocomplete="off" data-testid="contact-join-link" />
        <button type="submit" class="primary" disabled={!pasted.trim() || view.isBusy('join')} data-testid="contact-join">
          <span class="ui-label">{view.isBusy('join') ? labels.join.joining : labels.join.submit}</span>
        </button>
      </form>
    {/if}
  </section>
</div>

<style>
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
  .tile {
    position: relative;
    display: grid;
    gap: 14px;
    align-content: start;
    min-width: 0;
    padding: 16px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
    box-shadow: var(--shadow-e1);
  }
  .tile-head { display: flex; align-items: center; gap: 10px; }
  .tile-head h3 { margin: 0; font-size: var(--text-base); font-weight: 600; }
  .glyph { display: grid; place-items: center; width: 34px; height: 34px; border-radius: var(--radius-md); background: var(--color-accent-soft); color: var(--color-accent); box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--color-accent) 30%, transparent); }
  .big { justify-self: start; height: var(--control-lg); padding: 0 16px; }
  .result { display: grid; gap: 10px; min-width: 0; animation: rise var(--dur-3) var(--ease-out-quint); }
  .link { width: 100%; min-width: 0; font-size: var(--text-xs); }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .expiry { color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .share { display: inline-flex; align-items: center; gap: 6px; justify-self: start; padding: 4px 10px; border-radius: var(--radius-full); font-size: var(--text-sm); font-weight: 500; text-decoration: none; }
  .share.ok { background: color-mix(in oklch, var(--color-success) 14%, transparent); color: var(--color-success); }
  .share.manual { display: grid; justify-self: stretch; gap: 4px; padding: 10px 12px; border-radius: var(--radius-md); background: color-mix(in oklch, var(--color-live) 10%, transparent); border: 1px solid color-mix(in oklch, var(--color-live) 35%, transparent); }
  .share-title { display: inline-flex; align-items: center; gap: 6px; color: var(--color-live); font-weight: 600; }
  .reason { color: var(--color-muted-foreground); font-size: var(--text-sm); overflow-wrap: anywhere; }
  .share.manual a { display: inline-flex; align-items: center; gap: 4px; justify-self: start; color: var(--color-foreground); font-size: var(--text-sm); }
  .again { justify-self: start; }
  .step { display: flex; align-items: center; gap: 4px; }
  .manual-step { background: color-mix(in oklch, var(--color-live) 12%, transparent); color: var(--color-live); box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--color-live) 35%, transparent); }
  .join { display: flex; gap: 8px; min-width: 0; }
  .join input { flex: 1; min-width: 0; font-size: var(--text-sm); }
  .compare { display: flex; align-items: center; gap: 4px; margin: 0; font-weight: 600; }
  .done { justify-self: start; }
  @media (prefers-reduced-motion: reduce) { .result { animation: none; } }
  :global(html[data-motion='reduced']) .result { animation: none; }
  @media (max-width: 720px) {
    .tile { padding: 14px; }
    .join { flex-direction: column; }
    .join input { flex: none; }
    .big, .join button, .join input, .manual-step { min-height: var(--touch-target); }
  }
</style>
