<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import type { GatewayMoveItem, GatewayMoveOutcome, GatewayMovePlan, GatewayMoveTarget } from '@boite/contracts';
  import { Closing } from '../lib/closing.svelte';
  import { errorText } from '../lib/errors';
  import { mobileOverlay } from '../lib/mobile-history';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';

  /**
   * Moves this machine's sign-ins and OpenCode keys into the configured Douane.
   * The core reads every file and talks to the gateway; this dialog only sees
   * what could move and what happened to each line.
   */
  /** `plugin` moves into the Douane plugin this machine runs, whatever the proxy points at. */
  let { store, open, onclose, target }: { store: Store; open: boolean; onclose: () => void; target?: GatewayMoveTarget } = $props();
  const targeted = $derived(target === undefined ? {} : { target });
  const text = strings.subscriptionProxy.move;
  const FOCUSABLE = 'button:not(:disabled), input:not(:disabled)';

  const overlay = new Closing();
  let card = $state<HTMLDivElement | undefined>(undefined);
  let plan = $state<GatewayMovePlan | null>(null);
  let loading = $state(false);
  let running = $state(false);
  let error = $state('');
  let token = $state('');
  let clearToken = $state(false);
  const chosen = new SvelteSet<string>();
  const outcomes = new SvelteMap<string, GatewayMoveOutcome>();

  $effect(() => {
    if (!open) { overlay.hide(); return; }
    overlay.show();
    untrack(() => void load());
  });
  $effect(() => { if (overlay.open) return mobileOverlay(close); });

  async function load() {
    const client = store.client;
    if (!client) return;
    loading = true; error = ''; plan = null; token = ''; clearToken = false;
    chosen.clear(); outcomes.clear();
    try {
      plan = await client.call('subscriptionProxy.movePlan', { ...targeted });
      for (const item of plan.items) if (item.movable) chosen.add(item.id);
    } catch (failure) { error = fill(text.failed, { error: errorText(failure) }); }
    finally { loading = false; }
    await tick();
    card?.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true });
  }

  function close() { if (!running) onclose(); }

  /** Items already moved or already there stay ticked off: moving them twice gives nothing. */
  const settled = (id: string) => { const outcome = outcomes.get(id)?.outcome; return outcome === 'moved' || outcome === 'present'; };
  const pending = $derived([...chosen].filter((id) => !settled(id)));

  async function move() {
    const client = store.client;
    if (!client || running || pending.length === 0) return;
    running = true; error = '';
    try {
      const answer = await client.call('subscriptionProxy.move', {
        ids: pending, ...targeted, ...(token || clearToken ? { managementToken: clearToken ? null : token } : {}),
      });
      for (const outcome of answer.outcomes) outcomes.set(outcome.id, outcome);
      if (plan && (token || clearToken)) plan = { ...plan, managementToken: !clearToken };
      token = ''; clearToken = false;
    } catch (failure) { error = fill(text.failed, { error: errorText(failure) }); }
    finally { running = false; }
  }

  function title(item: GatewayMoveItem): string {
    if (item.kind === 'copilot') return text.copilot;
    if (item.kind === 'opencodeGo') return text.opencodeGo;
    if (item.kind === 'endpoint') return fill(text.endpoint, { source: item.source?.name ?? item.id });
    return fill(text.login, { provider: store.providers.find((provider) => provider.id === item.providerId)?.name ?? item.providerId });
  }

  function detail(item: GatewayMoveItem): string {
    const account = store.accounts.find((entry) => entry.id === item.accountId)?.label ?? '';
    return [account, item.route ? fill(text.route, { route: item.route }) : ''].filter(Boolean).join(' · ');
  }

  function status(item: GatewayMoveItem): { text: string; tone: 'ok' | 'bad' | 'muted' } | null {
    const outcome = outcomes.get(item.id);
    if (outcome) {
      const said = outcome.message ?? (outcome.reason ? text.reasons[outcome.reason] : null);
      const label = text.outcomes[outcome.outcome];
      return { text: said ? `${label}: ${said}` : label, tone: outcome.outcome === 'refused' || outcome.outcome === 'missing' ? 'bad' : 'ok' };
    }
    if (!item.movable && item.reason) return { text: text.reasons[item.reason], tone: 'muted' };
    return null;
  }

  function toggle(id: string, on: boolean) { if (on) chosen.add(id); else chosen.delete(id); }

  function onkeydown(event: KeyboardEvent) {
    if (!overlay.open) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== 'Tab' || !card) return;
    const stops = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = stops[0], last = stops[stops.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    const inside = active instanceof Node && card.contains(active);
    if (event.shiftKey ? inside && active !== first : inside && active !== last) return;
    event.preventDefault();
    (event.shiftKey ? last : first).focus({ preventScroll: true });
  }
</script>

<svelte:window onkeydowncapture={onkeydown} />

