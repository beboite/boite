<script lang="ts">
  import InfoTip from './InfoTip.svelte';
  import { Plus, ArrowUpRight, RefreshCw, Settings2, Trash2, X } from '@lucide/svelte';
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
  let { mobile = false }: { mobile?: boolean } = $props();
  let label = $state(''),
    link = $state(''),
    url = $state(''),
    token = $state('');
  let busy = $state(false);
  /** The add form stays folded behind its button, unless there is nothing else to show. */
  let adding = $state(false);
  let open = $derived(adding || workspace.machines.length === 0);
  /** The one card whose icon choices are unfolded. */
  let customizing = $state<string | null>(null);
  let settingsId = $state<string | null>(null);
  const settingsMachine = $derived(workspace.machines.find(machine => machine.id === settingsId && machine.store.owner));
  let linkInput = $state<HTMLInputElement | null>(null);
  /** Said before connecting: the link decides the machine, the name only labels it. */
  let target = $derived(workspace.linkTarget(link));
  let source = $derived(workspace.machines.find(machine => machine.store === workspace.active) ?? null);
  const sync = workspace.settingsSync;
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
  function startAdding() {
    adding = true;
    requestAnimationFrame(() => linkInput?.focus());
  }
  function stopAdding() {
    adding = false;
    link = '';
    token = '';
    url = '';
    label = '';
  }
  async function add(manual = false) {
    if (busy) return;
    busy = true;
    try {
      const ok = manual
        ? await workspace.add({ url: url.trim(), token }, label)
        : await workspace.pair(link.trim(), label);
      if (ok) stopAdding();
    } finally {
      busy = false;
    }
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
      <h1>{mobile ? strings.machines.heading : strings.settings.tabs.machines}<InfoTip topic={strings.machines.heading} text={strings.machines.intro} /></h1>
    </div>
    {#if !open}
      <button class="primary add-open" data-testid="machine-add-open" onclick={startAdding}><Plus size={15} />{strings.machines.add}</button>
    {/if}
  </header>

  <div class="reveal" class:open inert={!open}>
    <div>
      <section class="card add" data-testid="machine-add-card" aria-label={strings.machines.add}>
        <div class="add-head">
          <h2>{strings.machines.add}<InfoTip topic={strings.machines.add} text={strings.machines.addHint} /></h2>
          {#if workspace.machines.length > 0}
            <button class="ghost icon-only" data-testid="machine-add-close" aria-label={strings.common.cancel} title={strings.common.cancel} onclick={stopAdding}><X size={15} /></button>
          {/if}
        </div>
        <form
          onsubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <label>{strings.machines.link}<input
              bind:this={linkInput}
              bind:value={link}
              data-testid="machine-link"
              type="password"
              autocomplete="off"
              spellcheck="false"
            /></label>
          {#if target}
            <p class="link-target" data-testid="machine-link-target">{target.machine
              ? fill(target.machine.store.connection === 'ready' ? strings.machines.linkConnected : strings.machines.linkReplaces, { host: target.host, machine: target.machine.label })
              : fill(strings.machines.linkReaches, { host: target.host })}</p>
          {/if}
          <label>{strings.machines.labelOptional}<input bind:value={label} data-testid="machine-name" autocomplete="off" placeholder={strings.machines.labelPlaceholder} /></label>
          <button type="submit" class="primary" data-testid="machine-add" disabled={busy || !link.trim()}
            ><Plus size={14} />{busy ? strings.machines.adding : strings.machines.connect}</button
          >
        </form>
        <details class="disclosure">
          <summary>{strings.machines.manual}</summary>
          <form
            onsubmit={(e) => {
              e.preventDefault();
              void add(true);
            }}
          >
            <label>{strings.settings.coreUrl}<input bind:value={url} data-testid="machine-url" autocomplete="off" spellcheck="false" /></label>
            <label>{strings.settings.token}<input bind:value={token} data-testid="machine-token" type="password" autocomplete="off" /></label>
            <button class="primary" disabled={busy || !url.trim() || !token}
              >{busy ? strings.machines.adding : strings.machines.connect}</button
            >
          </form>
        </details>
        {#if workspace.error}<p class="error" role="alert">{workspace.error}</p>{/if}
      </section>
    </div>
  </div>

  <div class="machines" id="settings-machines">
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
              <span class="status" class:ready={machine.store.connection === 'ready'}>{strings.connection[machine.store.connection]}</span>
              <span class="address">{machine.store.localCore ? strings.machines.local : machine.id}</span>
            </span>
          </div>
          <div class="actions">
            {#if machine.store.connection === 'closed'}
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
        {#if machine.store.owner}
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
        {#if !machine.store.localCore}<ServerUpdateCard store={machine.store} label={machine.label} />{/if}
        {#if machine.store.error}<p class="error">{machine.store.error}</p>{/if}
      </section>
    {/each}
  </div>

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
  .machines-page > .reveal { margin-bottom: 20px; }
  .machines-page > .reveal:not(.open) { margin-bottom: 0; }
  .machines { margin-bottom: 20px; }
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
  h2 {
    font-size: var(--text-base);
    margin: 0;
  }
  .add-open {
    flex: none;
    margin-top: 2px;
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

  .add {
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .add-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: flex-start;
    margin-top: 6px;
  }

  .link-target {
    margin: -4px 0 0;
    font-size: var(--text-sm);
    color: var(--color-muted-foreground);
    overflow-wrap: anywhere;
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
  details {
    margin-top: 8px;
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
  }
  summary {
    cursor: pointer;
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
    .add-open {
      width: 100%;
      min-height: var(--touch-target);
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
