<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ConnectionGroup } from '../lib/connection-group.svelte';
  import type { GroupCore, GroupDevice } from '@boite/contracts';
  import { ChevronDown, Globe, LogOut, Plus, Smartphone, Trash2 } from '@lucide/svelte';
  import AddDevice from './AddDevice.svelte';
  import Menu from './Menu.svelte';
  import { confirm } from '../lib/confirm.svelte';
  import { GroupLinks } from '../lib/group-links.svelte';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { listedName, workspace } from '../lib/workspace.svelte';
  import InfoTip from './InfoTip.svelte';
  import MachineIcon from './MachineIcon.svelte';

  /**
   * The group of the machine this page shows: its machines and its devices in
   * one list, how each machine is reached from this window, and the one way
   * in, "Add a device". A phone reads the group and changes nothing.
   */
  let { store, mobile = false, children, migration }: { store: Store; mobile?: boolean; children?: Snippet; migration?: ConnectionGroup } = $props();
  const uid = $props.id();
  const sync = workspace.settingsSync;
  /** An address only the machine itself can dial. */
  const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/;

  let name = $state('');
  let invitation = $state('');
  let busy = $state<'join' | 'add' | 'rename' | 'home' | null>(null);
  let editing = $state(false);
  let editingId = $state<string | null>(null);
  let renameInput = $state<HTMLInputElement>();
  $effect(() => { if (editing && group?.id !== editingId) editing = false;
    else if (editing && renameInput) { renameInput.focus(); renameInput.select(); } });
  async function rename() {
    if (!editing || busy || !group || group.id !== editingId) return;
    if (!name.trim()) { name = group.name; editing = false; return; }
    const target = store;
    await run('rename', async () => {
      if (name.trim() === target.group?.name || await target.renameGroup(name.trim())) editing = false;
    });
  }
  let group = $derived(store.group);
  /**
   * A core from before "Add a device" (it says `deviceKeys` at hello since the
   * same release) answers `unknown method`: the button says to update it
   * instead of failing once pressed.
   */
  let older = $derived(store.core !== null && store.core.features?.deviceKeys !== true);
  /** The owner as the machine said at hello: before any answer, a page with no key is nobody's yet. */
  let owner = $derived(store.owner && store.principal !== null);
  let members = $derived.by(() => {
    if (!group) return [];
    const self = group.self;
    return [...group.cores.filter((core) => core.coreId === self), ...group.cores.filter((core) => core.coreId !== self)];
  });
  /** A member's status in its row, or the sentence under it when it cannot be reached. */
  function status(core: GroupCore): { label: string | null; hint: string | null; ready: boolean } {
    if (core.coreId === group?.self) return { label: strings.group.self, hint: null, ready: true };
    const machine = workspace.machines.find((candidate) => GroupLinks.coreOf(candidate) === core.coreId);
    if (machine?.store.connection === 'ready') {
      // Carried by another machine of the group: which one is said, since that one being off cuts this one off too.
      const through = GroupLinks.carrier(machine, workspace.machines);
      return { label: through === undefined ? strings.group.connected : fill(strings.group.relayed, { machine: through.label }), hint: null, ready: true };
    }
    const state = workspace.groups.states[core.coreId];
    if (state === 'unreachable' || state === 'insecure') return { label: null, hint: strings.group[state], ready: false };
    return { label: strings.group.connecting, hint: null, ready: false };
  }
  let loopback = $derived.by(() => {
    const self = members[0];
    return self !== undefined && self.addresses.length > 0 && self.addresses.every((address) => LOOPBACK.test(address));
  });

  /**
   * The default machine: the member every other one takes its settings from,
   * chosen once for the group, so every member and every window shows it.
   */
  const NONE = 'none';
  let home = $derived(group?.settingsHome ?? null);
  /** A member by the name this window gives it, "(you)" for this computer, else the one it gives itself. */
  function memberName(core: GroupCore): string {
    const machine = workspace.machines.find((candidate) => GroupLinks.coreOf(candidate) === core.coreId);
    return machine ? listedName(machine) : core.name;
  }
  /** A core before the choice cannot store one: its options stay shut, and the hint below says to update it. */
  let homeReady = $derived(store.core?.features?.settingsHome === true);
  let homeItems = $derived([
    // Shut while another change of the card is on its way: `run` would drop the pick, the menu having closed already.
    { id: NONE, label: strings.machines.homeNone, active: home === null, disabled: !homeReady || busy !== null },
    ...members.map((core) => ({ id: core.coreId, label: memberName(core), active: core.coreId === home, disabled: !homeReady || busy !== null }))
  ]);
  let homeCore = $derived(members.find((core) => core.coreId === home));
  /** Members connected here whose Boite predates the choice: they keep their own settings until updated. */
  let behind = $derived(workspace.machines.filter((machine) => machine.store.connection === 'ready' && machine.store.core !== null
    && members.some((core) => core.coreId === GroupLinks.coreOf(machine)) && machine.store.core.features?.settingsHome !== true));
  const pickHome = (id: string) => void run('home', () => store.setSettingsHome(id === NONE ? null : id));

  async function run(kind: 'join' | 'add' | 'rename' | 'home', work: () => Promise<unknown>) {
    if (busy) return;
    busy = kind;
    try {
      await work();
    } finally {
      busy = null;
    }
  }
  const join = () => run('join', async () => { if (await store.joinGroup(invitation.trim())) invitation = ''; });
  const add = () => run('add', () => store.addDevice());
  /** A machine alone in its group, or in none, may join another one and bring its devices; one with company leaves first. */
  let alone = $derived(!group || group.cores.every((core) => core.coreId === group!.self));

  /** What a device calls itself (`phone`, `browser`, an app's name), in this language. */
  function deviceName(device: GroupDevice): string {
    const name = device.name.toLowerCase();
    if (name === 'phone' || name === 'pwa') return strings.group.phone;
    if (name === 'browser') return strings.group.browser;
    return device.name;
  }
  function deviceIcon(device: GroupDevice): typeof Smartphone {
    return device.name.toLowerCase() === 'browser' ? Globe : Smartphone;
  }
  function addedOn(device: GroupDevice): string | null {
    if (device.legacy) return strings.group.deviceLegacy;
    // The name this device gave that machine, else the one the machine gives itself.
    const label = workspace.machines.find((machine) => GroupLinks.coreOf(machine) === device.by)?.label;
    const by = label ?? group?.cores.find((core) => core.coreId === device.by)?.name;
    return by === undefined ? null : fill(strings.group.deviceAdded, { machine: by });
  }

  async function revoke(device: GroupDevice) {
    const ok = await confirm.ask({
      title: fill(strings.group.revokeDeviceTitle, { device: deviceName(device) }),
      body: strings.group.revokeDeviceBody,
      confirmLabel: strings.group.revokeDevice,
      cancelLabel: strings.common.cancel,
      danger: true
    });
    if (ok) await store.revokeDevice(device.id);
  }

  async function remove(core: GroupCore) {
    const ok = await confirm.ask({
      title: fill(strings.group.removeTitle, { machine: core.name }),
      body: strings.group.removeBody,
      confirmLabel: strings.group.remove,
      cancelLabel: strings.common.cancel,
      danger: true
    });
    if (ok) {
      const machine = workspace.machines.find(candidate => GroupLinks.coreOf(candidate) === core.coreId);
      if (await store.removeFromGroup(core.coreId) && machine && machine.store !== workspace.primary) await workspace.remove(machine.id);
    }
  }

  async function leave() {
    if (!group) return;
    const ok = await confirm.ask({
      title: fill(strings.group.leaveTitle, { group: group.name }),
      body: strings.group.leaveBody,
      confirmLabel: strings.group.leave,
      cancelLabel: strings.common.cancel,
      danger: true
    });
    if (ok) await store.leaveGroup();
  }
