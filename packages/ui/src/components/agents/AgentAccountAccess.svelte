<script lang="ts">
  import type { AgentAccountGrant } from '@boite/contracts';
  import type { AgentsView } from '../../lib/agents.svelte';
  import { Autosave } from '../../lib/autosave.svelte';
  import { providerName } from '../../lib/format';
  import { strings } from '../../lib/strings';
  import SaveStatus from '../SaveStatus.svelte';
  let { view }: { view: AgentsView } = $props();
  /** Grants not yet saved; the switches show them, and a refused save leaves them beside its error. */
  let draft = $state<AgentAccountGrant[] | null>(null);
  const grants = $derived(draft ?? view.snapshot?.accountGrants ?? []);
  const save = new Autosave(async () => {
    const sent = draft;
    if (!sent) return;
    await view.save('agents.accounts.set', () => ({ grants: sent }));
    if (draft === sent) draft = null;
  });
  function grant(accountId: string, agentIds: string[] | null) {
    draft = [...grants.filter(g => g.accountId !== accountId), { accountId, agentIds }];
    save.change();
  }
</script>

<section class="card" data-testid="agent-account-access">
  <h2>{strings.agents.accountAccess}<SaveStatus {save} /></h2>
  <p class="hint">{strings.agents.accountAccessHint}</p>
  {#each view.store.accounts as account (account.id)}
    {@const access = grants.find(g => g.accountId === account.id)}
    <div class="agent-grant">
      <label class="switch-row">
        <span class="text">{account.label}<span class="hint">{providerName(view.store, account.providerId)} · {strings.agents.allAgents}</span></span>
        <input type="checkbox" role="switch" checked={!access || access.agentIds === null} onchange={e => grant(account.id, e.currentTarget.checked ? null : [])} />
      </label>
      {#if access?.agentIds}
        <div class="agent-checks">
          {#each view.snapshot?.profiles ?? [] as agent (agent.id)}
            <label><input type="checkbox" checked={access.agentIds.includes(agent.id)} onchange={e => grant(account.id, e.currentTarget.checked ? [...access.agentIds!, agent.id] : access.agentIds!.filter(id => id !== agent.id))} />{agent.name}</label>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
</section>
