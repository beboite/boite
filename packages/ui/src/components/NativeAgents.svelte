<script lang="ts">
  import type { NativeAgent } from '@boite/contracts';
  import { ChevronRight } from '@lucide/svelte';
  import { fill, strings } from '../lib/strings';
  let { agents }: { agents: NativeAgent[] } = $props();
</script>

<section class="native" data-testid="native-agents">
  <h3>{strings.delegation.nativeHeading} <span>{agents.length}</span></h3>
  {#each agents as agent, index (agent.id)}
    <details class="agent" data-testid="native-agent">
      <summary>
        <ChevronRight size={12} class="chevron" />
        <span class="identity"><strong>{agent.name ?? agent.task ?? fill(strings.delegation.profileName, { count: String(index + 1) })}</strong>{#if agent.model}<small>{agent.model}</small>{/if}</span>
        <span class="status" data-status={agent.status}>{strings.delegation.nativeStatus[agent.status]}</span>
      </summary>
      <div class="body">
        {#if agent.task}<p>{agent.task}</p>{/if}
        {#if agent.result}<p class="result">{agent.result}</p>{:else}<p class="hint">{strings.delegation.nativeNoResult}</p>{/if}
      </div>
    </details>
  {/each}
</section>

<style>
  .native { flex: none; padding: 14px 16px; border-bottom: 1px solid var(--color-border); }
  h3 { display: flex; gap: 8px; margin-bottom: 6px; font-size: var(--text-sm); }
  h3 span, .hint, small, .status { color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .hint { margin: 5px 0 10px; line-height: 1.5; }
  .agent + .agent { border-top: 1px solid var(--color-border); }
  summary { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 10px 0; cursor: pointer; min-height: var(--row); }
  .identity { min-width: 0; flex: 1; display: grid; gap: 3px; }
  summary :global(.chevron) { flex: none; color: var(--color-muted-foreground); }
  details[open] summary :global(.chevron) { transform: rotate(90deg); }
  strong { font-size: var(--text-sm); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  small { overflow-wrap: anywhere; }
  .status { flex: none; }
  .status[data-status='error'] { color: var(--color-danger); }
  .body { max-height: 240px; overflow-y: auto; font-size: var(--text-sm); overflow-wrap: anywhere; }
  .body p { white-space: pre-wrap; margin: 0 0 10px; }
  .result { border-left: 2px solid var(--color-border); padding-left: 10px; }
</style>
