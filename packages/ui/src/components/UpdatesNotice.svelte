<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { slide } from 'svelte/transition';
  import { ArrowRight, Check, CircleArrowDown, X } from '@lucide/svelte';
  import MachineIcon from './MachineIcon.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import { appUpdater } from '../lib/app-update.svelte';
  import { Closing } from '../lib/closing.svelte';
  import { floating } from '../lib/floating';
  import { tourRequested, tourSeen } from '../lib/onboarding.svelte';
  import { strings } from '../lib/strings';
  import { APP_MACHINE, DONE_LINGER_MS, reconcileRows, updateEverything, type PlannedPart, type UpdateRow } from '../lib/update-everything.svelte';
  import { workspace } from '../lib/workspace.svelte';

  /**
   * The foot's update button and the card it opens, bottom left of the
   * window. A release found anywhere lights the dot and opens the card by
   * itself on a wide window, once per release: its close button puts that
   * release off until a newer one comes, a press elsewhere only hides the
   * card. Update the app downloads this app's release alone; Update all
   * starts every update of every machine at once. Each row that lands shows
   * its check and goes, and the card ends on "Everything is up to date" or on
   * Restart once the app's release is downloaded: nothing restarts by itself.
   */
  const card = new Closing();
  const narrow = new MediaQuery('(max-width: 720px)');
  /** How long "Everything is up to date" stays before the card puts itself away. */
  const ALL_DONE_MS = 3500;
  let trigger = $state<HTMLButtonElement>();
  let content = $state<HTMLDivElement>();
  let plan = $derived(updateEverything.plan);
  let fresh = $derived(updateEverything.fresh);
  let rows = $state.raw<UpdateRow[]>([]);
  /** A run started from this card, followed until its last row lands. */
  let following = $state(false);

  const reachable = (machineId: string): boolean =>
    machineId === APP_MACHINE || workspace.machines.some((machine) => machine.id === machineId && machine.store.connection === 'ready');

  // The rows follow the plan; a finished one keeps its check for a moment, then a timer lets it go.
  let lingerTimer: ReturnType<typeof setTimeout> | undefined;
  function refresh(): void {
    clearTimeout(lingerTimer);
    const next = reconcileRows(untrack(() => rows), plan, reachable, Date.now());
    rows = next;
    const oldest = Math.min(...next.filter((row) => row.doneAt !== null).map((row) => row.doneAt!));
    if (Number.isFinite(oldest)) lingerTimer = setTimeout(refresh, Math.max(0, oldest + DONE_LINGER_MS - Date.now()) + 20);
  }
  $effect(() => {
    void plan;
    for (const machine of workspace.machines) void machine.store.connection;
    untrack(refresh);
  });
  $effect(() => () => clearTimeout(lingerTimer));

  let remaining = $derived(rows.filter((row) => row.doneAt === null));
  let startable = $derived(remaining.map((row) => row.part).filter((part) => part.startable));
  let appRow = $derived(remaining.find((row) => row.part.id === 'app'));
  let appReady = $derived(appRow?.part.state === 'ready');
  let localBusy = $derived(updateEverything.localBusy);
  /** Something besides the app's own release that the second button starts. */
  let others = $derived(startable.some((part) => part.id !== 'app'));
  let underWay = $derived(updateEverything.running || remaining.some((row) => !row.part.startable && row.part.state !== 'ready'));
  /** The run landed: nothing left but, perhaps, the app waiting for its restart. */
  let finished = $derived(following && !updateEverything.running && remaining.every((row) => row.part.id === 'app' && row.part.state === 'ready'));
  let allDone = $derived(finished && remaining.length === 0);
  let failed = $derived(startable.some((part) => part.state === 'failed'));
  let shown = $derived(rows.length > 0 || finished);
  let label = $derived(underWay ? strings.updateAll.busy : strings.updateAll.trigger);
  let subtitle = $derived(allDone ? strings.updateAll.allDone : finished ? strings.updateAll.finish
    : underWay ? strings.updateAll.busy : strings.updateAll.summary(startable.length));
  let allLabel = $derived(updateEverything.running || !others ? strings.updateAll.busy
    : failed && startable.every((part) => part.state === 'failed') ? strings.updateAll.retry
    : startable.length === 1 ? strings.harnessUpdates.update : strings.updateAll.run);
  /** Boite's own mark for Boite's rows, the nightly one on that track. */
  let mark = $derived(appUpdater.snapshot.currentChannel === 'nightly' ? './icons/icon-nightly.svg' : './icons/icon.svg');
  /** The rows grouped by machine, in the order they first appeared. */
  let groups = $derived.by(() => {
    const byMachine = new Map<string, { id: string; label: string; local: boolean; rows: UpdateRow[] }>();
    for (const row of rows) {
      const group = byMachine.get(row.machineId) ?? { id: row.machineId, label: row.label, local: row.local, rows: [] };
      group.rows.push(row);
      byMachine.set(row.machineId, group);
    }
    return [...byMachine.values()];
  });
  const machineOf = (id: string) => workspace.machines.find((machine) => machine.id === id);
  /** Both versions when they fit on the row; a long nightly name keeps only the new one. */
  const fromShown = (part: PlannedPart) => part.from !== null && part.from !== part.version && part.from.length + part.version.length <= 26;
  /** The rows' slide, nothing when the system or the app asks for less motion. */
  const fold = (): number =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'reduced' ? 0 : 220;

  // Opens by itself once per release in this window, however often the rail mounts.
  $effect(() => {
    const keys = fresh;
    // The tour speaks first: what it covers opens once it is done.
    if (narrow.current || tourRequested() || !tourSeen() || !updateEverything.announce(keys)) return;
    if (!card.open) card.show();
  });

  // Nothing left and nothing to say: the card goes with the last row.
  $effect(() => { if (!shown && card.open) card.hide(); });

  // "Everything is up to date" says it, then puts the card away.
  $effect(() => {
    if (!allDone) return;
    const timer = setTimeout(() => { following = false; card.hide(); }, ALL_DONE_MS);
    return () => clearTimeout(timer);
  });

  // A press anywhere else puts it away, without putting the release off.
  $effect(() => {
    if (!card.open) return;
    const onpress = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (trigger?.contains(target) || content?.contains(target))) return;
      card.hide();
    };
    document.addEventListener('pointerdown', onpress, true);
    return () => document.removeEventListener('pointerdown', onpress, true);
  });

  // A closed card after the run has nothing left to follow.
  $effect(() => { if (!card.shown && finished) untrack(() => { following = false; }); });

  function close() {
    card.hide();
    trigger?.focus({ preventScroll: true });
  }

  async function toggle() {
    if (card.open) return close();
    card.show();
    await tick();
    content?.focus({ preventScroll: true });
  }

  function later() {
    updateEverything.later();
    following = false;
    close();
  }

  function start(appOnly: boolean) {
    following = true;
    void updateEverything.run({ appOnly });
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !card.open) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  function stateText(row: UpdateRow): string {
    if (row.doneAt !== null) return strings.updateAll.done;
    const part = row.part;
    switch (part.state) {
      case 'downloading': return strings.updateAll.downloading(part.percent);
      // Downloaded: the restart waits for this computer's agents, then for the user.
      case 'ready': return localBusy ? strings.updateAll.restartsNext : strings.updateAll.ready;
      case 'waiting': return strings.updateAll.waiting;
      case 'installing': return strings.updateAll.installing;
      case 'updating': return part.waitingFor > 0 ? strings.updateAll.waitingFor(part.waitingFor) : strings.updateAll.updating;
      case 'failed': return strings.updateAll.failed;
      default: return '';
    }
  }
