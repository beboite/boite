<script lang="ts">
  import { Link2, RefreshCw, Unlink } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import type { CoordinationPeer } from '@boite/contracts';
  import { strings } from '../lib/strings';
  import { workspace, type Machine } from '../lib/workspace.svelte';

  let identities = $state<Record<string, CoordinationPeer>>({});
  let peers = $state<Record<string, CoordinationPeer[]>>({});
  let error = $state<string | null>(null);
  let busy = $state('');
  let refreshVersion = 0;
  let machines = $derived(workspace.machines.filter(machine => machine.store.owner && machine.store.connection === 'ready'));
  let machineKey = $derived(machines.map(machine => machine.id).join('\0'));
  let pairs = $derived.by(() => {
    const result: { a: Machine; b: Machine; linkedA: boolean; linkedB: boolean }[] = [];
    for (let a = 0; a < machines.length; a += 1) for (let b = a + 1; b < machines.length; b += 1) {
      const left = machines[a]!;
      const right = machines[b]!;
      const leftId = identities[left.id]?.coreId;
      const rightId = identities[right.id]?.coreId;
      result.push({
        a: left,
        b: right,
        linkedA: Boolean(rightId && peers[left.id]?.some(peer => peer.coreId === rightId)),
        linkedB: Boolean(leftId && peers[right.id]?.some(peer => peer.coreId === leftId))
      });
    }
    return result;
  });

  $effect(() => {
    const key = machineKey;
    untrack(() => {
      if (key) void refresh();
      else {
        refreshVersion += 1;
        identities = {};
        peers = {};
        error = null;
      }
    });
  });

  async function refresh(): Promise<void> {
    const version = ++refreshVersion;
    const current = machines;
    error = null;
    try {
      const rows = await Promise.all(current.map(async machine => ({
        id: machine.id,
        identity: await machine.store.coordinationIdentity(),
        peers: await machine.store.coordinationPeers()
      })));
      if (version !== refreshVersion) return;
      identities = Object.fromEntries(rows.map(row => [row.id, row.identity]));
      peers = Object.fromEntries(rows.map(row => [row.id, row.peers]));
    } catch (cause) {
      if (version !== refreshVersion) return;
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function link(a: Machine, b: Machine): Promise<void> {
    busy = `${a.id}\0${b.id}`;
    error = null;
    let trustedA = false;
    let trustedB = false;
    let bIdentity: CoordinationPeer | null = null;
    let aIdentity: CoordinationPeer | null = null;
    let previousA: CoordinationPeer | undefined;
    let previousB: CoordinationPeer | undefined;
    try {
      const [resolvedA, resolvedB] = await Promise.all([a.store.coordinationIdentity(), b.store.coordinationIdentity()]);
      aIdentity = resolvedA;
      bIdentity = resolvedB;
      previousA = (await a.store.coordinationPeers()).find(p => p.coreId === resolvedB.coreId);
      previousB = (await b.store.coordinationPeers()).find(p => p.coreId === resolvedA.coreId);
      await a.store.trustCoordinationPeer(bIdentity);
      trustedA = true;
      await b.store.trustCoordinationPeer(aIdentity);
      trustedB = true;
      await Promise.all([a.store.checkCoordinationPeer(bIdentity.coreId), b.store.checkCoordinationPeer(aIdentity.coreId)]);
      await refresh();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      try {
        if (trustedA && bIdentity) { if (previousA) await a.store.trustCoordinationPeer(previousA); else await a.store.untrustCoordinationPeer(bIdentity.coreId); }
        if (trustedB && aIdentity) { if (previousB) await b.store.trustCoordinationPeer(previousB); else await b.store.untrustCoordinationPeer(aIdentity.coreId); }
      } catch (rollback) { error += ` ${rollback instanceof Error ? rollback.message : String(rollback)}`; }
    } finally {
      busy = '';
    }
  }

  async function unlink(machine: Machine, peer: CoordinationPeer): Promise<void> {
    busy = `${machine.id}\0${peer.coreId}`;
    error = null;
    try {
      await machine.store.untrustCoordinationPeer(peer.coreId);
      await refresh();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = '';
    }
  }
</script>

<section class="card remote" data-testid="agent-links">
  <header>
    <div><h2>{strings.machines.agentLinks}</h2><p class="hint">{strings.machines.agentLinksHint}</p></div>
    <button class="ghost icon-only" aria-label={strings.machines.agentLinksRefresh} title={strings.machines.agentLinksRefresh} disabled={Boolean(busy)} onclick={() => void refresh()}><RefreshCw size={15} /></button>
  </header>

  <p class="secure">{strings.machines.publicIdentityHint}</p>

  <h3>{strings.machines.availableAgentLinks}</h3>
  {#if pairs.length === 0}
    <p class="hint">{strings.machines.noAgentLinks}</p>
  {:else}
    <div class="rows">
      {#each pairs as pair (`${pair.a.id}:${pair.b.id}`)}
        <div class="row" data-testid="agent-link-pair">
          <span><strong>{pair.a.label} ↔ {pair.b.label}</strong><small>{pair.linkedA && pair.linkedB ? strings.machines.reciprocalLink : pair.linkedA || pair.linkedB ? strings.machines.oneSidedLink : strings.machines.linkAgents}</small></span>
          <button class="quiet small" disabled={Boolean(busy) || pair.linkedA && pair.linkedB} data-testid="agent-link" onclick={() => void link(pair.a, pair.b)}><Link2 size={13} />{strings.machines.linkAgents}</button>
        </div>
      {/each}
    </div>
  {/if}

  <h3>{strings.machines.linkedAgents}</h3>
  <div class="rows">
    {#each machines as machine (machine.id)}
      {#each peers[machine.id] ?? [] as peer (peer.coreId)}
        <div class="row" data-testid="agent-peer">
          <span><strong>{machine.label} → {peer.name}</strong><small>{peer.url}</small></span>
          <button class="ghost icon-only" aria-label={strings.machines.unlinkAgent} title={strings.machines.unlinkAgent} disabled={Boolean(busy)} onclick={() => void unlink(machine, peer)}><Unlink size={14} /></button>
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
  .hint, .secure { margin-top: 4px; color: var(--color-muted-foreground); font-size: var(--text-sm); line-height: 1.5; }
  .secure { padding: 8px 10px; border-left: 2px solid var(--color-edge); background: var(--color-surface-2); }
  .rows { border: 1px solid var(--color-border); border-radius: var(--radius-md); overflow: hidden; }
  .rows:empty { display: none; }
  .row { min-height: var(--control-lg); display: flex; align-items: center; gap: 12px; padding: 8px 10px; }
  .row + .row { border-top: 1px solid var(--color-border); }
  .row > span { flex: 1; min-width: 0; }
  .row strong, .row small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row strong { font-size: var(--text-sm); font-weight: 500; }
  .row small { margin-top: 2px; color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .icon-only { width: var(--control); padding: 0; flex: none; }
  .error { color: var(--color-danger); font-size: var(--text-sm); overflow-wrap: anywhere; }
  @media (max-width: 720px) { .row { align-items: flex-start; flex-direction: column; } .row button { align-self: stretch; } }
</style>
