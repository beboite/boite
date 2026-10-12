<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ConnectionGroup } from '../lib/connection-group.svelte';
  import type { GroupCore, GroupDevice } from '@boite/contracts';
  import { Globe, LogOut, Plus, Smartphone, Trash2 } from '@lucide/svelte';
  import AddDevice from './AddDevice.svelte';
  import { confirm } from '../lib/confirm.svelte';
  import { GroupLinks } from '../lib/group-links.svelte';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { workspace, type Machine } from '../lib/workspace.svelte';
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
  let busy = $state<'join' | 'add' | 'rename' | null>(null);
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

  let source = $derived(workspace.machines.find((machine) => machine.store === store) ?? null);
  /** The other members this window is connected to as their owner: the ones a copy of the settings can reach. */
  let others = $derived.by((): Machine[] => {
    if (!group || !source) return [];
    const self = group.self;
    const listed = new Set(group.cores.map((core) => core.coreId));
    return workspace.machines.filter((machine) => {
      const coreId = GroupLinks.coreOf(machine);
      return machine !== source && coreId !== undefined && coreId !== self && listed.has(coreId)
        && machine.store.connection === 'ready' && machine.store.owner;
    });
  });
  let targets = $derived(source ? others.filter((target) => sync.canEnable(source!, target) || sync.enabled(target)) : []);
  let synced = $derived(targets.length > 0 && targets.every((target) => sync.source(target) === source));

  function toggleSync(input: HTMLInputElement) {
    for (const target of targets) sync.set(target, input.checked ? source : null);
    // A link the sync refused leaves the box where the links are.
    input.checked = synced;
  }

  async function run(kind: 'join' | 'add' | 'rename', work: () => Promise<unknown>) {
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
    {@render children?.()}
    {#if children && loopback}<p class="hint">{strings.group.loopback}</p>{/if}
    {@render progress()}
    <ul class="members" aria-label={strings.group.members}>
      {#each members.filter(core => !children || !workspace.machines.some(machine => GroupLinks.coreOf(machine) === core.coreId)) as core (core.coreId)}
        {@const state = status(core)}
        <li data-testid="group-member" data-core-id={core.coreId}>
          <div class="row">
            <span class="logo"><MachineIcon os={core.os} size={18} /></span>
            <span class="identity">
              <span class="name">{core.name}</span>
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
      {#if source && others.length > 0}
        <label class="sync">
          <input type="checkbox" data-testid="group-sync" checked={synced} disabled={targets.length === 0}
            onchange={(event) => toggleSync(event.currentTarget)} />
          <span>{fill(strings.group.syncAll, { source: source.label })}</span>
          <InfoTip topic={strings.group.heading} text={strings.group.syncAllHint} />
        </label>
      {/if}
      {@render ways()}
      {#if !alone}
        <div class="buttons end">
          <button type="button" class="ghost leave" data-testid="group-leave" onclick={() => void leave()}>
            <LogOut size={14} />{strings.group.leave}
          </button>
        </div>
      {/if}
    {/if}
  </section>
{:else if owner}
  <section class="card group" class:mobile data-testid="group-card" id="settings-group">
    <h2>{strings.group.heading}<InfoTip topic={strings.group.heading} text={strings.group.intro} /></h2>
    {@render children?.()}
    {@render progress()}
    {@render ways()}
  </section>
{:else if children}
  <section class="card group" class:mobile data-testid="group-card" id="settings-group">
    <h2>{strings.group.heading}</h2>
    {@render children()}
  </section>
{/if}

<!-- The one way in: a device for this group, and for a machine alone, the link of another group to join. -->
{#snippet ways()}
  <div class="buttons">
    <button type="button" class="primary" data-testid="group-add-device" disabled={busy !== null} onclick={() => void add()}>
      <Plus size={14} />{busy === 'add' ? strings.group.adding : strings.group.addDevice}
    </button>
  </div>
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
    padding: var(--settings-padding, 18px);
    margin-bottom: 20px;
  }
  h2 {
    font-size: var(--text-base);
    margin: 0 0 12px;
    display: flex; align-items: center; gap: 6px;
  }
  .group-name { font: inherit; font-weight: 600; height: auto; min-height: var(--control); padding: 0 6px; margin-left: -6px; min-width: 0; overflow-wrap: anywhere; text-align: left; }
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
  .field button {
    flex: none;
  }

  .members {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: var(--control);
  }
  .logo {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
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
  .hint {
    margin: 0;
    font-size: var(--text-sm);
    line-height: 1.5;
    color: var(--color-muted-foreground);
  }
  li > .hint {
    margin: 2px 0 0 44px;
  }
  .devices {
    margin-top: 8px;
  }
  .tag {
    margin-left: 8px;
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    background: var(--color-surface-3);
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--color-muted-foreground);
  }
  .join { margin-top: 18px; }
  .end { justify-content: flex-end; margin-top: 8px; }
  .sync {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: var(--control);
    margin-top: 10px;
  }
  .sync input {
    flex: none;
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 14px;
  }
  .leave {
    color: var(--color-danger);
  }

  /* A phone, by the page it is on or by its width: rows wrap as the machine cards do, and a finger reaches every button. */
  .mobile .row { flex-wrap: wrap; }
  .mobile .identity { flex-basis: calc(100% - 44px); }
  .mobile .status { margin-left: 44px; flex: 1; }
  .mobile li > .hint { margin-left: 0; }
  .mobile .field { flex-wrap: wrap; }
  .mobile .field input { flex-basis: 100%; }
  .mobile button { min-height: var(--touch-target); }
  .mobile .icon-only { min-width: var(--touch-target); }
  .mobile .field button,
  .mobile .buttons button { flex: 1; }
  @media (max-width: 720px) {
    .row { flex-wrap: wrap; }
    .identity { flex-basis: calc(100% - 44px); }
    .status { margin-left: 44px; flex: 1; }
    li > .hint { margin-left: 0; }
    .field { flex-wrap: wrap; }
    .field input { flex-basis: 100%; }
    button { min-height: var(--touch-target); }
    .icon-only { min-width: var(--touch-target); }
    .field button,
    .buttons button { flex: 1; }
  }
</style>
