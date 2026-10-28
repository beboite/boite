<script lang="ts">
  import { TriangleAlert } from '@lucide/svelte';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';
  import InfoTip from './InfoTip.svelte';

  /**
   * Above every settings page while the machine's admin policy has problems:
   * each line names the file, the field and what was expected there, as the
   * core logs it. The core applies what it could read and fails closed on the rest.
   */
  let { store }: { store: Store } = $props();
  const policy = $derived(store.policy);
</script>

{#if policy?.present && policy.problems.length > 0}
  <section class="card policy-banner" role="alert" data-testid="policy-banner">
    <h2><TriangleAlert size={15} strokeWidth={1.75} aria-hidden="true" /><span class="title">{strings.policy.problemsTitle} <InfoTip topic={strings.policy.problemsTitle} text={strings.policy.problemsInfo} /></span></h2>
    {#if policy.failedClosed}<p class="note" data-testid="policy-banner-closed">{strings.policy.failedClosed}</p>{/if}
    <ul>
      {#each policy.problems.slice(0, 20) as problem, index (index)}
        <li data-testid="policy-problem" data-field={problem.field}>
          <code class="file">{problem.file}</code>
          <span>{fill(strings.policy.problem, { field: problem.field, expected: problem.expected })}</span>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .policy-banner { max-width: var(--settings-width); padding: var(--settings-padding); box-shadow: none; border-color: color-mix(in srgb, var(--color-danger) 45%, var(--color-border)); }
  h2 { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 12px; color: var(--color-foreground); font-size: var(--text-md); line-height: 1.4; }
  h2 > :global(svg) { flex: none; margin-top: 0.25em; color: var(--color-danger); }
  .title { min-width: 0; }
  .title :global(button) { vertical-align: middle; }
  .note { margin: 0 0 8px; color: var(--color-muted-foreground); font-size: var(--text-sm); line-height: 1.5; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  li { display: grid; gap: 2px; font-size: var(--text-sm); color: var(--color-foreground); overflow-wrap: anywhere; }
  .file { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--color-subtle); }
</style>
