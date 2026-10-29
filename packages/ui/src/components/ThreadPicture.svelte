<script lang="ts">
  import type { ThreadSummary } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { agentLabel } from '../lib/format';
  import { agentDirectory } from '../lib/agent-directory.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import AgentAvatar from './agents/AgentAvatar.svelte';

  /**
   * Who runs a thread: the agent it belongs or was entrusted to, else the
   * provider's logo, whose tooltip names the provider and the model.
   */
  let { owner, thread, size = 12 }: { owner: Store; thread: ThreadSummary; size?: number } = $props();
  let agent = $derived(agentLabel(owner, thread));
  /** A persistent agent's thread, a sub-thread and an entrusted thread wear that agent's picture where the logo goes. */
  let runner = $derived(thread.agentSessionId || thread.parentThreadId ? agentDirectory(owner).ownerOf(thread) : agentDirectory(owner).entrustmentOf(thread.id)?.agent ?? null);
</script>

{#if runner}
  <span class="picture" data-testid="thread-agent" role="img" title={`${runner.name} · ${agent}`} aria-label={runner.name}>
    <AgentAvatar kind="profile" id={runner.id} name={runner.name} avatar={runner.avatar} size={Math.max(16, size)} />
  </span>
{:else}
  <span class="picture" data-testid="thread-provider" role="img" title={agent} aria-label={agent}>
    <ProviderLogo providerId={thread.providerId} {size} />
  </span>
{/if}

<style>
  .picture { display: inline-flex; align-items: center; flex: none; }
</style>
