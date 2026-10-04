import type { Group } from '@boite/contracts';
import type { Client } from './client';
import { fill, strings } from './strings';
import type { Machine, Workspace } from './workspace.svelte';

function groupOf(machine: Machine): Group | null { return machine.store.group; }

const MIGRATED_KEY = 'boite.group-migration.v1';

/** Converts remembered owner connections when Machines is opened. Device roles are never promoted. */
export class ConnectionGroup {
  source = $state<Machine | null>(null);
  busy = $state(false);
  errors = $state<string[]>([]);
  #attempted = new WeakSet<Client>();
  #stopped = false;
  #pending = false;
  #completed = new Set<string>();

  constructor(private readonly workspace: Workspace) {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(MIGRATED_KEY) ?? '[]');
      if (Array.isArray(saved)) for (const id of saved) if (typeof id === 'string') this.#completed.add(id);
    } catch { /* session only */ }
  }

  #remember(machine: Machine): void {
    this.#completed.add(machine.id);
    try { localStorage.setItem(MIGRATED_KEY, JSON.stringify([...this.#completed])); } catch { /* session only */ }
  }

  stop(): void { this.#stopped = true; }

  retry(): void {
    this.#attempted = new WeakSet();
    this.errors = [];
    void this.merge();
  }

  async merge(): Promise<void> {
    if (this.#stopped) return;
    if (this.busy) { this.#pending = true; return; }
    const all = this.workspace.machines.filter(machine => machine.store.owner);
    const owners = all.filter(machine => machine.store.connection === 'ready' && machine.store.groupKnown);
    const source = this.source && all.includes(this.source) && this.source.store.group !== null ? this.source
      : all.find(machine => machine.store.group !== null) ?? owners.find(machine => machine.store === this.workspace.active) ?? owners[0];
    if (!source) return;
    this.source = source;
    if (!owners.includes(source) || owners.length < 2) return;
    // An unanswered/offline owner may already hold the group to reuse.
    if (source.store.group === null && all.some(machine => !owners.includes(machine))) return;
    const client = source.store.client;
    if (!client) return;
    // Do not recreate a group after Leave, or re-admit a member after Remove.
    if (source.store.group === null && (this.#attempted.has(client) || this.#completed.has(source.id))) return;
    const current = (machine: Machine, connection: Client) => !this.#stopped && this.workspace.machines.includes(machine)
      && machine.store.client === connection && machine.store.connection === 'ready' && machine.store.owner;
    this.busy = true;
    try {
      if (source.store.group === null) {
        this.#attempted.add(client);
        await client.call('group.create', { name: strings.group.namePlaceholder });
        if (!current(source, client)) return;
        await source.store.loadGroup();
      }
      const groupId = source.store.group?.id;
      if (!groupId) return;
      this.#remember(source);
      for (const target of owners) {
        const remote = target.store.client;
        if (target === source || !remote || !current(source, client) || !current(target, remote)) continue;
        if (target.store.group?.id === groupId) {
          // Admission may have completed before this page recorded it.
          const group = groupOf(target);
          const member = group?.cores.find(core => core.coreId === group.self);
          if (member) {
            if (target.coreId !== member.coreId || target.groupId !== groupId || target.epoch !== member.epoch) {
              this.workspace.markGrouped(target, groupId, member);
            }
            this.#remember(target);
          }
          continue;
        }
        if (target.store.group !== null) {
          const error = fill(strings.group.otherGroup, { machine: target.label, group: target.store.group.name });
          if (!this.errors.includes(error)) this.errors = [...this.errors, error];
          continue;
        }
        if (this.#attempted.has(remote) || this.#completed.has(target.id)) continue;
        this.#attempted.add(remote);
        try {
          const { invite } = await client.call('group.invite', {});
          if (!current(source, client) || !current(target, remote) || source.store.group?.id !== groupId) return;
          const joined = await remote.call('group.join', { invite });
          if (!current(source, client) || !current(target, remote)) return;
          await Promise.all([source.store.loadGroup(), target.store.loadGroup()]);
          const group = groupOf(target);
          const member = group?.cores.find(core => core.coreId === group.self);
          if (group?.id === groupId && joined.id === groupId && member && source.store.group?.id === groupId && current(source, client) && current(target, remote)) {
            this.workspace.markGrouped(target, groupId, member);
            this.#remember(target);
            this.errors = this.errors.filter(error => !error.startsWith(`${target.label}:`));
          }
        } catch (error) {
          // A lost join reply may already have admitted the target. Ask before allowing another attempt.
          try {
            const group = await remote.call('group.get', {});
            if (!current(source, client) || !current(target, remote) || source.store.group?.id !== groupId) return;
            target.store.group = group;
            target.store.groupKnown = true;
            if (group === null) this.#attempted.delete(remote);
            const member = group?.cores.find(core => core.coreId === group.self);
            if (group?.id === groupId && member) {
              this.workspace.markGrouped(target, groupId, member);
              this.#remember(target);
              this.errors = this.errors.filter(error => !error.startsWith(`${target.label}:`));
              continue;
            }
          } catch { /* Unknown outcome: keep duplicate-join protection until an explicit retry. */ }
          this.errors = [...this.errors, `${target.label}: ${error instanceof Error ? error.message : String(error)}`];
        }
      }
    } catch (error) {
      this.errors = [...this.errors, `${source.label}: ${error instanceof Error ? error.message : String(error)}`];
    } finally {
      this.busy = false;
      if (this.#pending) { this.#pending = false; void this.merge(); }
    }
  }
}
