<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { GroupCore } from '@boite/contracts';
  import { Check, Copy, LogOut, Plus, Trash2 } from '@lucide/svelte';
  import { confirm } from '../lib/confirm.svelte';
  import { GroupLinks } from '../lib/group-links.svelte';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { workspace, type Machine } from '../lib/workspace.svelte';
  import InfoTip from './InfoTip.svelte';
  import MachineIcon from './MachineIcon.svelte';

  /**
   * The group of the machine this page shows: who is in it, how each member is
   * reached from this window, and the owner's ways in and out of it. A paired
   * phone reads the members and changes nothing.
   */
  let { store, mobile = false }: { store: Store; mobile?: boolean } = $props();
  const uid = $props.id();
  const sync = workspace.settingsSync;
  /** An address only the machine itself can dial. */
  const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/;

  let name = $state('');
  let invitation = $state('');
  let busy = $state<'create' | 'join' | 'invite' | null>(null);
  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(copiedTimer));

  let group = $derived(store.group);
  let members = $derived.by(() => {
    if (!group) return [];
    const self = group.self;
    return [...group.cores.filter((core) => core.coreId === self), ...group.cores.filter((core) => core.coreId !== self)];
  });
  /** A member's status in its row, or the sentence under it when it cannot be reached. */
  function status(core: GroupCore): { label: string | null; hint: string | null; ready: boolean } {
    if (core.coreId === group?.self) return { label: strings.group.self, hint: null, ready: true };
    const machine = workspace.machines.find((candidate) => GroupLinks.coreOf(candidate) === core.coreId);
    if (machine?.store.connection === 'ready') return { label: strings.group.connected, hint: null, ready: true };
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

  async function run(kind: 'create' | 'join' | 'invite', work: () => Promise<unknown>) {
    if (busy) return;
    busy = kind;
    try {
      await work();
    } finally {
      busy = null;
    }
  }
  const create = () => run('create', async () => { if (await store.createGroup(name.trim())) name = ''; });
  const join = () => run('join', async () => { if (await store.joinGroup(invitation.trim())) invitation = ''; });
  const invite = () => run('invite', () => store.inviteToGroup());

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(store.groupInvite?.invite ?? '');
    } catch {
      // No clipboard here: the field is selectable and says nothing was copied.
      return;
    }
    copied = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copied = false; }, 1500);
  }

  async function remove(core: GroupCore) {
    const ok = await confirm.ask({
      title: fill(strings.group.removeTitle, { machine: core.name }),
      body: strings.group.removeBody,
      confirmLabel: strings.group.remove,
      cancelLabel: strings.common.cancel,
      danger: true
    });
    if (ok) await store.removeFromGroup(core.coreId);
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
    <h2>{group.name}<InfoTip topic={strings.group.heading} text={strings.group.intro} /></h2>
    <ul class="members" aria-label={strings.group.members}>
      {#each members as core (core.coreId)}
        {@const state = status(core)}
        <li data-testid="group-member" data-core-id={core.coreId}>
          <div class="row">
            <span class="logo"><MachineIcon os={core.os} size={18} /></span>
            <span class="identity">
              <span class="name">{core.name}</span>
              {#if core.addresses[0]}<span class="address">{core.addresses[0]}</span>{/if}
            </span>
            {#if state.label}<span class="status" class:ready={state.ready}>{state.label}</span>{/if}
            {#if store.owner && core.coreId !== group.self}
              <button type="button" class="ghost icon-only" data-testid="group-member-remove" aria-label={strings.group.remove} title={strings.group.remove} onclick={() => void remove(core)}><Trash2 size={15} /></button>
            {/if}
          </div>
          {#if state.hint}<p class="hint">{state.hint}</p>{/if}
          {#if core.coreId === group.self && loopback}<p class="hint">{strings.group.loopback}</p>{/if}
        </li>
      {/each}
    </ul>
    {#if store.owner}
      {#if group.devices.length > 0}
        <p class="hint devices">{group.devices.length === 1 ? strings.group.device : fill(strings.group.devices, { count: String(group.devices.length) })}</p>
      {/if}
      {#if source && others.length > 0}
        <label class="sync">
          <input type="checkbox" data-testid="group-sync" checked={synced} disabled={targets.length === 0}
            onchange={(event) => toggleSync(event.currentTarget)} />
          <span>{fill(strings.group.syncAll, { source: source.label })}</span>
          <InfoTip topic={strings.group.heading} text={strings.group.syncAllHint} />
        </label>
      {/if}
      {#if store.groupInvite}
        <div class="invitation">
          <label for="{uid}-invite">{strings.group.inviteLabel}</label>
          <div class="field">
            <input id="{uid}-invite" class="mono" data-testid="group-invite-code" readonly spellcheck="false" autocomplete="off"
              value={store.groupInvite.invite} onfocus={(event) => event.currentTarget.select()} />
            <button type="button" data-testid="group-invite-copy" onclick={() => void copyInvite()}>
              {#if copied}<Check size={14} />{strings.group.copied}{:else}<Copy size={14} />{strings.group.copy}{/if}
            </button>
          </div>
          <p class="hint">{strings.group.inviteHint}</p>
        </div>
      {/if}
      <div class="buttons">
        <button type="button" class="primary" data-testid="group-invite" disabled={busy !== null} onclick={() => void invite()}>
          <Plus size={14} />{busy === 'invite' ? strings.group.inviting : strings.group.invite}
        </button>
        <button type="button" class="ghost leave" data-testid="group-leave" onclick={() => void leave()}>
          <LogOut size={14} />{strings.group.leave}
        </button>
      </div>
    {/if}
  </section>
{:else if store.owner}
  <section class="card group" class:mobile data-testid="group-card" id="settings-group">
    <h2>{strings.group.heading}<InfoTip topic={strings.group.heading} text={strings.group.intro} /></h2>
    <form onsubmit={(event) => { event.preventDefault(); void create(); }}>
      <label for="{uid}-name">{strings.group.name}</label>
      <div class="field">
        <input id="{uid}-name" bind:value={name} data-testid="group-name" maxlength="80" autocomplete="off" placeholder={strings.group.namePlaceholder} />
        <button type="submit" class="primary" data-testid="group-create" disabled={busy !== null || !name.trim()}>
          {busy === 'create' ? strings.group.creating : strings.group.create}
        </button>
      </div>
    </form>
    <form onsubmit={(event) => { event.preventDefault(); void join(); }}>
      <span class="labelled"><label for="{uid}-join">{strings.group.joinLabel}</label><InfoTip topic={strings.group.join} text={strings.group.joinHint} /></span>
      <div class="field">
        <input id="{uid}-join" bind:value={invitation} data-testid="group-join-input" type="password" autocomplete="off" spellcheck="false" />
        <button type="submit" data-testid="group-join" disabled={busy !== null || !invitation.trim()}>
          {busy === 'join' ? strings.group.joining : strings.group.join}
        </button>
      </div>
    </form>
  </section>
{/if}

<style>
  .group {
    padding: var(--settings-padding, 18px);
    margin-bottom: 20px;
  }
  h2 {
    font-size: var(--text-base);
    margin: 0 0 12px;
  }
  form,
  .invitation {
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
    margin-top: 12px;
  }
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
