<script lang="ts">
  import { untrack } from 'svelte';
  import { CircleCheck, Hourglass, Ruler, Timer } from '@lucide/svelte';
  import { AUTO_COMPACT_MOMENTS, AUTO_COMPACT_TOKENS, type AutoCompact, type AutoCompactMoment, type CompactionTarget } from '@boite/contracts';
  import { compactionPatch, compactionPolicy } from '../lib/compaction-settings';
  import { fill, strings } from '../lib/strings';
  import { formatTokens } from '../lib/format';
  import type { Store } from '../lib/store.svelte';
  import { Autosave, saved, TYPING_MS } from '../lib/autosave.svelte';
  import SyncMark from './SyncMark.svelte';
  import InfoTip from './InfoTip.svelte';
  import SaveStatus from './SaveStatus.svelte';

  /**
   * Automatic compaction: selected idle moments and an independent token limit.
   * The limit triggers at a safe native tool boundary where supported, otherwise
   * between turns. It also gates turn-end/background moments, never cache expiry.
   */
  let { store, target, embedded = false }: { store: Store; target?: CompactionTarget; embedded?: boolean } = $props();
  const uid = $props.id();

  /** Start with idle moments only and leave the independent token limit off. */
  const FIRST: AutoCompact = { tokens: null, moments: ['background', 'cache-expiry'] };
  const FIRST_TOKENS = 200_000;
  const PRESETS = [100_000, 200_000, 400_000, 800_000];
  /** Idle moments, from cache reuse to one that can make a new message wait. */
  const MOMENTS: { id: AutoCompactMoment; icon: typeof Timer; name: string; hint: string; recommended?: true }[] = [
    { id: 'cache-expiry', icon: Timer, name: strings.settings.autoCompactCacheExpiry, hint: strings.settings.autoCompactCacheExpiryHint, recommended: true },
    { id: 'background', icon: Hourglass, name: strings.settings.autoCompactBackground, hint: strings.settings.autoCompactBackgroundHint },
    { id: 'turn-end', icon: CircleCheck, name: strings.settings.autoCompactTurnEnd, hint: strings.settings.autoCompactTurnEndHint }
  ];

  let rule = $derived(compactionPolicy(store.settings, target).autoCompact);
  /** The field as typed, kept while the token limit is off so switching it back on restores it. */
  let tokens = $state<number | null | undefined>(FIRST_TOKENS);
  let dirty = $state(false);
  $effect(() => {
    const next = rule?.tokens ?? null;
    untrack(() => { if (!dirty && next !== null) tokens = next; });
  });
  let valid = $derived(typeof tokens === 'number' && Number.isInteger(tokens) && tokens >= AUTO_COMPACT_TOKENS.min && tokens <= AUTO_COMPACT_TOKENS.max);

  /** A switch saves when it flips; a refusal puts it back. */
  /** Every control builds the whole rule from the saved one, so none moves while a save is on its way. */
  let saving = $state(false);
  let inflight: Promise<boolean> | null = null;
  async function save(next: AutoCompact | null, input?: HTMLInputElement, machine = store, scope = target) {
    saving = true;
    const sent = inflight = machine.saveSettings(compactionPatch(machine.settings, scope, { autoCompact: next })).finally(() => { saving = false; if (inflight === sent) inflight = null; });
    const ok = await sent;
    if (!ok && input) input.checked = !input.checked;
    return ok;
  }
  /** Removing the last idle moment preserves an independent token limit. */
  function toggleMoment(moment: AutoCompactMoment, input: HTMLInputElement) {
    if (!rule) return;
    const moments = AUTO_COMPACT_MOMENTS.filter((entry) => entry === moment ? input.checked : rule.moments.includes(entry));
    void save(moments.length || rule.tokens !== null ? { ...rule, moments } : null, input);
  }
  /** The switch sends the size as it stands, so an earlier size status or draft no longer applies. */
  async function toggleThreshold(input: HTMLInputElement) {
    if (!rule) return;
    if (input.checked && !valid) tokens = FIRST_TOKENS;
    sizeSave.state = 'idle';
    const next = { ...rule, tokens: input.checked ? tokens as number : null };
    if (await save(next.tokens !== null || next.moments.length ? next : null, input)) dirty = false;
  }
  /**
   * The size saves like every typed setting: after a pause, when the field is
   * left, or when the page goes, from the rule the core holds once a switch's
   * save has landed. The field stays enabled, so a save never takes its focus.
   * It goes to the machine it was typed for: switching machines flushes it
   * while `store` already reads the next one.
   */
  let typedFor: { store: Store; target?: CompactionTarget } | null = null;
  const sizeSave = new Autosave(async () => {
    while (inflight) await inflight.catch(() => false);
    const destination = typedFor ?? { store, target };
    const current = compactionPolicy(destination.store.settings, destination.target).autoCompact;
    if (!current || current.tokens === null) { dirty = false; return; }
    const sent = tokens as number;
    if (current.tokens !== sent) await saved(save({ ...current, tokens: sent }, undefined, destination.store, destination.target));
    if (tokens === sent) dirty = false;
  }, () => valid ? null : strings.settings.autosave.invalid);
  export async function flush() {
    await sizeSave.flush();
    while (inflight) await inflight.catch(() => false);
  }
  $effect(() => () => void sizeSave.flush());
  function typeTokens(delay: number, value = tokens) {
    tokens = value;
    dirty = true;
    typedFor = { store, target };
    sizeSave.change('', delay);
  }
