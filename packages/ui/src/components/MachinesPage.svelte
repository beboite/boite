<script lang="ts">
  import { lockedBy } from '../lib/policy';
  import { onDestroy, tick, untrack } from 'svelte';
  import { ConnectionGroup } from '../lib/connection-group.svelte';
  import { GroupLinks } from '../lib/group-links.svelte';
  import InfoTip from './InfoTip.svelte';
  import PolicyLock from './PolicyLock.svelte';
  import { ArrowUpRight, RefreshCw, Trash2, ScanLine } from '@lucide/svelte';
  import { listedName, machineHealth, machineName, workspace, machineIcons, type Machine } from '../lib/workspace.svelte';
  import { store as primary } from '../lib/store.svelte';
  import { confirm } from '../lib/confirm.svelte';
  import { fill, strings } from '../lib/strings';
  import MachineIcon from './MachineIcon.svelte';
  import GroupCard from './GroupCard.svelte';
  import MainMachine from './MainMachine.svelte';
  import UpdatesCard from './UpdatesCard.svelte';
  import { appUpdater, showAppUpdateUi } from '../lib/app-update.svelte';
  import { machineUpdateState, type MachineUpdateState } from '../lib/machine-updates';
  import PairMachine from './PairMachine.svelte';
  import type { Store } from '../lib/store.svelte';
  let { mobile = false, onopenthread }: { mobile?: boolean; onopenthread?: () => void } = $props();
  const uid = $props.id();
  /**
   * The switches a machine of a group holds for itself: whether the agents of
   * the other machines may start threads there (`groupThreads`), and whether
   * their bots may look after the projects their owner entrusted to them
   * there (`groupBots`). Drawn for a
   * member this client owns and reaches, once the group has another machine.
   */
  function groupThreadsShown(machine: Machine, owner: Store, coreId: string | undefined): boolean {
    const store = machine.store;
    return coreId !== undefined && (owner.group?.cores.length ?? 0) > 1 && owner.group?.cores.some(core => core.coreId === coreId) === true
      && store.owner && store.connection === 'ready' && store.settings !== null;
  }
  /** The thread a failure on that machine was about: opening it shows the cause in its chat, and clears the line. */
  function openFailedThread(machine: Machine) {
    const owner = machine.store;
    const threadId = owner.errorThreadId;
    if (!threadId) return;
    owner.error = null;
    onopenthread?.();
    void workspace.select(owner, threadId);
  }
  const migration = new ConnectionGroup(workspace);
  onDestroy(() => migration.stop());
  const groupStore = $derived((migration.source && workspace.machines.includes(migration.source) ? migration.source.store : null) ?? workspace.machines.find(machine => machine.store.group)?.store ?? workspace.active);
  const groupStores = $derived.by(() => {
    const groups = new Map<string, Store>();
    for (const store of [groupStore, ...workspace.machines.map(machine => machine.store)]) {
      if (!store.group) continue;
      const previous = groups.get(store.group.id);
      // The card draws the device link of the store it is given: one that just minted a link (Tailscale on Advanced) shows it.
      if (!previous || !previous.owner && store.owner || store.owner && store.deviceInvite !== null && previous.deviceInvite === null) groups.set(store.group.id, store);
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
  let pairingForm = $state<{ startAdding: () => void }>();
  /**
   * A machine that tried and did not answer is out of reach, a laptop shut or
   * a server switched off: its row goes grey and keeps only what works without
   * it, its name, its icon and its removal. The client still retries behind it
   * and the row comes back by itself. A machine that refused this device's key
   * keeps its own repair flow instead. One the user depended on (`lost`: this
   * PC, the window's own machine, a turn still running there) stays a warning,
   * in red with its error, as the footer's machine menu shows it.
   */
  const away = (machine: Machine): 'offline' | 'lost' | null => {
    if (machine.store.pairingRequired) return null;
    const health = machineHealth(machine, workspace.active);
    return health === 'offline' || health === 'lost' ? health : null;
  };

  /** Boite on that machine and its agents, as the one word its row shows. */
  function updates(machine: Machine): MachineUpdateState | null {
    const store = machine.store;
    if (store.connection !== 'ready') return null;
    return machineUpdateState({
      server: store.localCore ? null : store.serverUpdater.busy ? { phase: 'checking' } : store.serverUpdater.snapshot,
      // Another machine's desktop app counts once its window reports it, where it can be updated from here.
      app: store.localCore ? (showAppUpdateUi() ? appUpdater.snapshot : null) : store.core?.os === 'windows' ? (store.serverUpdater.desktopFailure ? { phase: 'error' } : store.serverUpdater.desktop) : null,
      agents: store.owner ? store.harnessUpdates : []
    });
  }
  const updateLabels: Record<MachineUpdateState, string> = {
    failed: strings.machines.updateFailed,
    updating: strings.providerSettings.updating,
    available: strings.harnessUpdates.availableShort,
    checking: strings.harnessUpdates.checking,
    current: strings.serverUpdate.current
  };
  /** Docker and hand-made installs update by their own command, and a server too old for the button once by hand: the row says how. */
  function byHand(machine: Machine): string | null {
    if (machine.store.localCore || !machine.store.owner) return null;
    if (machine.store.serverUpdater.legacy) return strings.serverUpdate.legacy;
    const state = machine.store.serverUpdater.snapshot;
    if (!state || state.mode === 'systemd' || state.phase !== 'available') return null;
    return state.mode === 'docker' ? `${strings.serverUpdate.docker} docker compose pull && docker compose up -d` : strings.serverUpdate.manual;
  }

  /** The form already on the page takes it; a second one is drawn only when none is. */
  const topForm = $derived(window.__TAURI_INTERNALS__ === undefined && groupStore.principal !== 'owner' && !workspace.machines.some(machine => machine.store.connection === 'ready'));
  async function repair() {
    if (!topForm) {
      memberRepair = true;
      await tick();
    }
    pairingForm?.startAdding();
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

<div class="page machines-page" data-testid="machines-page">
  <!-- The title and its button belong to the section: a link to the machines lands on them, not under them. -->
  <section class="connections-section" id="settings-machines" aria-label={strings.machines.heading}>
  <header class="head">
    <h1 class="ui-label-box"><span class="ui-label">{strings.settings.tabs.machines}</span><InfoTip topic={strings.settings.tabs.machines} text={strings.machines.intro} /></h1>
  </header>

  <UpdatesCard />

    <!-- A device of a group has nothing to add: its group brings every machine. One that reaches none adds itself here. -->
    {#if topForm}<PairMachine {mobile} bind:this={pairingForm} />{/if}
    {#each groupStores as owner (owner.group?.id ?? 'ungrouped')}
    <GroupCard store={owner} {mobile} migration={owner === groupStores[0] ? migration : undefined}>
    <ul class="machines">
      {#each machinesOf(owner) as machine (machine.id)}
        {@const coreId = GroupLinks.coreOf(machine)}
        {@const state = updates(machine)}
        {@const gone = away(machine) !== null}
        {@const carrier = GroupLinks.carrier(machine, workspace.machines)}
        {@const home = coreId !== undefined && owner.group?.settingsHome === coreId}
        {@const manual = byHand(machine)}
        <li data-core-id={coreId} class="machine-card" class:away={gone} class:lost={away(machine) === 'lost'} data-testid="machine-card" data-group-member={coreId && owner.group?.cores.some(core => core.coreId === coreId) ? "true" : undefined} data-machine-id={machine.id} data-away={away(machine) ?? undefined}>
          <div class="main">
            <button
              class="ghost logo"
              data-testid="machine-customize"
              aria-label={strings.machines.icon}
              title={strings.machines.icon}
              aria-expanded={customizing === machine.id}
              onclick={() => (customizing = customizing === machine.id ? null : machine.id)}
            ><MachineIcon icon={machine.icon} os={machine.store.core?.os} size={18} /></button>
            <div class="identity">
              <span class="title">
                <input class="machine-name" data-testid="machine-rename" aria-label={strings.machines.label} value={machineName(machine)} maxlength="80" size={Math.max(4, machineName(machine).length)}
                  onchange={(event) => { workspace.customize(machine.id, event.currentTarget.value, machine.icon); event.currentTarget.value = machineName(machine); }} />
                {#if listedName(machine) !== machineName(machine)}<span class="you" data-testid="machine-you">{strings.machines.youTag}</span>{/if}
                {#if home}<span class="badge" data-testid="machine-home">{strings.machines.homeBadge}</span>{/if}
              </span>
              <span class="meta" title={machine.store.localCore ? undefined : carrier !== undefined ? fill(strings.group.through, { machine: machineName(carrier) }) : machine.id}>
                <span class="dot" class:ready={machine.store.connection === 'ready'} aria-hidden="true"></span>
                <span class="status ui-label" class:ready={machine.store.connection === 'ready'} data-testid="machine-card-status">{machine.store.pairingRequired ? strings.mobile.pairingRequired : gone ? strings.connection.offline : carrier !== undefined && machine.store.connection === 'ready' ? fill(strings.group.relayed, { machine: machineName(carrier) }) : strings.connection[machine.store.connection]}</span>
                {#if machine.store.connection === 'ready' && machine.store.core?.version}<span class="version" data-testid="machine-version">{machine.store.core.version}</span>{/if}
                {#if state}<span class="updates ui-label" data-testid="machine-updates-state" data-state={state}>{updateLabels[state]}</span>{/if}
                {#if manual}<InfoTip topic={strings.serverUpdate.manualTitle} text={manual} />{/if}
              </span>
            </div>
            <div class="actions">
              {#if machine.store.pairingRequired}
                <button class="ghost small" data-testid="machine-repair" onclick={() => void repair()}><ScanLine size={15} /><span class="ui-label">{strings.mobile.pairAgain}</span></button>
              {:else if machine.store.connection === 'closed'}
                <button class="ghost icon-only" aria-label={strings.common.refresh} title={strings.common.refresh} onclick={() => void machine.store.connect()}><RefreshCw size={15} /></button>
              {/if}
              <!-- The machine already open has nowhere to go, and one out of reach has nothing to open. -->
              {#if machine.store !== workspace.active && !gone}
                <button class="ghost small" data-testid="machine-open" onclick={() => void workspace.select(machine.store)}
                  ><span class="ui-label">{strings.machines.open}</span><ArrowUpRight size={13} /></button
                >
              {/if}
              {#if machine.store !== primary}
                <button class="ghost icon-only remove" data-testid="machine-remove" aria-label={strings.machines.remove} title={strings.machines.remove} onclick={() => void removeMachine(machine, owner)}><Trash2 size={15} /></button>
              {/if}
            </div>
          </div>
          {#if groupThreadsShown(machine, owner, coreId)}
            <label class="group-threads" for="{uid}-threads-{machine.id}" data-testid="machine-group-threads">
              <span class="ui-label-box"><span class="ui-label" id="{uid}-threads-{machine.id}-name">{strings.machines.groupThreads}</span><InfoTip topic={strings.machines.groupThreads} text={strings.machines.groupThreadsHint} /><PolicyLock store={machine.store} keys={['network.groups']} /></span>
              <input id="{uid}-threads-{machine.id}" aria-labelledby="{uid}-threads-{machine.id}-name" type="checkbox" role="switch" data-testid="machine-group-threads-switch"
                checked={machine.store.settings?.groupThreads === true} disabled={lockedBy(machine.store.policy, 'network.groups') !== null}
                onchange={async (event) => { const input = event.currentTarget; if (!(await machine.store.saveSettings({ groupThreads: input.checked }))) input.checked = machine.store.settings?.groupThreads === true; }} />
            </label>
            <label class="group-threads" for="{uid}-bots-{machine.id}" data-testid="machine-group-bots">
              <span class="ui-label-box"><span class="ui-label" id="{uid}-bots-{machine.id}-name">{strings.machines.groupBots}</span><InfoTip topic={strings.machines.groupBots} text={strings.machines.groupBotsHint} /><PolicyLock store={machine.store} keys={['network.groups']} /></span>
              <input id="{uid}-bots-{machine.id}" aria-labelledby="{uid}-bots-{machine.id}-name" type="checkbox" role="switch" data-testid="machine-group-bots-switch"
                checked={machine.store.settings?.groupBots === true} disabled={lockedBy(machine.store.policy, 'network.groups') !== null}
                onchange={async (event) => { const input = event.currentTarget; if (!(await machine.store.saveSettings({ groupBots: input.checked }))) input.checked = machine.store.settings?.groupBots === true; }} />
            </label>
          {/if}
          <div class="disclosure-fold" class:open={customizing === machine.id} inert={customizing !== machine.id}>
            <div>
              <div class="icon-choices" role="group" aria-label={strings.machines.icon}>
                {#each machineIcons as icon (icon)}
                  <button class="ghost icon" class:chosen={machine.icon === icon} data-testid="machine-icon-{icon}" aria-label={strings.machines.icons[icon]} title={strings.machines.icons[icon]} aria-pressed={machine.icon === icon} onclick={() => workspace.customize(machine.id, machine.label, icon)}><MachineIcon {icon} size={17} /></button>
                {/each}
              </div>
            </div>
          </div>
          {#if mobile && machine.store.pairingRequired && (machine.store.error === strings.errors.unpaired || machine.store.error === strings.errors.revoked)}
            <p class="pair-hint">{strings.mobile.pairInstalled}</p>
          <!-- A thread's failure carries the thread's title, never its cause: say it is a thread, and open it. -->
          {:else if machine.store.error && machine.store.errorThreadId}
            <div class="error thread-failed" data-testid="machine-thread-failed">
              <p>{fill(strings.machines.threadFailed, { thread: machine.store.error })}</p>
              <button class="ghost small" data-testid="machine-thread-failed-open" onclick={() => openFailedThread(machine)}><span class="ui-label">{strings.notify.openThread}</span><ArrowUpRight size={13} /></button>
            </div>
          <!-- A remote machine switched off has nothing to explain; this PC's own core failing to start does. A call that found it away repeats its status. -->
          {:else if machine.store.error && away(machine) !== 'offline' && !(away(machine) === 'lost' && machine.store.errorOffline)}<p class="error">{machine.store.error}</p>{/if}
        </li>
      {/each}
    </ul>
    </GroupCard>
    {/each}
    {#if memberRepair}<PairMachine {mobile} bind:this={pairingForm} onpaired={() => memberRepair = false} />{/if}
  </section>

  <!-- Chosen on the device itself, a phone included: it says where that device opens. -->
  <MainMachine />
</div>

<style>
  .machines-page > :global(*) { max-width: var(--settings-width); }
  .connections-section { scroll-margin-top: 24px; }
  .connections-section > :global(.card) { margin-bottom: 20px; }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 16px;
  }
  h1 {
    font-size: var(--text-lg);
    margin: 0;
  }

  .machines {
    list-style: none;
    margin: 0;
    padding: 0;
    scroll-margin-top: 24px;
  }
  .machine-card {
    display: flex;
    flex-direction: column;
    padding: 10px 0;
    border-bottom: 1px solid var(--color-border);
  }
  .main {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 40px;
  }
  /* Under the machine's name, as wide as its identity column. */
  .group-threads {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin: 6px 0 0 48px;
    font-size: var(--text-sm);
    color: var(--color-muted-foreground);
    cursor: pointer;
  }
  .machine-card.away .group-threads { display: none; }
  .logo {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
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
  .title {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  /* A name that reads as a title until it is clicked, as wide as the name. */
  .machine-name {
    width: auto;
    min-width: 0;
    max-width: 100%;
    height: var(--control-sm);
    padding: 0 6px;
    margin-left: -6px;
    font-weight: 600;
    background: transparent;
    border-color: transparent;
    field-sizing: content;
  }
  .machine-name:hover {
    border-color: var(--color-border);
  }
  .machine-name:focus {
    background: var(--color-surface-2);
  }
  .you {
    flex: none;
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
    margin-left: -4px;
  }
  .badge {
    flex: none;
    padding: 1px 7px;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--color-accent) 16%, transparent);
    color: var(--color-accent);
    font-size: var(--text-xs);
    font-weight: 500;
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
  .version {
    font-family: var(--font-mono);
    color: var(--color-muted-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .version::before,
  .updates::before { content: '·'; margin-right: 6px; color: var(--color-subtle); font-family: var(--font-sans); }
  /* Out of reach: grey, still named and still removable. */
  .away .logo { opacity: 0.5; }
  .away .machine-name { color: var(--color-muted-foreground); }
  .away .dot { background: var(--color-subtle); }
  .away .status { color: var(--color-subtle); }
  .lost .dot { background: var(--color-danger); }
  .lost .status { color: var(--color-danger); }
  /* What the machine has to say about its updates, after its connection. */
  .updates { color: var(--color-muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: none; }
  .updates[data-state='available'] { color: var(--color-accent); }
  .updates[data-state='failed'] { color: var(--color-danger); }
  .remove { color: var(--color-danger); }
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
  .icon-only.remove { color: var(--color-muted-foreground); }
  .icon-only.remove:hover { color: var(--color-danger); }
  .icon-choices {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 8px 0 2px 48px;
  }
  .icon-choices .chosen {
    color: var(--color-foreground);
    background: var(--color-surface-3);
    box-shadow: inset 0 0 0 1px var(--color-border);
  }
  .error {
    color: var(--color-danger);
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
    margin: 6px 0 0 48px;
  }
  .thread-failed {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .thread-failed p { margin: 0; min-width: 0; }
  .thread-failed button { flex: none; }
  .pair-hint { color: var(--color-muted-foreground); font-size: var(--text-sm); line-height: 1.6; margin: 12px 0 0; }
  @media (max-width: 720px) {
    .machines-page {
      padding: 16px;
    }
    .head { flex-wrap: wrap; gap: 8px 12px; }
    /* The name keeps the first line; what else the row offers goes under it. */
    .main {
      flex-wrap: wrap;
    }
    .identity { flex-basis: calc(100% - 48px); }
    .meta { flex-wrap: wrap; gap: 2px 10px; }
    .version::before,
    .updates::before { content: none; }
    .actions {
      width: 100%;
      justify-content: flex-end;
    }
    .actions:empty {
      display: none;
    }
    .actions button {
      min-height: var(--touch-target);
    }
    .actions .icon-only { min-width: var(--touch-target); }
    .icon-choices,
    .error {
      padding-left: 0;
      margin-left: 0;
    }
  }
</style>
