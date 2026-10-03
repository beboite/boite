<script lang="ts">
  import InfoTip from './InfoTip.svelte';
  import { ArrowUpRight, Download, Monitor, RefreshCw, Settings2, Trash2, ScanLine } from '@lucide/svelte';
  import { workspace, machineIcons, type Machine } from '../lib/workspace.svelte';
  import { store as primary } from '../lib/store.svelte';
  import { confirm } from '../lib/confirm.svelte';
  import { fill, strings } from '../lib/strings';
  import MachineIcon from './MachineIcon.svelte';
  import RemoteCoordination from './RemoteCoordination.svelte';
  import PairingCard from './PairingCard.svelte';
  import PhoneSettings from './PhoneSettings.svelte';
  import MachineSettings from './MachineSettings.svelte';
  import ServerUpdateCard from './ServerUpdateCard.svelte';
  import HarnessUpdatesCard from './HarnessUpdatesCard.svelte';
  import AppUpdateContent from './AppUpdateContent.svelte';
  import { showAppUpdateUi } from '../lib/app-update.svelte';
  import PairMachine from './PairMachine.svelte';
  let { mobile = false }: { mobile?: boolean } = $props();
  let customizing = $state<string | null>(null);
  let settingsId = $state<string | null>(null);
  let pairingForm = $state<{ startAdding: () => void }>();
  const settingsMachine = $derived(workspace.machines.find(machine => machine.id === settingsId && machine.store.owner));
  let source = $derived(workspace.machines.find(machine => machine.store === workspace.active) ?? null);
  const sync = workspace.settingsSync;
  $effect(() => {
    const section = workspace.active.settingsSection;
    if (workspace.active.settingsTab === 'machines' && section) {
      void section.request;
      settingsId = null;
    }
  });
  const canSync = (machine: Machine): boolean => source !== null && source !== machine
    && source.store.owner && machine.store.owner && sync.canEnable(source, machine);

  /** Sign-ins happen on the machine that keeps them: its own Providers page. */
  async function openProviders(machine: Machine) {
    await workspace.select(machine.store);
    machine.store.showSettings('accounts');
  }
  /** Forgetting a machine drops its saved address and key: getting it back takes a new pairing link made there. */
  async function removeMachine(machine: { id: string; label: string }) {
    const ok = await confirm.ask({
      title: fill(strings.machines.removeTitle, { machine: machine.label }),
      body: strings.machines.removeBody,
      confirmLabel: strings.machines.remove,
      cancelLabel: strings.common.cancel,
      danger: true
    });
    if (!ok) return;
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
      <h1>{strings.settings.tabs.machines}<InfoTip topic={strings.settings.tabs.machines} text={strings.machines.intro} /></h1>
    </div>

  </header>

  <section class="updates-section" id="settings-updates" aria-labelledby="updates-heading">
    <h2 class="section-heading" id="updates-heading"><Download size={16} />{strings.serverUpdate.updates}</h2>
    <p class="section-hint">{strings.machines.updatesHint}</p>
    {#if showAppUpdateUi()}
      <section class="card app-update-card" data-testid="app-update-card">
        <h3>{strings.appUpdate.heading}<span>{strings.machines.local}</span></h3>
        <AppUpdateContent beforeInstall={() => undefined} />
      </section>
    {/if}
    <div class="update-machines">
      {#each workspace.machines as machine (machine.id)}
        {#if machine.store.owner || !machine.store.localCore}
          <section class="card update-machine" data-testid="machine-updates-card" data-machine-id={machine.id}>
            <header class="update-machine-heading">
              <MachineIcon icon={machine.icon} os={machine.store.core?.os} size={18} />
              <h3>{machine.label}</h3>
              <span class="status" class:ready={machine.store.connection === 'ready'}>{machine.store.pairingRequired ? strings.mobile.pairingRequired : strings.connection[machine.store.connection]}</span>
            </header>
            {#if !machine.store.localCore}<ServerUpdateCard store={machine.store} label={machine.label} />{/if}
            {#if machine.store.owner}<HarnessUpdatesCard store={machine.store} />{/if}
          </section>
        {/if}
      {/each}
    </div>
  </section>

  <section class="connections-section" id="settings-machines" aria-labelledby="connections-heading">
    <h2 class="section-heading" id="connections-heading"><Monitor size={16} />{strings.machines.connections}</h2>
    <PairMachine {mobile} bind:this={pairingForm} />

    <div class="machines">
      {#each workspace.machines as machine (machine.id)}
        <section class="card machine-card" data-testid="machine-card" data-machine-id={machine.id}>
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
                <span class="status" class:ready={machine.store.connection === 'ready'}>{machine.store.pairingRequired ? strings.mobile.pairingRequired : strings.connection[machine.store.connection]}</span>
                <span class="address">{machine.store.localCore ? strings.machines.local : machine.id}</span>
              </span>
            </div>
            <div class="actions">
              {#if machine.store.pairingRequired}
                <button class="ghost small" data-testid="machine-repair" onclick={() => pairingForm?.startAdding()}><ScanLine size={15} />{strings.mobile.pairAgain}</button>
              {:else if machine.store.connection === 'closed'}
                <button class="ghost icon-only" aria-label={strings.common.refresh} title={strings.common.refresh} onclick={() => void machine.store.connect()}><RefreshCw size={15} /></button>
              {/if}
              {#if machine.store !== primary}
                <button class="ghost icon-only" data-testid="machine-remove" aria-label={strings.machines.remove} title={strings.machines.remove} onclick={() => void removeMachine(machine)}><Trash2 size={15} /></button>
              {/if}
              <!-- The machine already open has nowhere to go. -->
              {#if machine.store !== workspace.active}
                <button class="ghost small" data-testid="machine-open" onclick={() => void workspace.select(machine.store)}
                  >{strings.machines.open}<ArrowUpRight size={13} /></button
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
          {#if sync.enabled(machine) || canSync(machine)}
            <label class="sync-option">
              <input type="checkbox" data-testid="machine-sync" checked={sync.enabled(machine)}
                onchange={(event) => sync.set(machine, event.currentTarget.checked ? source : null)} />
              <span>{fill(strings.machines.syncFrom, { source: sync.source(machine)?.label ?? source?.label ?? '' })}</span>
              <InfoTip topic={strings.machines.syncConfirm} text={strings.machines.syncHint} />
            </label>
            {#if sync.busy[machine.id]}<p class="sync-progress" role="status">{strings.machines.syncing}</p>{/if}
          {/if}
          {#if machine.store.owner && machine.store.core}
            <button class="ghost small machine-settings-button" data-testid="machine-settings-open" disabled={machine.store.connection !== 'ready' || !machine.store.settings} onclick={() => settingsId = machine.id}>
              <Settings2 size={14} />{strings.machines.settings}
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
                  <button class="small" data-testid="machine-sync-providers" onclick={() => void openProviders(machine)}>{strings.machines.syncOpenProviders}</button>
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
  </section>

  <!-- Links join two machines this window owns: with one, the card has nothing to offer. -->
  {#if workspace.machines.filter(machine => machine.store.owner).length > 1}
    <RemoteCoordination />
  {/if}



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
  .machines { margin-bottom: 20px; }
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
  .app-update-card h3 span { font-size: var(--text-xs); font-weight: 400; color: var(--color-muted-foreground); }
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
    padding: 12px 14px;
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

  label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    font-size: var(--text-sm);
    color: var(--color-muted-foreground);
  }
  input {
    width: 100%;
  }
  /* What the copy did, under the card it wrote to, and what is left to do there. */
  .sync-option {
    flex-direction: row;
    align-items: center;
    width: auto;
    margin: 10px 0 2px 52px;
    min-height: var(--control);
  }
  .sync-option input { width: auto; flex: none; }
  .sync-progress { margin: 6px 0 2px 52px; font-size: var(--text-sm); color: var(--color-muted-foreground); }
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
    .sync-report,
    .sync-option,
    .sync-progress {
      padding-left: 0;
      margin-left: 0;
    }
    .machine-settings-button { margin-left: 0; min-height: var(--touch-target); }
  }
</style>
