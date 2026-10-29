<script lang="ts">
  import { lockedBy } from '../lib/policy';
  import { Lock } from '@lucide/svelte';
  import type { PolicyKey } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';
  import InfoTip from './InfoTip.svelte';

  /**
   * The lock beside a control the admin policy holds; it opens, as an "i"
   * does, the line that says who holds it. The control itself is disabled by its owner; the core
   * refuses the change whatever is drawn.
   */
  let { store, keys }: { store: Store; keys: PolicyKey[] } = $props();
  const key = $derived(lockedBy(store.policy, ...keys));
</script>

{#if key}
  <span class="policy-lock" data-testid="policy-lock" data-key={key}>
    <InfoTip icon={Lock} topic={strings.policy.managed} text={fill(strings.policy.lockedHint, { key, file: store.policy?.file ?? '' })} testid="policy-lock-tip" />
  </span>
{/if}

<style>
  .policy-lock {
    display: inline-flex;
    align-items: center;
    flex: none;
    margin-left: 6px;
    color: var(--color-muted-foreground);
    vertical-align: middle;
  }
  .policy-lock :global(.info-tip) { margin-left: 0; }
</style>
