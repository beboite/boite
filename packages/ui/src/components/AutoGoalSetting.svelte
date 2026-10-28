<script lang="ts">
  import { untrack } from 'svelte';
  import { TextQuote } from '@lucide/svelte';
  import { AUTO_GOAL_MIN_CHARS } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import InfoTip from './InfoTip.svelte';

  /**
   * The `autoGoalMinChars` setting under the Automatic goals switch: how long
   * a prompt must be before it starts a reviewed goal (`docs/goals.md`).
   */
  let { store }: { store: Store } = $props();
  const uid = $props.id();

  let saved = $derived(store.settings?.autoGoalMinChars ?? AUTO_GOAL_MIN_CHARS.default);
  /** The field as typed, until it saves. */
  let chars = $state<number | null | undefined>(AUTO_GOAL_MIN_CHARS.default);
  let dirty = $state(false);
  $effect(() => {
    const next = saved;
    untrack(() => { if (!dirty) chars = next; });
  });
  let valid = $derived(typeof chars === 'number' && Number.isInteger(chars) && chars >= AUTO_GOAL_MIN_CHARS.min && chars <= AUTO_GOAL_MIN_CHARS.max);

  let saving = $state(false);
  async function save() {
    if (!valid) return;
    if (chars === saved) { dirty = false; return; }
    saving = true;
    const ok = await store.saveSettings({ autoGoalMinChars: chars as number }).finally(() => { saving = false; });
    if (ok) dirty = false;
  }
</script>

<!-- The core decides on the owner's machine, so a paired device does not see the threshold. -->
{#if store.owner && store.settings}
  <div class="option" data-testid="auto-goal-settings">
    <span class="icon"><TextQuote size={18} strokeWidth={1.75} /></span>
    <label for="{uid}-chars" class="name"><span class="ui-label">{strings.experiments.autoGoal.minChars}</span><InfoTip topic={strings.experiments.autoGoal.minChars} text={strings.experiments.autoGoal.minCharsHint} /></label>
    <span class="field">
      <input id="{uid}-chars" type="number" inputmode="numeric" min={AUTO_GOAL_MIN_CHARS.min} max={AUTO_GOAL_MIN_CHARS.max} step="100"
        data-testid="auto-goal-min-chars" aria-invalid={!valid}
        aria-describedby={valid ? undefined : `${uid}-chars-error`} disabled={saving} bind:value={chars}
        oninput={() => { dirty = true; }} onchange={() => void save()} />
      <span class="unit ui-label">{strings.experiments.autoGoal.unit}</span>
    </span>
    {#if !valid}
      <span class="field-error" id="{uid}-chars-error" data-testid="auto-goal-min-chars-error">{fill(strings.settings.numberRange, { min: String(AUTO_GOAL_MIN_CHARS.min), max: String(AUTO_GOAL_MIN_CHARS.max) })}</span>
    {/if}
  </div>
{/if}

<style>
  .option { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; align-items: center; column-gap: 14px; row-gap: 4px; margin: 4px 0 8px; padding: 14px 16px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-2); }
  .icon { display: grid; place-items: center; width: 34px; height: 34px; border-radius: var(--radius-sm); background: var(--color-surface); border: 1px solid var(--color-border); color: var(--color-accent); }
  .name { display: flex; align-items: center; gap: 4px 8px; color: var(--color-foreground); font-size: var(--text-base); font-weight: 500; }
  .field { display: flex; align-items: center; gap: 8px; }
  input[type='number'] { width: 88px; text-align: right; }
  input[aria-invalid='true'] { border-color: var(--color-danger); }
  .unit { color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .field-error { grid-column: 2 / -1; color: var(--color-danger); font-size: var(--text-sm); }
  /* A phone keeps the label on one line: the icon goes, the field narrows. */
  @media (max-width: 480px) {
    .option { grid-template-columns: minmax(0, 1fr) auto; column-gap: 10px; padding: 12px 14px; }
    .icon { display: none; }
    .name { white-space: nowrap; }
    input[type='number'] { width: 78px; }
    .field-error { grid-column: 1 / -1; }
  }
</style>
