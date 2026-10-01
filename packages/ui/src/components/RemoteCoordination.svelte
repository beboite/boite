<script lang="ts">
  import InfoTip from './InfoTip.svelte';
  import { Link2, RefreshCw, Unlink } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import type { CoordinationPeer } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import { workspace, type Machine } from '../lib/workspace.svelte';
  import { agentAutoLink, forgetUnlinked, linkMachines, rememberUnlinked } from '../lib/agent-links.svelte';
  import { loadMachineLinks, type LinkHealth } from '../lib/agent-link-health';

  let identities = $state<Record<string, CoordinationPeer>>({});
  let peers = $state<Record<string, CoordinationPeer[]>>({});
  let health = $state<Record<string, Record<string, LinkHealth>>>({});
  let error = $state<string | null>(null);
  let busy = $state('');
  let refreshVersion = 0;
  let machines = $derived(workspace.machines.filter(machine => machine.store.owner && machine.store.connection === 'ready'));
  let machineKey = $derived(machines.map(machine => machine.id).join('\0'));
  function peerLabel(peer: CoordinationPeer): string {
    return machines.find(machine => identities[machine.id]?.coreId === peer.coreId)?.label ?? peer.name;
  }
  let pairs = $derived.by(() => {
    const result: { a: Machine; b: Machine; linkedA: boolean; linkedB: boolean; reachable: boolean; failure: string | undefined }[] = [];
    for (let a = 0; a < machines.length; a += 1) for (let b = a + 1; b < machines.length; b += 1) {
      const left = machines[a]!;
      const right = machines[b]!;
      const leftId = identities[left.id]?.coreId;
      const rightId = identities[right.id]?.coreId;
      result.push({
        a: left,
        b: right,
        reachable: Boolean(rightId && leftId && health[left.id]?.[rightId]?.ok && health[right.id]?.[leftId]?.ok),
        failure: (rightId && health[left.id]?.[rightId]?.error) || (leftId && health[right.id]?.[leftId]?.error) || undefined,
        linkedA: Boolean(rightId && peers[left.id]?.some(peer => peer.coreId === rightId)),
        linkedB: Boolean(leftId && peers[right.id]?.some(peer => peer.coreId === leftId))
      });
    }
    return result;
  });

  $effect(() => {
    const key = machineKey;
    // An automatic link made while this screen is open shows at once.
    void agentAutoLink.version;
    untrack(() => {
      if (key) void refresh();
      else {
        refreshVersion += 1;
        identities = {};
        peers = {};
        health = {};
        error = null;
      }
    });
  });

  async function refresh(): Promise<void> {
    const version = ++refreshVersion;
    const current = machines;
    error = null;
    try {
      const rows = await Promise.all(current.map(loadMachineLinks));
      if (version !== refreshVersion) return;
      identities = Object.fromEntries(rows.map(row => [row.id, row.identity]));
      peers = Object.fromEntries(rows.map(row => [row.id, row.peers]));
      health = Object.fromEntries(rows.map(row => [row.id, row.health]));
    } catch (cause) {
      if (version !== refreshVersion) return;
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function link(a: Machine, b: Machine): Promise<void> {
    busy = `${a.id}\0${b.id}`;
    error = null;
    try {
      const [left, right] = [identities[a.id], identities[b.id]];
      if (left && right) forgetUnlinked(left.coreId, right.coreId);
      await linkMachines(a, b);
      await refresh();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = '';
    }
  }

  async function unlink(machine: Machine, peer: CoordinationPeer): Promise<void> {
    busy = `${machine.id}\0${peer.coreId}`;
    error = null;
    try {
      const own = identities[machine.id];
      // Removed by hand: the automatic link does not put it back.
      if (own) rememberUnlinked(own.coreId, peer.coreId);
      await machine.store.untrustCoordinationPeer(peer.coreId);
      await refresh();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = '';
    }
  }
  async function readAccess(machine: Machine, peer: CoordinationPeer, input: HTMLInputElement): Promise<void> {
    const enabled = input.checked;
    busy = `${machine.id}\0${peer.coreId}`;
    error = null;
    try {
      await machine.store.trustCoordinationPeer({ ...peer, readThreads: enabled });
      await refresh();
    } catch (cause) {
      input.checked = peer.readThreads === true;
      error = cause instanceof Error ? cause.message : String(cause);
    } finally { busy = ''; }
  }
</script>

<section class="card remote" id="settings-agent-links" data-testid="agent-links">
  <header>
    <div><h2>{strings.machines.agentLinks}<InfoTip topic={strings.machines.agentLinks} text={`${strings.machines.agentLinksHint} ${strings.machines.publicIdentityHint}`} /></h2></div>
    <button class="ghost icon-only" aria-label={strings.machines.agentLinksRefresh} title={strings.machines.agentLinksRefresh} disabled={Boolean(busy)} onclick={() => void refresh()}><RefreshCw size={15} /></button>
  </header>


  <h3>{strings.machines.availableAgentLinks}</h3>
  {#if pairs.length === 0}
    <p class="hint">{strings.machines.noAgentLinks}</p>
  {:else}
    <div class="rows">
      {#each pairs as pair (`${pair.a.id}:${pair.b.id}`)}
        <div class="row" data-testid="agent-link-pair">
          <span><strong>{pair.a.label} ↔ {pair.b.label}</strong><small>{pair.linkedA && pair.linkedB ? strings.machines.reciprocalLink : pair.linkedA || pair.linkedB ? strings.machines.oneSidedLink : strings.machines.linkAgents}</small>
            {#if pair.reachable}<small>{strings.machines.agentLinkReachable}</small>
            {:else if pair.failure || agentAutoLink.failureOf(pair.a, pair.b)}<small class="link-failure">{fill(strings.machines.autoLinkFailed, { reason: pair.failure ?? agentAutoLink.failureOf(pair.a, pair.b)! })}</small>{/if}
          </span>
          <button class="quiet small" disabled={Boolean(busy) || pair.linkedA && pair.linkedB && pair.reachable} data-testid="agent-link" onclick={() => void link(pair.a, pair.b)}><Link2 size={13} />{strings.machines.linkAgents}</button>
        </div>
      {/each}
    </div>
  {/if}

  {#if machines.some(machine => (peers[machine.id] ?? []).length > 0)}<h3>{strings.machines.linkedAgents}</h3>{/if}
  <div class="rows">
    {#each machines as machine (machine.id)}
      {#each peers[machine.id] ?? [] as peer (peer.coreId)}
        <div class="row peer" data-testid="agent-peer">
          <div class="peer-main">
            <span><strong>{machine.label} → {peerLabel(peer)}</strong><small>{peer.viaClient ? strings.machines.agentLinkViaApp : peer.url}</small>
              {#if health[machine.id]?.[peer.coreId]?.ok}<small>{strings.machines.agentLinkReachable}</small>
              {:else if health[machine.id]?.[peer.coreId]?.error}<small class="link-failure">{health[machine.id]![peer.coreId]!.error}</small>{/if}
            </span>
            <button class="ghost icon-only" aria-label={strings.machines.unlinkAgent} title={strings.machines.unlinkAgent} disabled={Boolean(busy)} onclick={() => void unlink(machine, peer)}><Unlink size={14} /></button>
          </div>
          <label class="read-access">
            <input type="checkbox" data-testid="agent-peer-read" checked={peer.readThreads === true} disabled={Boolean(busy) || peer.readThreads === undefined} onchange={event => void readAccess(machine, peer, event.currentTarget)} />
            <span>{fill(strings.machines.agentReadThreads, { source: peerLabel(peer), target: machine.label })}</span>
          </label>
          {#if peer.readThreads === undefined}<small class="hint">{strings.machines.agentReadUpgrade}</small>{/if}
        </div>
      {/each}
    {/each}
  </div>

  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
  .remote { padding: 20px; display: flex; flex-direction: column; gap: 12px; }
  header { display: flex; align-items: flex-start; gap: 12px; }
  header > div { flex: 1; min-width: 0; }
  h2, h3 { margin: 0; }
  h2 { font-size: var(--text-base); }
  h3 { margin-top: 4px; color: var(--color-muted-foreground); font-size: var(--text-xs); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
  .hint { margin-top: 4px; color: var(--color-muted-foreground); font-size: var(--text-sm); line-height: 1.5; }
  .rows { min-width: 0; border: 1px solid var(--color-border); border-radius: var(--radius-md); overflow: hidden; }
  .rows:empty { display: none; }
  .row { min-height: var(--control-lg); display: flex; align-items: center; gap: 12px; padding: 8px 10px; }
  .row + .row { border-top: 1px solid var(--color-border); }
  .row > span { flex: 1; min-width: 0; }
  .row.peer { align-items: stretch; flex-direction: column; gap: 8px; }
  .peer-main { min-width: 0; display: flex; align-items: center; gap: 12px; }
  .peer-main > span { flex: 1; min-width: 0; }
  .read-access { min-width: 0; width: 100%; display: flex; align-items: flex-start; gap: 8px; font-size: var(--text-sm); line-height: 1.5; cursor: pointer; overflow-wrap: anywhere; }
  .read-access input { flex: none; margin-top: 4px; accent-color: var(--color-accent); }
  .read-access span { min-width: 0; flex: 1; white-space: normal; }
  .row strong, .row small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row strong { font-size: var(--text-sm); font-weight: 500; }
  .row small { margin-top: 2px; color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .row small.link-failure { white-space: normal; overflow-wrap: anywhere; }
  .icon-only { width: var(--control); padding: 0; flex: none; }
  .error { color: var(--color-danger); font-size: var(--text-sm); overflow-wrap: anywhere; }
  @media (max-width: 720px) { .row { align-items: flex-start; flex-direction: column; } .row button { align-self: stretch; } }
</style>
