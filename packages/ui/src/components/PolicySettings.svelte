<script lang="ts">
  import { Lock } from '@lucide/svelte';
  import type { PolicyKey } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { policyValue } from '../lib/policy';
  import { strings } from '../lib/strings';
  import InfoTip from './InfoTip.svelte';

  /**
   * Settings > General's "Managed by your organization": the policy file and
   * every key it locks, with its value. Drawn only on a machine that has a
   * policy; a machine without one shows nothing.
   */
  let { store }: { store: Store } = $props();
  const policy = $derived(store.policy);

  function providerName(id: string): string {
    return store.providers.find((provider) => provider.id === id)?.name ?? id;
  }

  function valueOf(key: PolicyKey): string {
    const value = policyValue(policy!.values, key);
    if (Array.isArray(value)) {
      const items = key.startsWith('providers.') ? value.map((id: string) => providerName(id)) : value as string[];
      return items.length === 0 ? strings.policy.values.none : items.join(', ');
    }
    if (value === true) return strings.policy.values.on;
    if (value === false) return strings.policy.values.off;
    if (key === 'agentBrowser.searchUrl' && typeof value === 'string') return value;
    const words = strings.policy.values as Record<string, string>;
    return typeof value === 'string' ? words[value] ?? value : '';
  }
</script>

{#if policy?.present}
  <section class="card" id="settings-policy" data-testid="policy-settings">
    <h2 class="ui-label-box"><Lock size={15} strokeWidth={1.75} aria-hidden="true" /><span class="ui-label">{strings.policy.heading}</span><InfoTip topic={strings.policy.heading} text={strings.policy.info} /></h2>
    <p class="file"><span class="label">{strings.policy.file}</span><code data-testid="policy-file">{policy.file}</code></p>
    {#if policy.failedClosed}<p class="hint warn" data-testid="policy-failed-closed">{strings.policy.failedClosed}</p>{/if}
    {#if policy.locked.length === 0}
      <p class="hint">{strings.policy.none}</p>
    {:else}
      <ul class="keys">
        {#each policy.locked as key (key)}
          <li data-testid="policy-key" data-key={key}>
            <span class="name">{strings.policy.keys[key]}</span>
            <span class="value">{valueOf(key)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  h2 { display: flex; align-items: center; gap: 8px; }
  h2 :global(svg) { flex: none; color: var(--color-muted-foreground); }
  .file { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; margin: 0 0 8px; font-size: var(--text-sm); color: var(--color-muted-foreground); }
  code { font-family: var(--font-mono); font-size: var(--text-sm); color: var(--color-foreground); overflow-wrap: anywhere; }
  .hint { color: var(--color-muted-foreground); font-size: var(--text-sm); line-height: 1.5; margin: 4px 0 8px; }
  .hint.warn { color: var(--color-live); }
  .keys { list-style: none; margin: 0; padding: 0; }
  .keys li { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 16px; min-height: var(--row); padding: 8px 0; }
  .keys li + li { border-top: 1px solid var(--color-border); }
  .name { color: var(--color-foreground); font-size: var(--text-base); }
  .value { color: var(--color-muted-foreground); font-size: var(--text-sm); text-align: right; overflow-wrap: anywhere; min-width: 0; }
</style>
