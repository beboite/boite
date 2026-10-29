<script lang="ts">
  import { lockedBy } from '../../lib/policy';
  import { onDestroy } from 'svelte';
  import { Check, ChevronDown, Copy, ExternalLink } from '@lucide/svelte';
  import type { ModelTier } from '@boite/contracts';
  import { copyText, type ContactsView } from '../../lib/contacts.svelte';
  import { fill, strings } from '../../lib/strings';
  import InfoTip from '../InfoTip.svelte';

  /**
   * The Settings card of Contacts: one Tailscale row, this machine's tailnet
   * name and whether the policy keeps shared users on Boite's port. Configure
   * unfolds the rest: the API key (set or cleared, never shown back), the
   * policy with the lines that would fix it, and the weakest model allowed.
   */
  let { view }: { view: ContactsView } = $props();
  const labels = $derived(strings.contacts.tailscale);
  const uid = $props.id();
  const data = $derived(view.state!);
  const tailscale = $derived(data.tailscale);
  const ADMIN = 'https://login.tailscale.com/admin/acls/file';
  const TIERS: ModelTier[] = [1, 2, 3];
  const TIER_NAMES = { 1: 'frontier', 2: 'mid', 3: 'small' } as const satisfies Record<ModelTier, keyof typeof strings.contacts.settings.tiers>;

  let open = $state(false);
  let key = $state('');
  async function save() {
    const value = key.trim();
    if (!value) return;
    if (await view.tailscaleKey(value)) key = '';
  }

  let fixField = $state<HTMLTextAreaElement>();
  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(timer));
  async function copy() {
    if (!tailscale.policyFix || !(await copyText(tailscale.policyFix, fixField))) return;
    copied = true;
    clearTimeout(timer);
    timer = setTimeout(() => { copied = false; }, 1500);
  }
</script>

<div class="switch-row">
  <span class="text">
    <span class="ui-label-box"><span class="ui-label">{labels.title}</span><InfoTip topic={labels.title} text={labels.tip} /></span>
    <span class="hint mono" data-testid="contact-tailnet">{tailscale.fqdn ?? labels.noTailnet}</span>
  </span>
  <span class="policy" data-policy={tailscale.policy} data-testid="contact-policy" title={labels.stateTip[tailscale.policy]}>
    <span class="pip"></span><span class="ui-label">{fill(labels.policyIs, { state: labels.state[tailscale.policy] })}</span>
  </span>
  <button type="button" class="ghost configure" aria-expanded={open} onclick={() => { open = !open; }} data-testid="contact-configure">
    <span class="ui-label">{labels.configure}</span><ChevronDown size={14} class={open ? 'turned' : ''} />
  </button>
</div>

