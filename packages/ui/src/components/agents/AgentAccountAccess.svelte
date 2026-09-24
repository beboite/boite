<script lang="ts">
  import type { AgentsView } from '../../lib/agents.svelte';
  import { strings } from '../../lib/strings';
  let { view }: { view: AgentsView } = $props();
  async function save(accountId: string, agentIds: string[] | null) {
    const grants = [...(view.snapshot?.accountGrants.filter(g => g.accountId !== accountId) ?? []), { accountId, agentIds }];
    await view.call('agents.accounts.set', { grants });
  }
</script>
<details class="agent-background" data-testid="agent-account-access">
  <summary>{strings.agents.accountAccess}</summary>
  <p class="muted">{strings.agents.accountAccessHint}</p>
  {#each view.store.accounts as account (account.id)}
    {@const grant = view.snapshot?.accountGrants.find(g => g.accountId === account.id)}
    <fieldset disabled={view.pending}><legend>{account.label} · {view.store.providerOf(account.providerId)?.name}</legend>
      <label class="agent-check"><input type="checkbox" checked={!grant || grant.agentIds === null} onchange={e => void save(account.id, e.currentTarget.checked ? null : [])} />{strings.agents.allAgents}</label>
      {#if grant?.agentIds}
        {#each view.snapshot?.profiles ?? [] as agent (agent.id)}<label class="agent-check"><input type="checkbox" checked={grant.agentIds.includes(agent.id)} onchange={e => void save(account.id, e.currentTarget.checked ? [...grant.agentIds!, agent.id] : grant.agentIds!.filter(id => id !== agent.id))} />{agent.name}</label>{/each}
      {/if}
    </fieldset>
  {/each}
</details>