</script>

{#if group}
  <section class="card group" class:mobile data-testid="group-card" id="settings-group">
    <header>
      <h2>
        {#if editing}
          <form class="rename" onsubmit={(event) => { event.preventDefault(); void rename(); }}>
            <input bind:this={renameInput} bind:value={name} data-testid="group-rename" aria-label={strings.group.name} maxlength="80" disabled={busy === 'rename'}
              onblur={() => void rename()} onkeydown={(event) => { if (event.key === 'Escape') { event.preventDefault(); editing = false; } else if (event.key === 'Enter') { event.preventDefault(); void rename(); } }} />
          </form>
        {:else if owner}
          <button class="ghost group-name" data-testid="group-rename-start" title={strings.group.rename} onclick={() => { name = group!.name; editingId = group!.id; editing = true; }}>{group.name}</button>
        {:else}{group.name}{/if}
        <InfoTip topic={strings.group.heading} text={strings.group.intro} />
      </h2>
      {#if owner}{@render addButton()}{/if}
    </header>
    {@render children?.()}
    {#if children && loopback}<p class="hint">{strings.group.loopback}</p>{/if}
    {@render progress()}
    {#if members.some(core => !children || !workspace.machines.some(machine => GroupLinks.coreOf(machine) === core.coreId))}
    <ul class="members" aria-label={strings.group.members}>
      {#each members.filter(core => !children || !workspace.machines.some(machine => GroupLinks.coreOf(machine) === core.coreId)) as core (core.coreId)}
        {@const state = status(core)}
        <li data-testid="group-member" data-core-id={core.coreId}>
          <div class="row">
            <span class="logo"><MachineIcon os={core.os} size={18} /></span>
            <span class="identity">
              <span class="name">{core.name}{#if core.coreId === home}<span class="badge">{strings.machines.homeBadge}</span>{/if}</span>
              {#if core.addresses[0]}<span class="address">{core.addresses[0]}</span>{/if}
            </span>
            {#if state.label}<span class="status" class:ready={state.ready}>{state.label}</span>{/if}
            {#if owner && core.coreId !== group.self}
              <button type="button" class="ghost icon-only" data-testid="group-member-remove" aria-label={strings.group.remove} title={strings.group.remove} onclick={() => void remove(core)}><Trash2 size={15} /></button>
            {/if}
          </div>
          {#if state.hint}<p class="hint">{state.hint}</p>{/if}
          {#if core.coreId === group.self && loopback}<p class="hint">{strings.group.loopback}</p>{/if}
        </li>
      {/each}
    </ul>
    {/if}
    {#if group.devices.length > 0}
      <ul class="members devices" aria-label={strings.group.devicesList} data-testid="group-devices">
        {#each group.devices as device (device.id)}
          {@const Icon = deviceIcon(device)}
          {@const note = addedOn(device)}
          <li data-testid="group-device" data-device-id={device.id}>
            <div class="row">
              <span class="logo"><Icon size={17} /></span>
              <span class="identity">
                <span class="name">{deviceName(device)}{#if group.device === device.id}<span class="tag">{strings.group.thisDevice}</span>{/if}</span>
                {#if note}<span class="address">{note}</span>{/if}
              </span>
              {#if owner}
                <button type="button" class="ghost icon-only" data-testid="group-device-remove" aria-label={strings.group.revokeDevice} title={strings.group.revokeDevice} onclick={() => void revoke(device)}><Trash2 size={15} /></button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
    {#if owner}
      {@render invite()}
      {#if members.length > 1 || !alone}
        <footer>
          {#if members.length > 1}
            <div class="home" data-testid="group-home">
              <span class="ui-label-box"><span class="ui-label">{strings.machines.home}</span><InfoTip topic={strings.machines.home} text={strings.machines.homeHint} /></span>
              <Menu items={homeItems} label={strings.machines.home} placement="bottom" testid="group-home-pick" onpick={pickHome}>
                <span class="current ui-label" class:chosen={homeCore !== undefined}>{homeCore ? memberName(homeCore) : strings.machines.homeNone}</span><ChevronDown size={13} />
              </Menu>
            </div>
          {/if}
          {#if !alone}
            <button type="button" class="ghost leave" data-testid="group-leave" onclick={() => void leave()}>
              <LogOut size={14} /><span class="ui-label">{strings.group.leave}</span>
            </button>
          {/if}
        </footer>
        {#if members.length > 1 && (!homeReady || behind.length > 0)}
          <p class="hint" data-testid="group-home-older">{fill(strings.machines.homeOlder, { machines: (homeReady ? behind.map((machine) => listedName(machine)) : [store.core?.hostname ?? strings.machines.local]).join(', ') })}</p>
        {/if}
      {/if}
    {/if}
  </section>
{:else if owner}
  <section class="card group" class:mobile data-testid="group-card" id="settings-group">
    <header>
      <h2>{strings.group.heading}<InfoTip topic={strings.group.heading} text={strings.group.intro} /></h2>
      {@render addButton()}
    </header>
    {@render children?.()}
    {@render progress()}
    {@render invite()}
  </section>
{:else if children}
  <section class="card group" class:mobile data-testid="group-card" id="settings-group">
    <h2>{strings.group.heading}</h2>
    {@render children()}
  </section>
{/if}

<!-- The one way in: a device for this group, and for a machine alone, the link of another group to join. -->
{#snippet addButton()}
  <button type="button" class="primary small add" data-testid="group-add-device" disabled={busy !== null || older} onclick={() => void add()}>
    <Plus size={14} /><span class="ui-label">{busy === 'add' ? strings.group.adding : strings.group.addDevice}</span>
  </button>
{/snippet}

{#snippet invite()}
  {#if older}<p class="hint" data-testid="group-add-older">{fill(strings.group.addOlder, { machine: store.core?.hostname ?? strings.machines.local })}</p>{/if}
  <AddDevice {store} />
  {#if alone}
    <form class="join" onsubmit={(event) => { event.preventDefault(); void join(); }}>
      <span class="labelled"><label for="{uid}-join">{strings.group.joinLabel}</label><InfoTip topic={strings.group.join} text={strings.group.joinHint} /></span>
      <div class="field">
        <input id="{uid}-join" bind:value={invitation} data-testid="group-join-input" type="password" autocomplete="off" spellcheck="false" />
        <button type="submit" data-testid="group-join" disabled={busy !== null || !invitation.trim()}>
          {busy === 'join' ? strings.group.joining : strings.group.join}
        </button>
      </div>
    </form>
  {/if}
{/snippet}

{#snippet progress()}
  {#if migration?.busy}<p class="hint" role="status">{strings.group.merging}</p>{/if}
  {#if migration && migration.errors.length > 0}
    <div class="migration-errors" role="alert" data-testid="group-migration-errors">
      {#each migration.errors as error}<p>{error}</p>{/each}
      <button class="ghost small" disabled={migration.busy} onclick={() => migration.retry()}>{strings.common.refresh}</button>
    </div>
  {/if}
{/snippet}

<style>
  .group {
    padding: 16px 20px;
    margin-bottom: 20px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--color-border);
  }
  /* The settings pages give a card's title a bottom margin, which would lift the name off the button's line. */
  :global(.settings .page .card.group > header > h2) { margin: 0; }
  .group > header > h2,
  .group > h2 {
    font-size: var(--text-base);
    margin: 0;
    min-width: 0;
    display: flex; align-items: center; gap: 6px;
    color: var(--color-foreground);
  }
  .add { flex: none; }
  .group-name { font: inherit; font-weight: 600; color: inherit; height: auto; min-height: var(--control); padding: 0 6px; margin-left: -6px; min-width: 0; overflow-wrap: anywhere; text-align: left; }
  form.rename { margin: 0; flex: 1; min-width: 0; }
  .rename input { width: 100%; font-weight: 600; }
  .migration-errors { color: var(--color-danger); font-size: var(--text-sm); overflow-wrap: anywhere; }
  form {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 12px;
  }
  label,
  .labelled {
    font-size: var(--text-sm);
    color: var(--color-muted-foreground);
  }
  .labelled {
    display: flex;
    align-items: center;
  }
  .field {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .field input {
    flex: 1;
    min-width: 0;
  }
  /* As tall as the field it submits. */
  .field button {
    flex: none;
    height: var(--input);
  }

  /* Machines this window does not reach and devices: rows like the machines' own, on the same grid. */
  .members {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .members > li {
    padding: 10px 0;
    border-bottom: 1px solid var(--color-border);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 40px;
  }
  .logo {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: var(--radius-md);
    background: var(--color-surface-3);
    color: var(--color-muted-foreground);
    flex: none;
  }
  .identity {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .name {
    font-weight: 600;
  }
  .name,
  .address {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .address {
    font-size: var(--text-xs);
    color: var(--color-subtle);
  }
  .status {
    flex: none;
    font-size: var(--text-xs);
    color: var(--color-live);
  }
  .status.ready {
    color: var(--color-success);
  }
  .icon-only {
    width: var(--control);
    padding: 0;
    flex: none;
    color: var(--color-muted-foreground);
  }
  .icon-only:hover { color: var(--color-danger); }
  .hint {
    margin: 0;
    font-size: var(--text-sm);
    line-height: 1.5;
    color: var(--color-muted-foreground);
  }
  li > .hint {
    margin: 2px 0 0 48px;
  }
  .group > .hint { margin-top: 10px; }
  .tag,
  .badge {
    margin-left: 8px;
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    font-weight: 500;
  }
  .tag {
    background: var(--color-surface-3);
    color: var(--color-muted-foreground);
  }
  .badge {
    background: color-mix(in srgb, var(--color-accent) 16%, transparent);
    color: var(--color-accent);
  }
  .join { margin-top: 16px; }
  footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 16px;
    padding-top: 12px;
  }
  .home {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    font-size: var(--text-sm);
    color: var(--color-muted-foreground);
  }
  .home .ui-label-box { display: inline-flex; align-items: center; }
  .current {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 22ch;
  }
  .current.chosen { color: var(--color-accent); }
  .leave {
    margin-left: auto;
    color: var(--color-danger);
  }

  /* A phone, by the page it is on or by its width: rows wrap as the machine rows do, and a finger reaches every button. */
  .mobile .row { flex-wrap: wrap; }
  .mobile .identity { flex-basis: calc(100% - 48px); }
  .mobile .status { margin-left: 48px; flex: 1; }
  .mobile li > .hint { margin-left: 0; }
  .mobile .field { flex-wrap: wrap; }
  .mobile .field input { flex-basis: 100%; }
  .mobile button { min-height: var(--touch-target); }
  .mobile .icon-only { min-width: var(--touch-target); }
  .mobile .field button { flex: 1; }
  @media (max-width: 720px) {
    .group { padding: 14px 16px; }
    .row { flex-wrap: wrap; }
    .identity { flex-basis: calc(100% - 48px); }
    .status { margin-left: 48px; flex: 1; }
    li > .hint { margin-left: 0; }
    .field { flex-wrap: wrap; }
    .field input { flex-basis: 100%; }
    button { min-height: var(--touch-target); }
    .icon-only { min-width: var(--touch-target); }
    .field button { flex: 1; }
    footer { flex-direction: column; align-items: stretch; }
    .home { justify-content: space-between; }
    .leave { margin-left: 0; justify-content: center; }
  }
</style>
