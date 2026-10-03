<script lang="ts">
  import { untrack } from 'svelte';
  import { Pencil } from '@lucide/svelte';
  import type { AgentGroup, AgentTeam } from '@boite/contracts';
  import type { AgentsView } from '../../lib/agents.svelte';
  import { strings } from '../../lib/strings';
  import AgentAvatar from './AgentAvatar.svelte';

  /**
   * Who is in a conversation. A team is a group whose members have roles: the
   * roles are edited here, and the first edit on a plain group makes it a team.
   * A team with no group yet starts its conversation from here.
   */
  let { view, memberIds, group, team, onopen }: {
    view: AgentsView;
    memberIds: string[];
    group: AgentGroup | null;
    team: AgentTeam | null;
    onopen: (agentId: string) => void;
  } = $props();

  const labels = $derived(strings.agents);
  const members = $derived(memberIds.flatMap(id => view.snapshot?.profiles.find(a => a.id === id) ?? []));
  const roleOf = (id: string) => team?.members.find(m => m.agentId === id)?.responsibility ?? '';
  let editing = $state(false);
  let roles = $state<Record<string, string>>(untrack(() => Object.fromEntries(memberIds.map(id => [id, roleOf(id)]))));

  function edit() {
    roles = Object.fromEntries(memberIds.map(id => [id, roleOf(id)]));
    editing = true;
  }
  async function saveRoles() {
    // A team keeps the members it has outside the group, so its missions stay valid.
    const ids = [...memberIds, ...(team?.members.map(m => m.agentId).filter(id => !memberIds.includes(id)) ?? [])];
    const value = {
      name: team?.name ?? group?.name ?? '', description: team?.description ?? '',
      members: ids.map(agentId => ({ agentId, responsibility: (roles[agentId] ?? roleOf(agentId)).trim() })),
      projectIds: team?.projectIds ?? [], groupId: team?.groupId ?? group?.id ?? null, paused: team?.paused ?? false
    };
    const saved = await view.call('agents.team.save', { ...(team ? { id: team.id, expectedRevision: team.revision } : {}), value });
    if (saved) editing = false;
  }
  /** Gives a team with no conversation a group of its members, and names it as the team's. */
  async function startChat() {
    if (!team) return;
    const made = await view.call('agents.group.save', { value: { name: team.name, memberIds: team.members.map(m => m.agentId), mode: 'mentions', maxTurns: 6, maxTurnsPerAgent: 2, paused: false } });
    const latest = view.snapshot?.teams.find(t => t.id === team.id) ?? team;
    if (made) await view.call('agents.team.save', { id: latest.id, expectedRevision: latest.revision, value: { name: latest.name, description: latest.description, members: latest.members, projectIds: latest.projectIds, groupId: made.id, paused: latest.paused } });
  }
</script>

<section class="card agent-members" data-testid="agent-members">
  <div class="agent-card-head">
    <h2>{labels.members}</h2>
    {#if view.store.owner && !editing && members.length}
      <button type="button" class="ghost small" onclick={edit} data-testid="agent-roles-edit"><Pencil size={14} strokeWidth={1.75} /><span class="ui-label">{labels.editRoles}</span></button>
    {/if}
  </div>
  {#if editing}
    <form class="agent-roles" onsubmit={event => { event.preventDefault(); void saveRoles(); }}>
      {#each members as agent (agent.id)}
        <label class="agent-member">
          <AgentAvatar kind="profile" id={agent.id} name={agent.name} avatar={agent.avatar} size={32} />
          <span class="agent-member-text"><strong>{agent.name}</strong><input bind:value={roles[agent.id]} maxlength="2000" placeholder={labels.responsibility} aria-label="{agent.name}: {labels.responsibility}" data-testid="agent-role-{agent.id}" /></span>
        </label>
      {/each}
      <div class="agent-form-actions">
        <button type="submit" class="primary" disabled={view.pending} data-testid="agent-roles-save"><span class="ui-label">{labels.save}</span></button>
        <button type="button" class="ghost" onclick={() => { editing = false; }}><span class="ui-label">{labels.cancel}</span></button>
      </div>
    </form>
  {:else}
    {#each members as agent (agent.id)}
      <button type="button" class="ghost agent-member" onclick={() => onopen(agent.id)} data-testid="agent-member-{agent.id}">
        <AgentAvatar kind="profile" id={agent.id} name={agent.name} avatar={agent.avatar} size={32} />
        <span class="agent-member-text"><strong>{agent.name}</strong>{#if roleOf(agent.id) || agent.domain}<small>{roleOf(agent.id) || agent.domain}</small>{/if}</span>
      </button>
    {:else}<p class="hint">{labels.noMembers}</p>{/each}
  {/if}
</section>

{#if team && !group && view.store.owner && members.length}
  <div class="agent-form-actions agent-start"><button type="button" class="primary" disabled={view.pending} onclick={() => void startChat()} data-testid="agent-start-chat"><span class="ui-label">{labels.startChat}</span></button></div>
{/if}
