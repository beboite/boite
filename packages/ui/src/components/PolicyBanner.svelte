<script lang="ts">
  import { ChevronRight, TriangleAlert } from '@lucide/svelte';
  import type { PolicyProblem } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';
  import InfoTip from './InfoTip.svelte';

  /**
   * A strip above every settings page while the machine's admin policy has
   * problems: how many, and whether the file failed closed, which is said
   * outright. The lines the core logs, field and what was expected there under
   * the file they come from, open below it. The core applies what it could read
   * and fails closed on the rest.
   */
  let { store }: { store: Store } = $props();
  const policy = $derived(store.policy);
  let open = $state(false);
  const id = `policy-problems-${Math.random().toString(36).slice(2, 10)}`;

  /** The first twenty problems under their file, each file named once, in the order the core read them. */
  const files = $derived.by(() => {
    const byFile = new Map<string, PolicyProblem[]>();
    for (const problem of policy?.problems.slice(0, 20) ?? []) byFile.set(problem.file, [...byFile.get(problem.file) ?? [], problem]);
    return [...byFile].map(([file, problems]) => ({ file, problems }));
  });

  function title(count: number, closed: boolean): string {
    if (closed) return strings.policy.closedTitle;
    return count === 1 ? strings.policy.problemsOne : fill(strings.policy.problemsMany, { count: String(count) });
  }
</script>

{#if policy?.present && policy.problems.length > 0}
  {@const closed = policy.failedClosed}
  <section class="card policy-banner" class:closed role="alert" data-testid="policy-banner" data-state={closed ? 'closed' : 'partial'}>
    <div class="head">
      <TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
      <p class="title"><span data-testid="policy-banner-title">{title(policy.problems.length, closed)}</span> <InfoTip topic={strings.policy.problemsTopic} text={strings.policy.problemsInfo} /></p>
      <button type="button" class="ghost small toggle" aria-expanded={open} aria-controls={id} data-testid="policy-banner-toggle" onclick={() => (open = !open)}>
        <span class="ui-label">{strings.policy.details}</span>
        <ChevronRight size={14} class={open ? 'fold-caret open' : 'fold-caret'} aria-hidden="true" />
      </button>
    </div>
    {#if closed}<p class="note" data-testid="policy-banner-closed">{strings.policy.failedClosed}</p>{/if}
    <div class="disclosure-fold" class:open {id} inert={!open} data-testid="policy-banner-details">
      <div>
        <div class="details">
          {#each files as group (group.file)}
            <p class="file"><span>{strings.policy.file}</span><code data-testid="policy-banner-file">{group.file}</code></p>
            <ul>
              {#each group.problems as problem, index (index)}
                <li data-testid="policy-problem" data-field={problem.field}>
                  <code>{problem.field}</code>
                  <span>{fill(strings.policy.expected, { expected: problem.expected })}</span>
                </li>
              {/each}
            </ul>
          {/each}
        </div>
      </div>
    </div>
  </section>
{/if}

<style>
  .policy-banner {
    --tone: var(--color-live);
    max-width: var(--settings-width);
    padding: 8px 8px 8px 14px;
    box-shadow: none;
    border-color: color-mix(in srgb, var(--tone) 35%, var(--color-border));
    background: color-mix(in srgb, var(--tone) 6%, var(--color-surface));
  }
  .policy-banner.closed { --tone: var(--color-danger); }
  .head { display: flex; align-items: center; gap: 10px; min-height: var(--control); }
  .head > :global(svg) { flex: none; color: var(--tone); }
  .title { flex: 1; min-width: 0; margin: 0; color: var(--color-foreground); font-size: var(--text-sm); font-weight: 500; line-height: 1.4; }
  .title :global(button) { vertical-align: middle; }
  .toggle { flex: none; gap: 4px; color: var(--color-muted-foreground); }
  .toggle :global(.fold-caret) { color: currentColor; }
  .note { margin: 0 6px 4px 26px; color: var(--color-foreground); font-size: var(--text-sm); line-height: 1.5; }
  .details { display: grid; gap: 6px; margin: 4px 6px 6px 26px; padding-top: 10px; border-top: 1px solid var(--color-border); }
  .file { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; margin: 0; color: var(--color-subtle); font-size: var(--text-sm); }
  .file code { min-width: 0; font-family: var(--font-mono); font-size: var(--text-sm); color: var(--color-muted-foreground); overflow-wrap: anywhere; }
  .file:not(:first-child) { margin-top: 6px; }
  /* Fields in one column and what each expected in the next, so the eye runs down the fields; one column on a phone. */
  ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: fit-content(45%) minmax(0, 1fr); gap: 4px 12px; }
  li { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; align-items: baseline; }
  li code { font-family: var(--font-mono); font-size: var(--text-sm); line-height: 1.5; color: var(--color-foreground); overflow-wrap: anywhere; }
  li span { min-width: 0; font-size: var(--text-sm); line-height: 1.5; color: var(--color-muted-foreground); overflow-wrap: anywhere; }
  @media (max-width: 720px) {
    ul { grid-template-columns: minmax(0, 1fr); gap: 8px; }
  }
</style>
