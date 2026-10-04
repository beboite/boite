<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import { ConnectionGroup } from '../lib/connection-group.svelte';
  import { GroupLinks } from '../lib/group-links.svelte';
  import InfoTip from './InfoTip.svelte';
  import { ArrowUpRight, Download, Monitor, RefreshCw, Settings2, Trash2, ScanLine } from '@lucide/svelte';
  import { workspace, machineIcons, type Machine } from '../lib/workspace.svelte';
  import { store as primary } from '../lib/store.svelte';
  import { confirm } from '../lib/confirm.svelte';
  import { fill, strings } from '../lib/strings';
  import MachineIcon from './MachineIcon.svelte';
  import GroupCard from './GroupCard.svelte';
  import PairingCard from './PairingCard.svelte';
  import PhoneSettings from './PhoneSettings.svelte';
  import MachineSettings from './MachineSettings.svelte';
  import ServerUpdateCard from './ServerUpdateCard.svelte';
  import HarnessUpdatesCard from './HarnessUpdatesCard.svelte';
  import AppUpdateContent from './AppUpdateContent.svelte';
  import { showAppUpdateUi } from '../lib/app-update.svelte';
  import PairMachine from './PairMachine.svelte';
  import type { Store } from '../lib/store.svelte';
  let { mobile = false }: { mobile?: boolean } = $props();
  const migration = new ConnectionGroup(workspace);
  onDestroy(() => migration.stop());
  const groupStore = $derived((migration.source && workspace.machines.includes(migration.source) ? migration.source.store : null) ?? workspace.machines.find(machine => machine.store.group)?.store ?? workspace.active);
  const groupStores = $derived.by(() => {
    const groups = new Map<string, Store>();
    for (const store of [groupStore, ...workspace.machines.map(machine => machine.store)]) {
      if (!store.group) continue;
      const previous = groups.get(store.group.id);
      if (!previous || !previous.owner && store.owner) groups.set(store.group.id, store);
    }
    return groups.size ? [...groups.values()] : [groupStore];
  });
  function machinesOf(owner: Store): Machine[] {
    return workspace.machines.filter(machine => {
      const groupId = machine.store.group?.id ?? machine.groupId;
      return groupId ? groupId === owner.group?.id : owner === groupStores[0];
    });
  }
  $effect(() => {
    for (const machine of workspace.machines) {
      void machine.store.connection;
      void machine.store.groupKnown;
    }
    untrack(() => void migration.merge());
  });
  let memberRepair = $state(false);
  let customizing = $state<string | null>(null);
  let settingsId = $state<string | null>(null);
  let pairingForm = $state<{ startAdding: () => void }>();
  const settingsMachine = $derived(workspace.machines.find(machine => machine.id === settingsId && machine.store.owner));
  const sync = workspace.settingsSync;
  $effect(() => {
    const section = workspace.active.settingsSection;
    if (workspace.active.settingsTab === 'machines' && section) {
      void section.request;
      settingsId = null;
    }
  });

  /** Sign-ins happen on the machine that keeps them: its own Providers page. */
  async function repair() {
    memberRepair = true;
    await tick();
    pairingForm?.startAdding();
  }

  async function openProviders(machine: Machine) {
    await workspace.select(machine.store);
    machine.store.showSettings('accounts');
  }
  /** Removing a member ends its group membership and forgets its connection on this client. */
  async function removeMachine(machine: Machine, owner: Store) {
    const groupId = owner.group?.id;
    const member = workspace.machines.find(candidate => candidate.id === machine.id);
    const coreId = member && GroupLinks.coreOf(member);
    const grouped = coreId !== undefined && owner.group?.cores.some(core => core.coreId === coreId);
    const ok = await confirm.ask({
      title: fill(grouped ? strings.group.removeTitle : strings.machines.removeTitle, { machine: machine.label }),
      body: grouped ? strings.group.removeBody : strings.machines.removeBody,
      confirmLabel: strings.machines.remove,
      cancelLabel: strings.common.cancel,
      danger: true
    });
    if (!ok) return;
    if (grouped && (!owner.owner || owner.group?.id !== groupId)) return;
    if (coreId && owner.owner && owner.group?.cores.some(core => core.coreId === coreId)) {
      const removed = coreId === owner.group.self ? await owner.leaveGroup() : await owner.removeFromGroup(coreId);
      if (!removed) return;
    }
    await workspace.remove(machine.id);
  }
