<script lang="ts">
  import type { AgentsView } from '../../lib/agents.svelte';
  import { strings } from '../../lib/strings';
  let { view }: { view: AgentsView } = $props();
  async function save(accountId: string, agentIds: string[] | null) {
    const grants = [...(view.snapshot?.accountGrants.filter(g => g.accountId !== accountId) ?? []), { accountId, agentIds }];
    await view.call('agents.accounts.set', { grants });
  }
</script>

<section class="card" data-testid="agent-account-access">
  <h2>{strings.agents.accountAccess}</h2>
  <p class="hint">{strings.agents.accountAccessHint}</p>
  {#each view.store.accounts as account (account.id)}
    {@const grant = view.snapshot?.accountGrants.find(g => g.accountId === account.id)}
    <div class="agent-grant">
      <label class="switch-row">
        <span class="text">{account.label}<span class="hint">{view.store.providerOf(account.providerId)?.name} · {strings.agents.allAgents}</span></span>
        <input type="checkbox" role="switch" disabled={view.pending} checked={!grant || grant.agentIds === null} onchange={e => void save(account.id, e.currentTarget.checked ? null : [])} />
      </label>
      {#if grant?.agentIds}
        <div class="agent-checks">
          {#each view.snapshot?.profiles ?? [] as agent (agent.id)}
            <label><input type="checkbox" disabled={view.pending} checked={grant.agentIds.includes(agent.id)} onchange={e => void save(account.id, e.currentTarget.checked ? [...grant.agentIds!, agent.id] : grant.agentIds!.filter(id => id !== agent.id))} />{agent.name}</label>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
</section>
