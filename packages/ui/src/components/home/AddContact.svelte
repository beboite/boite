<script lang="ts">
  import { lockedBy } from '../../lib/policy';
  import { onDestroy, tick, untrack } from 'svelte';
  import { Check, Copy, ExternalLink, Globe, Link2, Share2, TriangleAlert } from '@lucide/svelte';
  import { inviteShare, readInvite } from '../../lib/contact-link';
  import { copyText, type ContactsView, type InviteReach } from '../../lib/contacts.svelte';
  import { clockTime } from '../../lib/format';
  import { fill, strings } from '../../lib/strings';
  import InfoTip from '../InfoTip.svelte';
  import PolicyLock from '../PolicyLock.svelte';
  import FingerprintWords from './FingerprintWords.svelte';

  /**
   * The two ways a contact starts, as two Settings rows. Invite makes a
   * one-time link and copies it at once, for someone already on the owner's
   * Tailscale (the link alone), on another tailscale.com tailnet (the link and
   * a share of this machine) or elsewhere (the link names this machine's
   * contact routes on Tailscale Funnel); its expiry and how the share went
   * show under the row, and for Funnel whether the internet reaches this
   * machine yet. A tailnet outside tailscale.com (Headscale) can do
   * neither of the last two: they stay off and a line says who invites whom. Join takes the link another owner sent and
   * then shows the eight words to compare with them. A link that shares the
   * inviter through Tailscale, pasted where no API key can accept it, first
   * offers the share to accept by hand.
   */
  let { view }: { view: ContactsView } = $props();
  /** The admin policy turns contacts off: no invitation and no joining from this machine. */
  const locked = $derived(lockedBy(view.store.policy, 'network.contacts') !== null);
  const labels = $derived(strings.contacts);
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
  async function invite(reach: InviteReach) {
    // A failed call leaves the last link shown, made for another kind of invitee: never copied in its place.
    if (!(await view.createInvite(reach))) return;
    await tick();
    await copy();
  }
  // A new invitation is not the one just copied.
  $effect(() => { void view.invite; untrack(() => { copied = false; }); });

  // Only tailscale.com shares a machine between tailnets or opens Funnel.
  const selfHosted = $derived.by(() => {
    const fqdn = view.state?.tailscale.fqdn;
    return typeof fqdn === 'string' && !fqdn.endsWith('.ts.net');
  });
  const funnel = $derived(view.state?.funnel ?? null);
  // Funnel moved to another port since the link was made: the guest would dial the old one.
  const moved = $derived.by(() => {
    const origin = view.invite ? readInvite(view.invite.link)?.u : null;
    return funnel !== null && typeof origin === 'string' && origin !== funnel.url;
  });

  let pasted = $state('');
  const shareStep = $derived(view.state?.tailscale.apiKey === true ? null : inviteShare(pasted));
  async function join() {
    const link = pasted.trim();
    if (!link) return;
    if (await view.join(link)) pasted = '';
  }
</script>