{#if open}
  <div class="more" data-testid="contact-settings-more">
    <div class="switch-row">
      <span class="text">
        <span class="ui-label-box"><span class="ui-label" id="{uid}-key">{labels.key}</span><InfoTip topic={labels.key} text={labels.keyTip} /></span>
        <span class="hint" data-testid="contact-key-state">{tailscale.apiKey ? labels.keyStored : labels.keyMissing}</span>
      </span>
      <form class="key-form" onsubmit={event => { event.preventDefault(); void save(); }}>
        <input type="password" bind:value={key} placeholder={labels.keyPlaceholder} aria-labelledby="{uid}-key" autocomplete="off" spellcheck="false" data-testid="contact-key-input" />
        <button type="submit" disabled={!key.trim() || view.isBusy('tailscale-key') || lockedBy(view.store.policy, 'network.contacts') !== null} data-testid="contact-key-save">{labels.save}</button>
        {#if tailscale.apiKey}<button type="button" class="ghost" disabled={view.isBusy('tailscale-key')} onclick={() => void view.tailscaleKey(null)} data-testid="contact-key-clear">{labels.clear}</button>{/if}
      </form>
    </div>

    <div class="switch-row">
      <span class="text">
        <span class="ui-label">{labels.policy}</span>
        <span class="hint">{labels.stateTip[tailscale.policy]}</span>
      </span>
      <a class="console" href={ADMIN} target="_blank" rel="noreferrer">{strings.contacts.invite.openConsole}<ExternalLink size={12} /></a>
    </div>
    {#if tailscale.policy === 'open' && tailscale.policyFix}
      <div class="fix">
        <textarea class="mono" bind:this={fixField} readonly rows={tailscale.policyFix.split('\n').length} spellcheck="false" aria-label={labels.policy} data-testid="contact-policy-fix">{tailscale.policyFix}</textarea>
        <button type="button" class="small" onclick={() => void copy()} data-testid="contact-policy-copy">
          {#if copied}<Check size={13} />{labels.copied}{:else}<Copy size={13} />{labels.copy}{/if}
        </button>
      </div>
    {/if}

    <div class="switch-row">
      <span class="text ui-label-box"><span class="ui-label" id="{uid}-tier">{strings.contacts.settings.minTier}</span><InfoTip topic={strings.contacts.settings.minTier} text={strings.contacts.settings.minTierTip} /></span>
      <div class="segmented" role="group" aria-labelledby="{uid}-tier">
        {#each TIERS as tier (tier)}
          <button type="button" class:on={data.settings.minTier === tier} aria-pressed={data.settings.minTier === tier} disabled={view.isBusy('settings')}
            onclick={() => { if (data.settings.minTier !== tier) void view.settings({ ...data.settings, minTier: tier }); }} data-testid="home-tier-{tier}">
            <span class="ui-label">{strings.contacts.settings.tiers[TIER_NAMES[tier]]}</span>
          </button>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .hint.mono { font-family: var(--font-mono); font-size: var(--text-xs); overflow-wrap: anywhere; }
  .policy { --tone: var(--color-subtle); display: inline-flex; flex: none; align-items: center; gap: 6px; padding: 2px 10px; border-radius: var(--radius-full); background: color-mix(in oklch, var(--tone) 15%, transparent); color: var(--tone); font-size: var(--text-xs); font-weight: 600; }
  .policy[data-policy='restricted'] { --tone: var(--color-success); }
  .policy[data-policy='open'] { --tone: var(--color-live); }
  .pip { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .configure { flex: none; gap: 4px; }
  .configure :global(svg) { transition: transform var(--dur-2) var(--ease-out-quint); }
  .configure :global(svg.turned) { transform: rotate(180deg); }
  .more { border-top: 1px solid var(--color-border); animation: rise var(--dur-3) var(--ease-out-quint); }
  .key-form { display: flex; flex: 0 1 360px; gap: 6px; min-width: 0; }
  .key-form input { flex: 1; min-width: 0; }
  .console { display: inline-flex; flex: none; align-items: center; gap: 4px; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .console:hover { color: var(--color-foreground); }
  .more > .switch-row:last-child { min-height: 50px; padding-bottom: 0; }
  .fix + .switch-row { border-top: 1px solid var(--color-border); }
  .fix { display: grid; gap: 8px; padding-bottom: 16px; }
  .fix textarea { width: 100%; min-width: 0; resize: none; padding: 10px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-2); font-size: var(--text-xs); line-height: 1.6; white-space: pre; overflow-x: auto; }
  .fix button { justify-self: start; }
  .segmented { display: flex; flex: none; gap: 2px; padding: 3px; border-radius: var(--radius-md); background: var(--color-surface-2); box-shadow: inset 0 0 0 1px var(--color-border); }
  .segmented button { height: var(--control-sm); padding: 0 12px; border: 0; background: none; color: var(--color-muted-foreground); font-weight: 500; }
  .segmented button:hover:not(:disabled) { color: var(--color-foreground); background: var(--color-hover); }
  .segmented button.on { background: var(--color-active); color: var(--color-foreground); box-shadow: var(--shadow-e1); }
  @media (prefers-reduced-motion: reduce) { .more, .configure :global(svg) { animation: none; transition: none; } }
  :global(html[data-motion='reduced']) .more, :global(html[data-motion='reduced']) .configure :global(svg) { animation: none; transition: none; }
  @media (max-width: 720px) {
    :global(.settings .page) .switch-row { flex-wrap: wrap; }
    .switch-row .text { flex-basis: 100%; }
    .key-form { flex: 1 1 100%; flex-wrap: wrap; }
    .key-form input { flex-basis: 100%; }
    .segmented { width: 100%; }
    .segmented button { flex: 1; min-height: var(--touch-target); }
  }
</style>
