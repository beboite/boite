<!--
  Settings, Companion, Agents: the agents standing side by side as the
  companion (`lib/companion/crew.svelte.ts`). Each keeps its conversation, its
  memory, its model and its look in the Agents page; here one is made or
  added, given a new look, or taken off the screen, which leaves it an
  ordinary agent.
-->
<script lang="ts">
  import { ChevronDown, ExternalLink, Plus, Shuffle, X } from '@lucide/svelte';
  import type { AgentProfile } from '@boite/contracts';
  import InfoTip from '../InfoTip.svelte';
  import Menu from '../Menu.svelte';
  import CompanionCharacter from './CompanionCharacter.svelte';
  import { agentDirectory } from '../../lib/agent-directory.svelte';
  import type { MenuItem } from '../../lib/menu';
  import { fill, strings } from '../../lib/strings';
  import type { Store } from '../../lib/store.svelte';
  import { COMPANION_DOMAIN, permissionModeOf, pickBrain, roleBlock } from '../../lib/companion/brain';
  import { companionAgent, freshSkin, membersOf, profileWith, skinOf } from '../../lib/companion/crew';
  import { releaseAgent } from '../../lib/companion/crew.svelte';
  import { showAgentPage } from '../../lib/companion/follow.svelte';
  import { CREW_MAX, readCompanionPrefs, writeCompanionPrefs, type CompanionPrefs } from '../../lib/companion/prefs';
  import { taskProjects } from '../../lib/companion/tasks';

  let { store, prefs }: { store: Store; prefs: CompanionPrefs } = $props();

  const copy = $derived(strings.companion.settings.crew);
  const NAME_MAX = 60;

  const directory = $derived(agentDirectory(store));
  $effect(() => directory.watch());

  const snapshot = $derived(directory.snapshot);
  const members = $derived(membersOf(snapshot, prefs.agents));
  const full = $derived(members.length >= CREW_MAX);
  const candidates = $derived(snapshot?.profiles.filter((profile) => profile.status === 'active' && !prefs.agents.includes(profile.id)) ?? []);
  const candidateItems = $derived<MenuItem[]>(candidates.map((profile) => ({ id: profile.id, label: profile.name, hint: profile.domain || undefined })));

  let name = $state('');
  let busy = $state(false);
  let problem = $state<string | null>(null);

  const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  const othersThan = (id: string | null) => members.filter((member) => member.id !== id).map(skinOf);

  /** One change at a time; the directory reads the agents again after it. */
  async function run(change: (client: NonNullable<Store['client']>) => Promise<unknown>) {
    const client = store.client;
    if (!client || busy) return;
    busy = true;
    problem = null;
    try {
      await change(client);
      directory.reload();
    } catch (error) {
      problem = fill(strings.companion.failed, { reason: reasonOf(error) });
    } finally {
      busy = false;
    }
  }

  function restyle(agent: AgentProfile) {
    void run((client) => client.call('agents.profile.save', profileWith(agent, { avatar: freshSkin(crypto.randomUUID(), othersThan(agent.id)) })));
  }

  // Off the list first, so the companion does not give the role back.
  function remove(agent: AgentProfile) {
    void run(async (client) => {
      writeCompanionPrefs({ agents: readCompanionPrefs().agents.filter((id) => id !== agent.id) });
      await releaseAgent(client, agent);
    });
  }

  // The companion's window gives an added agent its role.
  function add(id: string) {
    if (full) return;
    writeCompanionPrefs({ agents: [...readCompanionPrefs().agents, id], crewMade: true });
  }

  function create(event: SubmitEvent) {
    event.preventDefault();
    const wanted = name.trim();
    if (!wanted || full) return;
    const brain = pickBrain(prefs, store.providers, store.accounts);
    if (!brain) {
      problem = prefs.providerId === null ? strings.companion.noBrain : strings.companion.brainOff;
      return;
    }
    const projects = taskProjects(store.projects).map((project) => project.name);
    const agent = companionAgent(wanted, COMPANION_DOMAIN, roleBlock(projects), freshSkin(crypto.randomUUID(), othersThan(null)), brain, permissionModeOf(prefs.control));
    void run(async (client) => {
      const { id } = await client.call('agents.profile.save', agent);
      writeCompanionPrefs({ agents: [...readCompanionPrefs().agents, id], crewMade: true });
      name = '';
    });
  }

  const open = (agent: AgentProfile) => showAgentPage(store, agent.id);

</script>

<section class="card" data-testid="companion-crew">
  <h2 class="ui-label-box"><span class="ui-label">{copy.title}</span><InfoTip topic={copy.title} text={fill(copy.hint, { count: String(CREW_MAX) })} /></h2>
  {#if snapshot === null}
    <p class="hint">{copy.loading}</p>
  {:else}
    {#if members.length === 0}
      <p class="hint">{copy.empty}</p>
    {:else}
      <ul class="crew">
        {#each members as agent, index (agent.id)}
          <li>
            <span class="look"><CompanionCharacter mood="idle" skin={skinOf(agent)} size={34} lively={false} /></span>
            <span class="who">
              <span class="name">{agent.name}</span>
              {#if index === 0 && members.length > 1}<span class="lead">{copy.leader}</span>{/if}
            </span>
            <button class="ghost icon" title={copy.restyle} aria-label={fill(copy.restyleLabel, { name: agent.name })} disabled={busy} onclick={() => restyle(agent)} data-testid="companion-crew-restyle"><Shuffle size={15} /></button>
            <button class="ghost icon" title={fill(copy.open, { name: agent.name })} aria-label={fill(copy.open, { name: agent.name })} onclick={() => open(agent)}><ExternalLink size={15} /></button>
            <button
              class="ghost icon"
              title={members.length > 1 ? fill(copy.remove, { name: agent.name }) : copy.lastOne}
              aria-label={fill(copy.remove, { name: agent.name })}
              disabled={busy || members.length <= 1}
              onclick={() => remove(agent)}
              data-testid="companion-crew-remove"
            ><X size={15} /></button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if full}
      <p class="hint">{fill(copy.full, { count: String(CREW_MAX) })}</p>
    {:else}
      <form class="add" onsubmit={create}>
        <input type="text" bind:value={name} placeholder={copy.namePlaceholder} aria-label={copy.nameLabel} maxlength={NAME_MAX} autocomplete="off" data-testid="companion-crew-name" />
        <button type="submit" class="ghost" disabled={!name.trim() || busy}><Plus size={14} />{copy.create}</button>
        {#if candidateItems.length > 0}
          <Menu items={candidateItems} onpick={add} label={copy.addExisting} placement="bottom" align="end" testid="companion-crew-add">
            <span class="ui-label">{copy.addExisting}</span><ChevronDown size={13} />
          </Menu>
        {/if}
      </form>
    {/if}
  {/if}
  {#if problem}<p class="hint problem" role="alert">{problem}</p>{/if}
</section>

<style>
  .crew {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .crew li {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 52px;
    border-bottom: 1px solid var(--color-border);
  }
  .crew li:last-child {
    border-bottom: none;
  }
  .look {
    flex: none;
    display: grid;
    place-items: center;
    width: 44px;
  }
  .who {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .name {
    font-size: var(--text-sm);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lead {
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }
  .crew .icon {
    flex: none;
  }
  .add {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 12px;
  }
  .add input {
    flex: 1;
    min-width: 12ch;
  }
  /* Over `.settings .page .hint` in app.css. */
  .card .problem {
    color: var(--color-danger);
  }
</style>