{#if overlay.shown}
  <div class="scrim" class:closing={overlay.closing} role="presentation" use:overlay.attach onanimationend={overlay.end}
    onclick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div class="dialog" class:closing={overlay.closing} role="dialog" aria-modal="true" aria-labelledby="gateway-move-title" aria-describedby="gateway-move-intro" tabindex="-1" bind:this={card} data-testid="gateway-move-dialog">
      <div class="head">
        <h2 id="gateway-move-title">{text.title}</h2>
        {#if plan?.origin}<p class="origin ui-label">{plan.origin}</p>{/if}
        <p id="gateway-move-intro" class="muted">{text.intro}</p>
      </div>
      <div class="list" aria-busy={loading}>
        {#if loading}
          <p class="muted empty" data-testid="gateway-move-loading">{text.loading}</p>
        {:else if plan && plan.items.length === 0}
          <p class="muted empty" data-testid="gateway-move-empty">{text.empty}</p>
        {:else if plan}
          {#each plan.items as item (item.id)}
            {@const said = status(item)}
            <label class="row" class:off={!item.movable} data-testid="gateway-move-row" data-id={item.id}>
              <input type="checkbox" checked={item.movable && chosen.has(item.id)} disabled={!item.movable || running || settled(item.id)}
                onchange={(event) => toggle(item.id, event.currentTarget.checked)} />
              <span class="what">
                <span class="title ui-label">{title(item)}</span>
                {#if detail(item)}<span class="detail ui-label">{detail(item)}</span>{/if}
              </span>
              {#if said}<span class="status ui-label {said.tone}" data-testid="gateway-move-status">{said.text}</span>{/if}
            </label>
          {/each}
        {/if}
      </div>
      {#if plan && plan.items.some((item) => item.movable)}
        <div class="token">
          <label><span class="ui-label">{text.token}</span>
            <input type="password" bind:value={token} autocomplete="off" disabled={clearToken || running} data-testid="gateway-move-token" />
          </label>
          <p class="muted hint">{plan.managementToken ? text.tokenSaved : text.tokenHint}</p>
          {#if plan.managementToken}<label class="clear"><input type="checkbox" bind:checked={clearToken} disabled={running} /><span class="ui-label">{text.clearToken}</span></label>{/if}
        </div>
      {/if}
      {#if error}<p class="error" role="alert" data-testid="gateway-move-error">{error}</p>{/if}
      <div class="actions">
        <button type="button" class="ghost" disabled={running} onclick={close} data-testid="gateway-move-close"><span class="ui-label">{outcomes.size ? strings.common.close : strings.common.cancel}</span></button>
        <button type="button" class="primary" disabled={running || loading || pending.length === 0} aria-busy={running} onclick={() => void move()} data-testid="gateway-move-confirm">
          <span class="ui-label">{running ? text.moving : fill(text.confirm, { count: String(pending.length) })}</span>
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed; inset: 0; z-index: 60;
    display: flex; align-items: flex-start; justify-content: center;
    padding-top: min(10vh, 96px);
    background: var(--color-scrim);
    animation: fade var(--dur-2) var(--ease-out-quint);
  }
  .scrim.closing { animation-name: fade-out; pointer-events: none; }
  .dialog {
    width: min(580px, calc(100vw - 32px));
    max-height: min(80vh, 680px);
    display: flex; flex-direction: column;
    background: var(--color-surface);
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-e3);
    overflow: hidden;
    animation: pop var(--dur-2) var(--ease-out-quint);
  }
  .dialog.closing { animation-name: pop-out; }
  .head { padding: 16px 18px 12px; border-bottom: 1px solid var(--color-border); }
  h2 { font-size: var(--text-md); margin-bottom: 2px; }
  .origin { color: var(--color-muted-foreground); font-size: var(--text-sm); margin-bottom: 8px; overflow-wrap: anywhere; }
  .head .muted { font-size: var(--text-sm); }
  .list { flex: 1; min-height: 0; overflow: auto; padding: 6px; }
  .row {
    display: flex; align-items: center; gap: 10px;
    min-height: var(--row); padding: 6px 10px;
    border-radius: var(--radius-md);
  }
  .row:hover { background: var(--color-active); }
  .row.off { color: var(--color-muted-foreground); }
  /* `.ui-label` trims each line to its cap height: the two lines need their own gap. */
  .what { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; padding-block: 4px; }
  .title, .detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .detail { font-size: var(--text-sm); color: var(--color-muted-foreground); }
  .status { flex: none; max-width: 45%; font-size: var(--text-sm); text-align: right; overflow-wrap: anywhere; }
  .status.ok { color: var(--color-success); }
  .status.bad { color: var(--color-danger); }
  .status.muted { color: var(--color-muted-foreground); }
  .empty { padding: 14px 10px; text-align: center; font-size: var(--text-sm); }
  .token { display: grid; gap: 4px; padding: 10px 18px; border-top: 1px solid var(--color-border); font-size: var(--text-sm); }
  .token > label:first-child { display: grid; gap: 6px; }
  .token input[type='password'] { width: 100%; min-width: 0; }
  .hint { font-size: var(--text-sm); }
  .clear { display: flex; align-items: center; gap: 6px; min-height: var(--row); }
  .error { margin: 0; padding: 8px 18px 0; color: var(--color-danger); font-size: var(--text-sm); overflow-wrap: anywhere; }
  .actions { display: flex; justify-content: flex-end; gap: 6px; padding: 8px 12px 10px; border-top: 1px solid var(--color-border); }
  @media (max-width: 720px) {
    .scrim { align-items: flex-end; padding-top: 0; }
    .dialog { width: 100vw; max-height: 88dvh; border-radius: var(--radius-xl) var(--radius-xl) 0 0; padding-bottom: env(safe-area-inset-bottom); }
    .row { align-items: flex-start; flex-wrap: wrap; }
    .status { max-width: none; flex-basis: 100%; text-align: left; padding-left: 26px; }
  }
</style>
