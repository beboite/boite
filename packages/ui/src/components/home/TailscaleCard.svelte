<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Check, Copy, ExternalLink, KeyRound, Network } from '@lucide/svelte';
  import { copyText, type ContactsView } from '../../lib/contacts.svelte';
  import { strings } from '../../lib/strings';
  import InfoTip from '../InfoTip.svelte';

  /**
   * The Tailscale side of contacts: this machine's tailnet name, the API key
   * (set or cleared, never shown back), whether the policy keeps shared users
   * on Boite's port and, when it does not, the lines that would.
   */
  let { view }: { view: ContactsView } = $props();
  const labels = $derived(strings.contacts.tailscale);
  const uid = $props.id();
  const tailscale = $derived(view.state!.tailscale);
  const ADMIN = 'https://login.tailscale.com/admin/acls/file';

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

<div class="rows">
  <div class="row">
    <span class="label"><Network size={14} strokeWidth={1.75} aria-hidden="true" />{labels.name}</span>
    {#if tailscale.fqdn}<span class="value mono" data-testid="contact-tailnet">{tailscale.fqdn}</span>{:else}<span class="value muted">{labels.noTailnet}</span>{/if}
  </div>

  <div class="row key">
    <span class="label ui-label-box"><KeyRound size={14} strokeWidth={1.75} aria-hidden="true" /><span class="ui-label" id="{uid}-key">{labels.key}</span><InfoTip topic={labels.key} text={labels.keyTip} /></span>
    <span class="chip-state" class:on={tailscale.apiKey} data-testid="contact-key-state">{tailscale.apiKey ? labels.keyStored : labels.keyMissing}</span>
    <form class="key-form" onsubmit={event => { event.preventDefault(); void save(); }}>
      <input type="password" bind:value={key} placeholder={labels.keyPlaceholder} aria-labelledby="{uid}-key" autocomplete="off" spellcheck="false" data-testid="contact-key-input" />
      <button type="submit" disabled={!key.trim() || view.isBusy('tailscale-key')} data-testid="contact-key-save">{labels.save}</button>
      {#if tailscale.apiKey}<button type="button" class="ghost" disabled={view.isBusy('tailscale-key')} onclick={() => void view.tailscaleKey(null)} data-testid="contact-key-clear">{labels.clear}</button>{/if}
    </form>
  </div>

  <div class="row">
    <span class="label">{labels.policy}</span>
    <span class="policy ui-label-box" data-policy={tailscale.policy} data-testid="contact-policy">
      <span class="pip"></span><span class="ui-label">{labels.state[tailscale.policy]}</span>
    </span>
    <InfoTip topic={labels.policy} text={labels.stateTip[tailscale.policy]} />
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
</div>

<style>
  .rows { display: grid; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; min-height: 48px; padding: 8px 0; }
  .row + .row { border-top: 1px solid var(--color-border); }
  .label { display: inline-flex; align-items: center; gap: 6px; min-width: 140px; color: var(--color-muted-foreground); font-size: var(--text-sm); font-weight: 500; }
  .value { min-width: 0; overflow-wrap: anywhere; }
  .muted { color: var(--color-subtle); }
  .chip-state { padding: 2px 8px; border-radius: var(--radius-full); background: var(--color-surface-3); color: var(--color-muted-foreground); font-size: var(--text-xs); font-weight: 600; }
  .chip-state.on { background: color-mix(in oklch, var(--color-success) 14%, transparent); color: var(--color-success); }
  .key-form { display: flex; flex: 1 1 260px; gap: 6px; min-width: 0; }
  .key-form input { flex: 1; min-width: 0; }
  .policy { --tone: var(--color-subtle); display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: var(--radius-full); background: color-mix(in oklch, var(--tone) 15%, transparent); color: var(--tone); font-size: var(--text-xs); font-weight: 600; }
  .policy[data-policy='restricted'] { --tone: var(--color-success); }
  .policy[data-policy='open'] { --tone: var(--color-live); }
  .pip { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .console { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .console:hover { color: var(--color-foreground); }
  .fix { position: relative; display: grid; gap: 8px; padding-bottom: 4px; animation: rise var(--dur-3) var(--ease-out-quint); }
  .fix textarea { width: 100%; min-width: 0; resize: none; padding: 10px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-2); font-size: var(--text-xs); line-height: 1.6; white-space: pre; overflow-x: auto; }
  .fix button { justify-self: start; }
  @media (prefers-reduced-motion: reduce) { .fix { animation: none; } }
  :global(html[data-motion='reduced']) .fix { animation: none; }
  @media (max-width: 720px) {
    .label { min-width: 0; width: 100%; }
    .console { margin-left: 0; }
    .key-form { flex-wrap: wrap; }
    .key-form input { flex-basis: 100%; }
  }
</style>
