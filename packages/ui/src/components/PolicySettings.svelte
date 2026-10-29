<script lang="ts">
  import { Lock, TriangleAlert } from '@lucide/svelte';
  import type { PolicyKey } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { policyValue } from '../lib/policy';
  import { fill, strings } from '../lib/strings';
  import InfoTip from './InfoTip.svelte';

  /**
   * Settings > General's "Managed by your organization": every key the policy
   * locks, with its value, in a few groups, and the file they come from. Drawn
   * only on a machine that has a policy; a machine without one shows nothing.
   */
  let { store }: { store: Store } = $props();
  const policy = $derived(store.policy);

  type Group = keyof typeof strings.policy.groups;
  /** Which group each key is listed under. A record over every key, so a new key cannot go unlisted. */
  const GROUP: Record<PolicyKey, Group> = {
    analytics: 'privacy', issueReports: 'privacy', dictation: 'privacy', 'previews.remoteResources': 'privacy',
    'updates.app': 'updates', 'updates.server': 'updates', 'updates.agents': 'updates',
    'providers.allow': 'providers', 'providers.deny': 'providers', gateway: 'providers', 'gateway.allowedBaseUrls': 'providers', quotaReads: 'providers',
    'plugins.install': 'tools', 'plugins.recommended': 'tools', agentBrowser: 'tools', 'agentBrowser.searchUrl': 'tools', pullRequests: 'tools',
    'network.lan': 'network', 'network.tailscaleServe': 'network', 'network.groups': 'network', 'network.contacts': 'network', 'network.push': 'network'
  };
  const ORDER: Group[] = ['privacy', 'updates', 'providers', 'tools', 'network'];

  const groups = $derived(ORDER
    .map((id) => ({ id, keys: (policy?.locked ?? []).filter((key) => GROUP[key] === id) }))
    .filter((group) => group.keys.length > 0));

  function providerName(id: string): string {
    return store.providers.find((provider) => provider.id === id)?.name ?? id;
  }

  /** The value a key holds, and whether it reads as off: those step back so a set value stands out. */
  function valueOf(key: PolicyKey): { text: string; off: boolean } {
    const value = policyValue(policy!.values, key);
    const words = strings.policy.values;
    if (Array.isArray(value)) {
      const items = key.startsWith('providers.') ? value.map((id: string) => providerName(id)) : value as string[];
      return items.length === 0 ? { text: words.none, off: true } : { text: items.join(', '), off: false };
    }
    if (value === true) return { text: words.on, off: false };
    if (value === false || value === 'off') return { text: words.off, off: true };
    if (key === 'agentBrowser.searchUrl' && typeof value === 'string') return { text: value, off: false };
    if (typeof value === 'string') return { text: (words as Record<string, string>)[value] ?? value, off: false };
    return { text: words.locked, off: false };
  }
</script>

{#if policy?.present}
  <section class="card policy" id="settings-policy" data-testid="policy-settings">
    <h2>
      <span class="mark" aria-hidden="true"><Lock size={14} strokeWidth={1.75} /></span>
      <span class="title">{strings.policy.heading} <InfoTip topic={strings.policy.heading} text={strings.policy.info} /></span>
      <span class="count" data-testid="policy-count">{policy.locked.length === 1 ? strings.policy.lockedOne : fill(strings.policy.lockedMany, { count: String(policy.locked.length) })}</span>
    </h2>
    {#if policy.failedClosed}
      <p class="closed"><TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" /><span data-testid="policy-failed-closed">{strings.policy.failedClosed}</span></p>
    {/if}
    {#if policy.locked.length === 0}
      <p class="hint">{strings.policy.none}</p>
    {:else}
      <div class="groups">
        {#each groups as group (group.id)}
          <section class="group" data-testid="policy-group" data-group={group.id} aria-labelledby="policy-group-{group.id}">
            <h3 class="section-label" id="policy-group-{group.id}">{strings.policy.groups[group.id]}</h3>
            <dl>
              {#each group.keys as key (key)}
                {@const value = valueOf(key)}
                <div class="row" data-testid="policy-key" data-key={key} title={key}>
                  <dt>{strings.policy.keys[key]}</dt>
                  <dd class:off={value.off}>{value.text}</dd>
                </div>
              {/each}
            </dl>
          </section>
        {/each}
      </div>
    {/if}
    <p class="source"><span>{strings.policy.file}</span><code data-testid="policy-file">{policy.file}</code></p>
  </section>
{/if}

<style>
  .policy { padding: var(--settings-padding); }
  .policy > h2 { display: flex; align-items: center; gap: 10px; min-width: 0; margin: 0 0 16px; line-height: 1.3; }
  .mark {
    display: inline-flex;
    flex: none;
    padding: 5px;
    border-radius: var(--radius-sm);
    background: var(--color-accent-soft);
    color: var(--color-accent);
  }
  .title { min-width: 0; }
  .title :global(button) { vertical-align: middle; }
  .count {
    flex: none;
    margin-left: auto;
    padding: 2px 8px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface-2);
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .closed { display: flex; align-items: flex-start; gap: 8px; margin: -6px 0 16px; color: var(--color-foreground); font-size: var(--text-sm); line-height: 1.5; }
  .closed :global(svg) { flex: none; margin-top: 0.2em; color: var(--color-live); }
  .hint { color: var(--color-muted-foreground); font-size: var(--text-sm); line-height: 1.5; margin: 0 0 8px; }
  /* Two columns where the card has the room, one on a phone; a group never splits across them. */
  .groups { columns: 2 260px; column-gap: 32px; }
  .group { break-inside: avoid; padding-bottom: 16px; }
  .group h3 { margin: 0 0 2px; }
  dl { margin: 0; }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 2px 16px;
    padding: 7px 0;
  }
  .row + .row { border-top: 1px solid var(--color-border); }
  dt { min-width: 0; color: var(--color-foreground); font-size: var(--text-sm); }
  dd { min-width: 0; margin: 0 0 0 auto; color: var(--color-foreground); font-size: var(--text-sm); font-weight: 500; text-align: right; overflow-wrap: anywhere; }
  dd.off { color: var(--color-subtle); font-weight: 400; }
  .source {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 8px;
    margin: 0;
    padding-top: 12px;
    border-top: 1px solid var(--color-border);
    color: var(--color-subtle);
    font-size: var(--text-sm);
  }
  .source code { min-width: 0; font-family: var(--font-mono); font-size: var(--text-sm); color: var(--color-muted-foreground); overflow-wrap: anywhere; }
  .groups + .source { margin-top: -4px; }
</style>