<div class="switch-row invite-row">
  <span class="text">
    <span class="ui-label-box"><span class="ui-label">{labels.invite.title}</span><InfoTip topic={labels.invite.title} text={labels.invite.tip} /><PolicyLock store={view.store} keys={['network.contacts']} /></span>
    <span class="hint">{labels.invite.pick}</span>
    {#if selfHosted}<span class="hint" data-testid="contact-invite-self-hosted">{labels.invite.selfHosted}</span>{/if}
    {#if (view.state?.invitations ?? 0) > 0}
      <span class="open hint" data-testid="contact-invites-open">
        {fill(labels.invite.open, { count: String(view.state?.invitations) })}
        <button type="button" class="ghost small danger" title={labels.invite.cancelTip} disabled={view.isBusy('cancel-invites')}
          onclick={() => void view.cancelInvites()} data-testid="contact-invites-cancel">{labels.invite.cancel}</button>
      </span>
    {/if}
  </span>
  <span class="invite-actions">
    <button type="button" disabled={view.isBusy('invite') || locked} title={labels.invite.tailnetTip} onclick={() => void invite('tailnet')} data-testid="contact-invite-tailnet">
      <Link2 size={14} /><span class="ui-label">{labels.invite.tailnet}</span>
    </button>
    <button type="button" disabled={view.isBusy('invite') || selfHosted || locked} title={labels.invite.createTip} onclick={() => void invite('share')} data-testid="contact-invite-create">
      <Share2 size={14} /><span class="ui-label">{labels.invite.create}</span>
    </button>
    <!-- An older core reads only `share` and would share the machine instead. -->
    {#if view.state?.internet === true}
      <button type="button" disabled={view.isBusy('invite') || selfHosted || locked} title={labels.invite.internetTip} onclick={() => void invite('internet')} data-testid="contact-invite-internet">
        <Globe size={14} /><span class="ui-label">{labels.invite.internet}</span>
      </button>
    {/if}
  </span>
</div>
{#if view.invite}
  {@const made = view.invite}
  <div class="under" data-testid="contact-invite">
    <div class="line">
      <input class="mono link" bind:this={linkField} readonly spellcheck="false" autocomplete="off" aria-label={labels.invite.link} value={made.link}
        onfocus={event => event.currentTarget.select()} data-testid="contact-invite-link" />
      <button type="button" onclick={() => void copy()} data-testid="contact-invite-copy">
        {#if copied}<Check size={14} /><span class="ui-label">{labels.invite.copied}</span>{:else}<Copy size={14} /><span class="ui-label">{labels.invite.copy}</span>{/if}
      </button>
    </div>
    <p class="hint">
      {fill(labels.invite.expires, { time: clockTime(made.expiresAt) })}
      {#if made.share.status === 'created'}
        · <a class="share ok" href={made.share.url} target="_blank" rel="noreferrer" data-testid="contact-invite-share" data-status="created"><Check size={12} strokeWidth={2.25} />{labels.invite.shared}</a>
      {:else if made.via === 'internet'}
        · <span data-testid="contact-invite-share" data-status="funnel">{labels.invite.funnel}</span>
      {:else if made.share.status === 'none'}
        · <span data-testid="contact-invite-share" data-status="none">{labels.invite.noShare}</span>
      {/if}
    </p>
    {#if made.share.status === 'manual'}
      <p class="manual" data-testid="contact-invite-share" data-status="manual">
        <TriangleAlert size={14} strokeWidth={2} /><span><strong>{labels.invite.manual}</strong> {made.share.reason}
        <a href={ADMIN} target="_blank" rel="noreferrer">{labels.invite.openConsole}<ExternalLink size={12} /></a></span>
      </p>
    {/if}
    <!-- Whether a request from the internet reaches this machine yet, checked by the core while Funnel is up. -->
    {#if made.via === 'internet' && funnel}
      {#if moved}
        <p class="manual" data-testid="contact-invite-reach" data-status="moved">
          <TriangleAlert size={14} strokeWidth={2} /><span><strong>{labels.invite.reach.wait}</strong> {labels.invite.reach.moved}</span>
        </p>
      {:else if funnel.status === 'ready'}
        <p class="hint reach ok" data-testid="contact-invite-reach" data-status="ready"><Check size={12} strokeWidth={2.25} />{labels.invite.reach.ready}</p>
      {:else if funnel.status === 'checking' || funnel.status === 'unknown'}
        <p class="hint" data-testid="contact-invite-reach" data-status={funnel.status}>
          {funnel.status === 'unknown' ? labels.invite.reach.unknown : funnel.repaired ? labels.invite.reach.repaired : labels.invite.reach.checking}
        </p>
      {:else}
        <p class="manual" data-testid="contact-invite-reach" data-status={funnel.status}>
          <TriangleAlert size={14} strokeWidth={2} /><span><strong>{labels.invite.reach.wait}</strong>
          {funnel.status === 'unreachable' ? labels.invite.reach.unreachable : funnel.repaired ? labels.invite.reach.stillUnpublished : labels.invite.reach.unpublished}</span>
        </p>
      {/if}
    {/if}
  </div>
{/if}

<div class="switch-row join-row">
  <span class="text">
    <span class="ui-label-box"><span class="ui-label">{labels.join.title}</span><PolicyLock store={view.store} keys={['network.contacts']} /></span>
    <span class="hint">{labels.join.tip}</span>
  </span>
  {#if !view.joined}
    <form class="join" onsubmit={event => { event.preventDefault(); void join(); }}>
      <input class="mono" bind:value={pasted} placeholder={labels.join.placeholder} aria-label={labels.join.label} spellcheck="false" autocomplete="off" data-testid="contact-join-link" />
      <button type="submit" class="primary" disabled={!pasted.trim() || view.isBusy('join') || locked} data-testid="contact-join">
        <span class="ui-label">{view.isBusy('join') ? labels.join.joining : labels.join.submit}</span>
      </button>
    </form>
  {/if}
</div>
{#if view.joined}
  {@const joined = view.joined}
  <div class="under" data-testid="contact-joined">
    <p class="compare ui-label-box"><span class="ui-label">{fill(labels.join.compare, { name: joined.name })}</span><InfoTip topic={labels.words} text={labels.join.compareTip} /></p>
    <FingerprintWords fingerprint={joined.fingerprint} testid="contact-joined-words" />
    <button type="button" class="small done" onclick={() => { view.joined = null; }} data-testid="contact-joined-done">{labels.join.done}</button>
  </div>
{:else if view.joinWaiting}
  <p class="under step waiting" data-testid="contact-join-waiting">
    <span class="hint">{fill(labels.join.waiting, { time: clockTime(view.joinWaiting.until) })}</span>
    <button type="button" class="ghost small" onclick={() => view.stopJoin()} data-testid="contact-join-stop">{labels.join.stop}</button>
  </p>
{:else if shareStep}
  <!-- Stays while the link does, so it is still there after a join that could not reach the inviter. -->
  <p class="under step ui-label-box">
    <a class="manual-step" href={shareStep} target="_blank" rel="noreferrer" data-testid="contact-join-share">{labels.join.acceptShare}</a>
    <InfoTip topic={labels.join.acceptShare} text={labels.join.acceptShareTip} />
  </p>
{/if}

<style>
  /* What a row made sits under it, before the next row's rule. */
  .under { display: grid; gap: 8px; padding-bottom: 16px; min-width: 0; animation: rise var(--dur-3) var(--ease-out-quint); }
  .join-row { border-top: 1px solid var(--color-border); }
  /* Three answers to "where is the person?": under the question, never squeezing it. */
  :global(.settings .page) .invite-row { flex-direction: column; align-items: stretch; gap: 12px; }
  .invite-actions { display: flex; flex: none; flex-wrap: wrap; gap: 8px; }
  .line { display: flex; gap: 8px; min-width: 0; }
  .link { flex: 1; min-width: 0; font-size: var(--text-xs); }
  .hint { margin: 0; }
  .open { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
  .share { display: inline-flex; align-items: center; gap: 4px; color: var(--color-success); text-decoration: none; }
  .reach.ok { display: flex; align-items: center; gap: 4px; color: var(--color-success); }
  .waiting { flex-wrap: wrap; gap: 4px 8px; }
  .manual { display: flex; gap: 8px; margin: 0; padding: 10px 12px; border: 1px solid color-mix(in oklch, var(--color-live) 35%, transparent); border-radius: var(--radius-md); background: color-mix(in oklch, var(--color-live) 10%, transparent); color: var(--color-muted-foreground); font-size: var(--text-sm); overflow-wrap: anywhere; }
  .manual :global(svg) { flex: none; margin-top: 2px; color: var(--color-live); }
  .manual strong { color: var(--color-foreground); font-weight: 600; }
  .manual a { display: inline-flex; align-items: center; gap: 4px; color: var(--color-foreground); }
  .join { display: flex; flex: 0 1 360px; gap: 8px; min-width: 0; }
  .join input { flex: 1; min-width: 0; font-size: var(--text-sm); }
  .step { display: flex; align-items: center; gap: 4px; margin: 0; }
  .manual-step { color: var(--color-live); font-size: var(--text-sm); font-weight: 500; }
  .compare { display: flex; align-items: center; gap: 4px; margin: 0; font-weight: 600; }
  .done { justify-self: start; }
  @media (prefers-reduced-motion: reduce) { .under { animation: none; } }
  :global(html[data-motion='reduced']) .under { animation: none; }
  @media (max-width: 720px) {
    :global(.settings .page) .switch-row { flex-direction: column; align-items: stretch; gap: 12px; }
    .join, .invite-actions { flex: none; flex-direction: column; }
    .invite-actions button, .join button, .join input, .line button, .waiting button { min-height: var(--touch-target); }
  }
</style>