</script>

{#if settingsMachine}
  {#key settingsMachine.id}
    <MachineSettings machine={settingsMachine} source={sync.source(settingsMachine)?.label} onback={() => settingsId = null} />
  {/key}
{:else}
<div class="page machines-page" data-testid="machines-page">
  <header class="head">
    <div>
      <h1 class="ui-label-box"><span class="ui-label">{strings.settings.tabs.machines}</span><InfoTip topic={strings.settings.tabs.machines} text={strings.machines.intro} /></h1>
    </div>

  </header>

  <section class="updates-section" id="settings-updates" aria-labelledby="updates-heading">
    <h2 class="section-heading ui-label-box" id="updates-heading"><Download size={16} /><span class="ui-label">{strings.serverUpdate.updates}</span></h2>
    <p class="section-hint">{strings.machines.updatesHint}</p>
    {#if showAppUpdateUi()}
      <section class="card app-update-card" data-testid="app-update-card">
        <h3 class="ui-label-box"><span class="ui-label">{strings.appUpdate.heading}</span><span class="local ui-label">{strings.machines.local}</span></h3>
        <AppUpdateContent beforeInstall={() => undefined} />
      </section>
    {/if}
    <div class="update-machines">
      {#each workspace.machines as machine (machine.id)}
        {#if machine.store.owner || !machine.store.localCore}
          <section class="card update-machine" data-testid="machine-updates-card" data-machine-id={machine.id}>
            <header class="update-machine-heading">
              <MachineIcon icon={machine.icon} os={machine.store.core?.os} size={18} />
              <h3 class="ui-label-box"><span class="ui-label">{machine.label}</span></h3>
              <span class="status ui-label" class:ready={machine.store.connection === 'ready'}>{machine.store.pairingRequired ? strings.mobile.pairingRequired : strings.connection[machine.store.connection]}</span>
            </header>
            {#if !machine.store.localCore}<ServerUpdateCard store={machine.store} label={machine.label} />{/if}
            {#if machine.store.owner}<HarnessUpdatesCard store={machine.store} />{/if}
          </section>
        {/if}
      {/each}
    </div>
  </section>

  <section class="connections-section" id="settings-machines" aria-labelledby="connections-heading">
    <h2 class="section-heading ui-label-box" id="connections-heading"><Monitor size={16} /><span class="ui-label">{strings.machines.connections}</span></h2>
    {#if !groupStore.owner}<PairMachine {mobile} bind:this={pairingForm} />{/if}
    {#each groupStores as owner (owner.group?.id ?? 'ungrouped')}
    <GroupCard store={owner} {mobile} migration={owner === groupStores[0] ? migration : undefined}>
    <div class="machines">
      {#each machinesOf(owner) as machine (machine.id)}
        {@const coreId = GroupLinks.coreOf(machine)}
        <section data-core-id={coreId} class="machine-card" data-testid="machine-card" data-group-member={coreId && owner.group?.cores.some(core => core.coreId === coreId) ? "true" : undefined} data-machine-id={machine.id}>
          <div class="main">
            <button
              class="ghost logo"
              data-testid="machine-customize"
              aria-label={strings.machines.icon}
              title={strings.machines.icon}
              aria-expanded={customizing === machine.id}
              onclick={() => (customizing = customizing === machine.id ? null : machine.id)}
            ><MachineIcon icon={machine.icon} os={machine.store.core?.os} size={20} /></button>
            <div class="identity">
              <input class="machine-name" data-testid="machine-rename" aria-label={strings.machines.label} value={machine.label} maxlength="80" onchange={(event) => { workspace.customize(machine.id, event.currentTarget.value, machine.icon); event.currentTarget.value = machine.label; }} />
              <span class="meta">
                <span class="dot" class:ready={machine.store.connection === 'ready'} aria-hidden="true"></span>
                <span class="status ui-label" class:ready={machine.store.connection === 'ready'}>{machine.store.pairingRequired ? strings.mobile.pairingRequired : strings.connection[machine.store.connection]}</span>
                <span class="address ui-label">{machine.store.localCore ? strings.machines.local : machine.id}</span>
              </span>
            </div>
            <div class="actions">
              {#if machine.store.pairingRequired}
                <button class="ghost small" data-testid="machine-repair" onclick={() => { if (groupStore.owner) void repair(); else pairingForm?.startAdding(); }}><ScanLine size={15} /><span class="ui-label">{strings.mobile.pairAgain}</span></button>
              {:else if machine.store.connection === 'closed'}
                <button class="ghost icon-only" aria-label={strings.common.refresh} title={strings.common.refresh} onclick={() => void machine.store.connect()}><RefreshCw size={15} /></button>
              {/if}
              {#if machine.store !== primary}
                <button class="ghost icon-only" data-testid="machine-remove" aria-label={strings.machines.remove} title={strings.machines.remove} onclick={() => void removeMachine(machine, owner)}><Trash2 size={15} /></button>
              {/if}
              <!-- The machine already open has nowhere to go. -->
              {#if machine.store !== workspace.active}
                <button class="ghost small" data-testid="machine-open" onclick={() => void workspace.select(machine.store)}
                  ><span class="ui-label">{strings.machines.open}</span><ArrowUpRight size={13} /></button
                >
              {/if}
            </div>
          </div>
          <div class="reveal" class:open={customizing === machine.id} inert={customizing !== machine.id}>
            <div>
              <div class="icon-choices" role="group" aria-label={strings.machines.icon}>
                {#each machineIcons as icon (icon)}
                  <button class="ghost icon" class:chosen={machine.icon === icon} data-testid="machine-icon-{icon}" aria-label={strings.machines.icons[icon]} title={strings.machines.icons[icon]} aria-pressed={machine.icon === icon} onclick={() => workspace.customize(machine.id, machine.label, icon)}><MachineIcon {icon} size={17} /></button>
                {/each}
              </div>
            </div>
          </div>
          {#if machine.store.owner && machine.store.core}
            <button class="ghost small machine-settings-button" data-testid="machine-settings-open" disabled={machine.store.connection !== 'ready' || !machine.store.settings} onclick={() => settingsId = machine.id}>
              <Settings2 size={14} /><span class="ui-label">{strings.machines.settings}</span>
            </button>
          {/if}
          {#if sync.reports[machine.id]}
            {@const done = sync.reports[machine.id]!}
            {#if done.report.keybindings === null || done.report.brain === 'absent' || done.report.providers.length > 0}
              <div class="sync-report" role="status" data-testid="machine-sync-report">
                {#if done.report.keybindings === null}<p>{strings.machines.syncKeysAbsent}</p>{/if}
                {#if done.report.brain === 'absent'}<p>{strings.machines.syncBrainAbsent}</p>{/if}
                {#if done.report.providers.length > 0}
                  <p>{fill(strings.machines.syncProviders, { providers: done.report.providers.map((row) => row.name).join(', ') })}</p>
                  <button class="small" data-testid="machine-sync-providers" onclick={() => void openProviders(machine)}><span class="ui-label">{strings.machines.syncOpenProviders}</span></button>
                {/if}
              </div>
            {/if}
          {/if}
          {#if mobile && machine.store.pairingRequired && (machine.store.error === strings.errors.unpaired || machine.store.error === strings.errors.revoked)}
            <p class="pair-hint">{strings.mobile.pairInstalled}</p>
          {:else if machine.store.error}<p class="error">{machine.store.error}</p>{/if}
        </section>
      {/each}
    </div>
    </GroupCard>
    {/each}
    {#if memberRepair}<PairMachine {mobile} bind:this={pairingForm} onpaired={() => memberRepair = false} />{/if}
  </section>



  {#if !mobile}
    <!-- A phone pairs from the computer, never from itself: both cards are the desktop's. -->
    <PairingCard store={workspace.active} />
    <PhoneSettings store={workspace.active} />
  {/if}
</div>
{/if}

<style>
  .machines-page {
    padding: 36px clamp(20px, 4vw, 64px);
  }
  .machines-page > :global(*) { max-width: var(--settings-width); }
  .machines { margin: 0; }
  .updates-section { margin: 20px 0 28px; scroll-margin-top: 84px; }
  .connections-section { scroll-margin-top: 24px; }
  .section-heading { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; font-size: var(--text-base); }
  .section-heading :global(svg) { color: var(--color-muted-foreground); flex: none; }
  .section-hint { margin: -4px 0 16px; color: var(--color-muted-foreground); font-size: var(--text-sm); line-height: 1.5; }
  .update-machines { display: grid; gap: 12px; }
  .update-machine { padding: 14px; }
  .update-machine-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .update-machine-heading h3 { flex: 1; min-width: 0; margin: 0; font-size: var(--text-sm); overflow-wrap: anywhere; }
  .update-machine-heading .status { font-size: var(--text-xs); }
  .app-update-card { padding: 0; margin-bottom: 12px; }
  .app-update-card h3 { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin: 0; padding: 14px 14px 0; font-size: var(--text-sm); }
  .app-update-card h3 .local { font-size: var(--text-xs); font-weight: 400; color: var(--color-muted-foreground); }
  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }
  h1 {
    font-size: var(--text-lg);
    margin: 0 0 8px;
  }

  /* Folds on its row height, so a close animates as much as an open. */
  .reveal {
    display: grid;
    grid-template-rows: 0fr;
    opacity: 0;
    transition: grid-template-rows var(--dur-3) var(--ease-out-quint), opacity var(--dur-2);
  }
  .reveal.open {
    grid-template-rows: 1fr;
    opacity: 1;
  }
  .reveal > div {
    overflow: hidden;
    min-height: 0;
  }

  .machines {
    display: grid;
    gap: 8px;
    scroll-margin-top: 24px;
  }
  .machine-card {
    display: flex;
    flex-direction: column;
    padding: 12px 0;
    border-bottom: 1px solid var(--color-border);
  }
  .main {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .logo {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    padding: 0;
    border-radius: var(--radius-md);
    background: var(--color-surface-3);
    color: var(--color-muted-foreground);
    flex: none;
  }
  .logo:hover,
  .logo[aria-expanded='true'] {
    color: var(--color-foreground);
    box-shadow: inset 0 0 0 1px var(--color-edge);
  }
  .identity {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  /* A name that reads as a title until it is clicked. */
  .machine-name {
    width: 100%;
    height: var(--control-sm);
    padding: 0 6px;
    margin-left: -6px;
    font-weight: 600;
    background: transparent;
    border-color: transparent;
  }
  .machine-name:hover {
    border-color: var(--color-border);
  }
  .machine-name:focus {
    background: var(--color-surface-2);
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: var(--text-xs);
    color: var(--color-subtle);
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-live);
    flex: none;
  }
  .dot.ready {
    background: var(--color-success);
  }
  .status {
    color: var(--color-live);
    flex: none;
  }
  .status.ready {
    color: var(--color-success);
  }
  .address {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .address::before {
    content: '·';
    margin-right: 6px;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: none;
  }
  .icon-only {
    width: var(--control);
    padding: 0;
    color: var(--color-muted-foreground);
  }
  .icon-choices {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 10px 0 2px 52px;
  }
  .icon-choices .chosen {
    color: var(--color-foreground);
    background: var(--color-surface-3);
    box-shadow: inset 0 0 0 1px var(--color-border);
  }

  input {
    width: 100%;
  }
  /* What the copy did, under the card it wrote to, and what is left to do there. */
  .machine-settings-button { align-self: flex-start; margin: 8px 0 2px 52px; }
  .sync-report {
    display: grid;
    justify-items: start;
    gap: 6px;
    margin: 10px 0 2px 52px;
    font-size: var(--text-sm);
    color: var(--color-muted-foreground);
  }
  .sync-report p { margin: 0; }
  .error {
    color: var(--color-danger);
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
    margin-top: 8px;
  }
  .pair-hint { color: var(--color-muted-foreground); font-size: var(--text-sm); line-height: 1.6; margin: 12px 0 0; }
  @media (prefers-reduced-motion: reduce) {
    .reveal {
      transition: none;
    }
  }
  @media (max-width: 720px) {
    .machines-page {
      padding: 16px;
    }
    .head {
      flex-direction: column;
      align-items: stretch;
      gap: 12px;
    }
    .main {
      flex-wrap: wrap;
    }
    .identity {
      flex-basis: calc(100% - 52px);
    }
    .actions {
      width: 100%;
      justify-content: flex-end;
    }
    .icon-choices,
    .sync-report {
      padding-left: 0;
      margin-left: 0;
    }
    .machine-settings-button { margin-left: 0; min-height: var(--touch-target); }
  }
</style>