</script>

{#if shown}
  <button type="button" class="ghost icon update-trigger" class:busy={underWay} class:lit={fresh.length > 0 || finished} bind:this={trigger}
    title={label} aria-label={label} aria-haspopup="dialog" aria-expanded={card.open} onclick={() => void toggle()} data-testid="nav-updates">
    <CircleArrowDown size={16} strokeWidth={1.75} />
    {#if fresh.length > 0 || underWay || appReady}<span class="dot" data-testid="nav-updates-dot"></span>{/if}
  </button>
{/if}

{#if card.shown && shown}
  <div class="updates-card" class:closing={card.closing} bind:this={content} role="dialog" tabindex="-1" aria-label={strings.updateAll.heading}
    {onkeydown} data-testid="updates-card" use:card.attach onanimationend={card.end}
    use:floating={{ anchor: () => trigger?.closest<HTMLElement>('.foot') ?? trigger ?? null, placement: 'top', align: 'start', cap: 520, dismiss: close }}>
    <header>
      <span class="glyph" class:busy={underWay} class:done={allDone} aria-hidden="true">
        {#if allDone}<Check size={18} strokeWidth={2} />{:else}<CircleArrowDown size={18} strokeWidth={1.75} />{/if}
      </span>
      <div class="title">
        <h2>{strings.updateAll.heading}</h2>
        <p role="status" aria-live="polite" data-testid="updates-status">{subtitle}</p>
      </div>
      <!-- Closing here puts these releases off until a newer one; a press elsewhere only hides the card. -->
      <button type="button" class="ghost icon small close" title={strings.updateAll.later} aria-label={strings.updateAll.later} onclick={later} data-testid="updates-later"><X size={14} /></button>
    </header>
    {#if groups.length > 0}
      <div class="hosts" transition:slide={{ duration: fold() }}>
        {#each groups as group (group.id)}
          <section class="host" data-testid="updates-machine" transition:slide={{ duration: fold() }}>
            {#if groups.length > 1 || !group.local}
              {@const owner = machineOf(group.id)}
              <h3><MachineIcon os={owner?.store.core?.os} icon={owner?.icon} size={12} /><span>{group.label}</span></h3>
            {/if}
            <ul>
              {#each group.rows as row (row.key)}
                {@const part = row.part}
                {@const status = stateText(row)}
                <li class="part {row.doneAt === null ? part.state : 'done'}" data-testid="updates-part" data-part={part.id} data-done={row.doneAt !== null || undefined}
                  title={part.message ?? undefined} transition:slide={{ duration: fold() }}>
                  <span class="mark" aria-hidden="true">
                    {#if part.id === 'app' || part.id === 'boite'}<img src={mark} alt="" width="16" height="16" />{:else}<ProviderLogo providerId={part.id} size={16} />{/if}
                  </span>
                  <span class="name">{part.name}</span>
                  <span class="versions">
                    {#if row.doneAt !== null}<Check size={13} strokeWidth={2.25} class="tick" />
                    {:else if fromShown(part)}<span class="from">{part.from}</span><ArrowRight size={11} strokeWidth={2} />{/if}<span class="to">{part.version}</span>
                  </span>
                  {#if status}<span class="state" role="status">{status}</span>{/if}
                  {#if part.state === 'downloading' && row.doneAt === null}
                    <span class="track" class:indeterminate={part.percent === null}><span style:width={part.percent === null ? '40%' : `${part.percent}%`}></span></span>
                  {/if}
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      </div>
    {/if}
    {#if appRow && !finished && !underWay}<p class="note">{strings.updateAll.restarts}</p>{/if}
    {#if !allDone}
      <footer>
        {#if appReady}
          <!-- Downloaded and verified: the user restarts, once this computer's agents are done. -->
          <button type="button" class={others ? 'small' : 'primary small'} disabled={localBusy} aria-busy={localBusy}
            onclick={() => updateEverything.restart()} data-testid="updates-restart">
            <span class="ui-label">{strings.updateAll.restart}</span>
          </button>
        {:else if appRow?.part.startable}
          <button type="button" class={others ? 'small' : 'primary small'} disabled={updateEverything.running}
            aria-busy={updateEverything.running} onclick={() => start(true)} data-testid="updates-app">
            <span class="ui-label">{updateEverything.running && !others ? strings.updateAll.busy : strings.updateAll.app}</span>
          </button>
        {/if}
        {#if others || (!appRow && underWay)}
          <button type="button" class="primary small" disabled={!others || updateEverything.running}
            aria-busy={updateEverything.running} onclick={() => start(false)} data-testid="updates-run">
            <span class="ui-label">{allLabel}</span>
          </button>
        {/if}
      </footer>
    {/if}
  </div>
{/if}

<style>
  .update-trigger { position: relative; flex: none; }
  .update-trigger.lit { color: var(--color-foreground); }
  .dot { position: absolute; width: 6px; height: 6px; right: 3px; top: 3px; border-radius: 50%; background: var(--color-accent); box-shadow: 0 0 0 2px var(--color-frame); }
  .update-trigger.busy .dot { animation: pulse 1.4s var(--ease-out-quint) infinite; }

  .updates-card { display: flex; flex-direction: column; width: 336px; max-width: calc(100vw - 24px); padding: 0; color: var(--color-foreground); background: var(--color-surface-2); border: 1px solid var(--color-edge); border-radius: var(--radius-lg); box-shadow: var(--shadow-e2); overflow: hidden; transform-origin: bottom left; animation: pop var(--dur-2) var(--ease-out-quint); }
  .updates-card:focus { outline: none; }
  .updates-card.closing { animation-name: pop-out; pointer-events: none; }

  header { display: flex; align-items: center; gap: 10px; padding: 12px 14px 10px; }
  .glyph { display: grid; place-items: center; flex: none; width: 32px; height: 32px; border-radius: var(--radius-md); color: var(--color-accent); background: var(--color-accent-soft); transition: color var(--dur-2), background-color var(--dur-2); }
  .glyph.busy :global(svg) { animation: breathe 1.6s ease-in-out infinite; }
  .glyph.done { color: var(--color-success); background: color-mix(in oklch, var(--color-success) 16%, transparent); }
  .glyph.done :global(svg) { animation: pop var(--dur-2) var(--ease-out-quint); }
  .title { flex: 1; min-width: 0; }
  .close { flex: none; align-self: flex-start; color: var(--color-muted-foreground); }
  h2 { margin: 0; font-size: var(--text-sm); font-weight: 600; }
  .title p { margin: 1px 0 0; font-size: var(--text-xs); color: var(--color-muted-foreground); }

  /* Not `.machines`: the rail's foot hides that class, its machine menu's. */
  .hosts { min-height: 0; overflow-y: auto; padding: 0 6px 4px; }
  .host + .host { margin-top: 6px; }
  h3 { display: flex; align-items: center; gap: 6px; margin: 6px 8px 2px; font-size: var(--text-xs); font-weight: 500; color: var(--color-muted-foreground); }
  h3 span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  ul { list-style: none; margin: 0; padding: 0; }
  .part { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; align-items: center; column-gap: 8px; row-gap: 3px; padding: 5px 8px; border-radius: var(--radius-md); font-size: var(--text-sm); transition: opacity var(--dur-2); }
  .part.done { opacity: 0.7; }
  .mark { display: grid; place-items: center; width: 18px; height: 18px; }
  .mark img { display: block; border-radius: 4px; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .versions { display: inline-flex; align-items: center; gap: 4px; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--color-subtle); white-space: nowrap; }
  .versions :global(.tick) { color: var(--color-success); }
  .to { color: var(--color-foreground); }
  .state { grid-column: 2 / -1; font-size: var(--text-xs); color: var(--color-muted-foreground); }
  .part.failed .state { color: var(--color-danger); }
  .part.ready .state, .part.done .state { color: var(--color-success); }
  .track { grid-column: 2 / -1; height: 3px; overflow: hidden; border-radius: var(--radius-sm); background: var(--color-surface-3); }
  .track span { display: block; height: 100%; border-radius: inherit; background: var(--color-accent); transition: width var(--dur-2) var(--ease-out-quint); }
  .track.indeterminate span { opacity: 0.5; animation: loading-slide 1.2s ease-in-out infinite; }

  .note { margin: 4px 14px 0; font-size: var(--text-xs); line-height: 1.45; color: var(--color-subtle); }
  footer { display: flex; justify-content: flex-end; gap: 6px; padding: 10px 10px 10px; }

  @media (prefers-reduced-motion: reduce) {
    .update-trigger.busy .dot, .glyph.busy :global(svg), .glyph.done :global(svg), .track.indeterminate span { animation: none; }
  }
  :global(html[data-motion='reduced']) .update-trigger.busy .dot,
  :global(html[data-motion='reduced']) .glyph.busy :global(svg),
  :global(html[data-motion='reduced']) .glyph.done :global(svg),
  :global(html[data-motion='reduced']) .track.indeterminate span { animation: none; }
</style>
