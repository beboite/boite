<script lang="ts">
  import { tick } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { ArrowRight, CircleArrowDown } from '@lucide/svelte';
  import MachineIcon from './MachineIcon.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import { appUpdater } from '../lib/app-update.svelte';
  import { Closing } from '../lib/closing.svelte';
  import { floating } from '../lib/floating';
  import { tourRequested, tourSeen } from '../lib/onboarding.svelte';
  import { strings } from '../lib/strings';
  import { updateEverything, type PlannedPart } from '../lib/update-everything.svelte';
  import { workspace } from '../lib/workspace.svelte';

  /**
   * The foot's update button and the card it opens, bottom left of the
   * window. A release found anywhere lights the dot and opens the card by
   * itself on a wide window, once per release: Later puts that release off
   * until a newer one comes, a press elsewhere only closes the card. Update
   * all starts every update of every machine at once.
   */
  const card = new Closing();
  const narrow = new MediaQuery('(max-width: 720px)');
  let trigger = $state<HTMLButtonElement>();
  let content = $state<HTMLDivElement>();
  let plan = $derived(updateEverything.plan);
  let fresh = $derived(updateEverything.fresh);
  let startable = $derived(plan.flatMap((machine) => machine.parts.filter((part) => part.startable)));
  let busy = $derived(updateEverything.running || plan.some((machine) => machine.parts.some((part) => !part.startable)));
  let failed = $derived(startable.some((part) => part.state === 'failed'));
  let restarts = $derived(plan.some((machine) => machine.local && machine.parts.some((part) => part.id === 'app' && part.startable)));
  let label = $derived(busy ? strings.updateAll.busy : strings.updateAll.trigger);
  /** Boite's own mark for Boite's rows, the nightly one on that track. */
  let mark = $derived(appUpdater.snapshot.currentChannel === 'nightly' ? './icons/icon-nightly.svg' : './icons/icon.svg');
  const machineOf = (id: string) => workspace.machines.find((machine) => machine.id === id);
  /** Both versions when they fit on the row; a long nightly name keeps only the new one. */
  const fromShown = (part: PlannedPart) => part.from !== null && part.from !== part.version && part.from.length + part.version.length <= 26;

  // Opens by itself once per release in this window, however often the rail mounts.
  $effect(() => {
    const keys = fresh;
    // The tour speaks first: what it covers opens once it is done.
    if (narrow.current || tourRequested() || !tourSeen() || !updateEverything.announce(keys)) return;
    if (!card.open) card.show();
  });

  // Nothing left to show: the card goes with the last update.
  $effect(() => { if (plan.length === 0 && card.open) card.hide(); });

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
    close();
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !card.open) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  function stateText(part: PlannedPart): string {
    switch (part.state) {
      case 'downloading': return strings.updateAll.downloading(part.percent);
      // Downloaded during a run: the app waits for this computer's agents, then restarts.
      case 'ready': return updateEverything.running ? strings.updateAll.restartsNext : strings.updateAll.ready;
      case 'waiting': return strings.updateAll.waiting;
      case 'installing': return strings.updateAll.installing;
      case 'updating': return part.waitingFor > 0 ? strings.updateAll.waitingFor(part.waitingFor) : strings.updateAll.updating;
      case 'failed': return strings.updateAll.failed;
      default: return '';
    }
  }
</script>