</script>

<!-- The core's own behaviour on the owner's machine, so a paired device does not see it. -->
{#if store.owner}
  <section class:card={!embedded} id="settings-auto-compact" data-testid="auto-compact-settings">
    <label for="{uid}-on" class="master">
      <span class="words">
        <h2 class="ui-label-box"><span class="ui-label" id="{uid}-on-name">{strings.settings.autoCompact}</span><InfoTip topic={strings.settings.autoCompact} text={strings.settings.autoCompactHint} /><SyncMark {store} key={target ? 'compactionByType' : 'autoCompact'} /></h2>
      </span>
      <input id="{uid}-on" aria-labelledby="{uid}-on-name" type="checkbox" role="switch" data-testid="auto-compact-on"
        checked={rule !== null} disabled={!store.settings || saving} onchange={(event) => void save(event.currentTarget.checked ? FIRST : null, event.currentTarget)} />
    </label>

    {#if rule}
      <h3>{strings.settings.autoCompactWhen}</h3>
      <div class="options">
        {#each MOMENTS as moment (moment.id)}
          {@const Icon = moment.icon}
          {@const on = rule.moments.includes(moment.id)}
          <label for="{uid}-{moment.id}" class="option" class:on>
            <span class="icon"><Icon size={18} strokeWidth={1.75} /></span>
            <span class="words">
              <span class="name"><span class="ui-label" id="{uid}-{moment.id}-name">{moment.name}</span><InfoTip topic={moment.name} text={moment.hint} />{#if moment.recommended}<span class="badge ui-label-box"><span class="ui-label">{strings.settings.autoCompactRecommended}</span></span>{/if}</span>
            </span>
            <input id="{uid}-{moment.id}" aria-labelledby="{uid}-{moment.id}-name" type="checkbox" role="switch" data-testid="auto-compact-{moment.id}"
              checked={on} disabled={saving} onchange={(event) => toggleMoment(moment.id, event.currentTarget)} />
          </label>
        {/each}
      </div>

      <h3>{strings.settings.autoCompactCondition}</h3>
      <div class="options">
        <div class="option" class:on={rule.tokens !== null}>
          <span class="icon"><Ruler size={18} strokeWidth={1.75} /></span>
          <span class="words">
            <!-- Only the words label the switch: a retry beside them must not flip it. -->
            <span class="name"><label for="{uid}-threshold" class="ui-label" id="{uid}-threshold-name">{strings.settings.autoCompactThreshold}</label><InfoTip topic={strings.settings.autoCompactThreshold} text={rule.tokens === null ? strings.settings.autoCompactThresholdOff : strings.settings.autoCompactThresholdHint} />{#if rule.tokens !== null}<SaveStatus save={sizeSave} />{/if}</span>
            {#if rule.tokens !== null}
              <span class="size">
                <span class="presets" role="group" aria-label={strings.settings.autoCompactThreshold}>
                  {#each PRESETS as preset (preset)}
                    <button type="button" class="chip" class:picked={tokens === preset} aria-pressed={tokens === preset} data-testid="auto-compact-preset-{preset}"
                      onclick={() => typeTokens(0, preset)}><span class="ui-label">{formatTokens(preset)}</span></button>
                  {/each}
                </span>
                <span class="field">
                  <input id="{uid}-tokens" type="number" inputmode="numeric" min={AUTO_COMPACT_TOKENS.min} max={AUTO_COMPACT_TOKENS.max} step="1000"
                    data-testid="auto-compact-tokens" aria-label={strings.settings.autoCompactThreshold} aria-invalid={!valid}
                    aria-describedby={valid ? undefined : `${uid}-tokens-error`} bind:value={tokens}
                    oninput={() => typeTokens(TYPING_MS)} onchange={() => void sizeSave.flush()} />
                  <span class="unit ui-label">{strings.settings.autoCompactUnit}</span>
                </span>
              </span>
              {#if !valid}
                <span class="field-error" id="{uid}-tokens-error" data-testid="auto-compact-tokens-error">{fill(strings.settings.numberRange, { min: String(AUTO_COMPACT_TOKENS.min), max: String(AUTO_COMPACT_TOKENS.max) })}</span>
              {/if}
            {/if}
          </span>
          <input id="{uid}-threshold" aria-labelledby="{uid}-threshold-name" type="checkbox" role="switch" data-testid="auto-compact-threshold"
            checked={rule.tokens !== null} disabled={saving} onchange={(event) => void toggleThreshold(event.currentTarget)} />
        </div>
      </div>
    {/if}
  </section>
{/if}

<style>
  .master { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; cursor: pointer; }
  .master .words { display: grid; gap: 6px; flex: 1; min-width: 0; }
  .master h2 { margin: 0; }
  h3 { margin: 22px 0 10px; color: var(--color-muted-foreground); font-size: var(--text-xs); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
  .options { display: grid; gap: 8px; }
  /* Icon, name, help and switch share the first line. */
  .option { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; align-items: center; column-gap: 14px; row-gap: 4px; padding: 14px 16px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-2); transition: border-color var(--dur-2), background var(--dur-2); }
  .option .words { display: contents; }
  label.option { cursor: pointer; }
  .option.on { border-color: color-mix(in srgb, var(--color-accent) 45%, var(--color-border)); background: color-mix(in srgb, var(--color-accent) 6%, var(--color-surface-2)); }
  .icon { display: grid; place-items: center; grid-column: 1; grid-row: 1; width: 34px; height: 34px; border-radius: var(--radius-sm); background: var(--color-surface); border: 1px solid var(--color-border); color: var(--color-muted-foreground); transition: color var(--dur-2); }
  .option.on .icon { color: var(--color-accent); }
  .name { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; grid-column: 2; grid-row: 1; color: var(--color-foreground); font-size: var(--text-base); font-weight: 500; }
  .badge { padding: 1px 7px; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--color-accent) 14%, transparent); color: var(--color-accent); font-size: var(--text-xs); font-weight: 600; white-space: nowrap; }
  .option > input { grid-column: 3; grid-row: 1; }
  .size, .field-error { grid-column: 2; }
  .size { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 8px; }
  .presets { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip.picked { border-color: var(--color-accent); color: var(--color-foreground); }
  .field { display: flex; align-items: center; gap: 8px; }
  input[type='number'] { width: 120px; text-align: right; }
  input[aria-invalid='true'] { border-color: var(--color-danger); }
  .unit { color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .field-error { color: var(--color-danger); font-size: var(--text-sm); }
  /* The threshold controls use the whole tile on a phone. */
  @media (max-width: 720px) {
    .size, .field-error { grid-column: 1 / -1; }
  }
</style>