{#if plan.length > 0}
  <button type="button" class="ghost icon update-trigger" class:busy class:lit={fresh.length > 0} bind:this={trigger}
    title={label} aria-label={label} aria-haspopup="dialog" aria-expanded={card.open} onclick={() => void toggle()} data-testid="nav-updates">
    <CircleArrowDown size={16} strokeWidth={1.75} />
    {#if fresh.length > 0 || busy}<span class="dot" data-testid="nav-updates-dot"></span>{/if}
  </button>
{/if}

{#if card.shown && plan.length > 0}
  <div class="updates-card" class:closing={card.closing} bind:this={content} role="dialog" tabindex="-1" aria-label={strings.updateAll.heading}
    {onkeydown} data-testid="updates-card" use:card.attach onanimationend={card.end}
    use:floating={{ anchor: () => trigger?.closest<HTMLElement>('.foot') ?? trigger ?? null, placement: 'top', align: 'start', cap: 520, dismiss: close }}>
    <header>
      <span class="glyph" class:busy aria-hidden="true"><CircleArrowDown size={18} strokeWidth={1.75} /></span>
      <div class="title">
        <h2>{strings.updateAll.heading}</h2>
        <p>{busy ? strings.updateAll.busy : strings.updateAll.summary(startable.length)}</p>
      </div>
    </header>
    <div class="hosts">
      {#each plan as machine (machine.id)}
        <section class="host" data-testid="updates-machine">
          {#if plan.length > 1 || !machine.local}
            {@const owner = machineOf(machine.id)}
            <h3><MachineIcon os={owner?.store.core?.os} icon={owner?.icon} size={12} /><span>{machine.label}</span></h3>
          {/if}
          <ul>
            {#each machine.parts as part (part.id)}
              {@const status = stateText(part)}
              <li class="part {part.state}" data-testid="updates-part" data-part={part.id} title={part.message ?? undefined}>
                <span class="mark" aria-hidden="true">
                  {#if part.id === 'app' || part.id === 'boite'}<img src={mark} alt="" width="16" height="16" />{:else}<ProviderLogo providerId={part.id} size={16} />{/if}
                </span>
                <span class="name">{part.name}</span>
                <span class="versions">
                  {#if fromShown(part)}<span class="from">{part.from}</span><ArrowRight size={11} strokeWidth={2} />{/if}<span class="to">{part.version}</span>
                </span>
                {#if status}<span class="state" role="status">{status}</span>{/if}
                {#if part.state === 'downloading'}
                  <span class="track" class:indeterminate={part.percent === null}><span style:width={part.percent === null ? '40%' : `${part.percent}%`}></span></span>
                {/if}
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    </div>
    {#if restarts}<p class="note">{strings.updateAll.restarts}</p>{/if}
    <footer>
      <button type="button" class="ghost small" onclick={later} data-testid="updates-later">{strings.updateAll.later}</button>
      <button type="button" class="primary small" disabled={startable.length === 0 || updateEverything.running}
        aria-busy={updateEverything.running} onclick={() => void updateEverything.run()} data-testid="updates-run">
        <span class="ui-label">{updateEverything.running || startable.length === 0 ? strings.updateAll.busy : failed && startable.every((part) => part.state === 'failed') ? strings.updateAll.retry : startable.length === 1 ? strings.harnessUpdates.update : strings.updateAll.run}</span>
      </button>
    </footer>
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
  .glyph { display: grid; place-items: center; flex: none; width: 32px; height: 32px; border-radius: var(--radius-md); color: var(--color-accent); background: var(--color-accent-soft); }
  .glyph.busy :global(svg) { animation: breathe 1.6s ease-in-out infinite; }
  .title { min-width: 0; }
  h2 { margin: 0; font-size: var(--text-sm); font-weight: 600; }
  .title p { margin: 1px 0 0; font-size: var(--text-xs); color: var(--color-muted-foreground); }

  /* Not `.machines`: the rail's foot hides that class, its machine menu's. */
  .hosts { min-height: 0; overflow-y: auto; padding: 0 6px 4px; }
  .host + .host { margin-top: 6px; }
  h3 { display: flex; align-items: center; gap: 6px; margin: 6px 8px 2px; font-size: var(--text-xs); font-weight: 500; color: var(--color-muted-foreground); }
  h3 span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  ul { list-style: none; margin: 0; padding: 0; }
  .part { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; align-items: center; column-gap: 8px; row-gap: 3px; padding: 5px 8px; border-radius: var(--radius-md); font-size: var(--text-sm); }
  .mark { display: grid; place-items: center; width: 18px; height: 18px; }
  .mark img { display: block; border-radius: 4px; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .versions { display: inline-flex; align-items: center; gap: 4px; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--color-subtle); white-space: nowrap; }
  .to { color: var(--color-foreground); }
  .state { grid-column: 2 / -1; font-size: var(--text-xs); color: var(--color-muted-foreground); }
  .part.failed .state { color: var(--color-danger); }
  .part.ready .state { color: var(--color-success); }
  .track { grid-column: 2 / -1; height: 3px; overflow: hidden; border-radius: var(--radius-sm); background: var(--color-surface-3); }
  .track span { display: block; height: 100%; border-radius: inherit; background: var(--color-accent); transition: width var(--dur-2) var(--ease-out-quint); }
  .track.indeterminate span { opacity: 0.5; animation: loading-slide 1.2s ease-in-out infinite; }

  .note { margin: 4px 14px 0; font-size: var(--text-xs); line-height: 1.45; color: var(--color-subtle); }
  footer { display: flex; justify-content: flex-end; gap: 6px; padding: 10px 10px 10px; }

  @media (prefers-reduced-motion: reduce) {
    .update-trigger.busy .dot, .glyph.busy :global(svg), .track.indeterminate span { animation: none; }
  }
  :global(html[data-motion='reduced']) .update-trigger.busy .dot,
  :global(html[data-motion='reduced']) .glyph.busy :global(svg),
  :global(html[data-motion='reduced']) .track.indeterminate span { animation: none; }
</style>
