<script lang="ts">
  import { untrack } from 'svelte';
  import InfoTip from './InfoTip.svelte';
  import SaveStatus from './SaveStatus.svelte';
  import { Autosave, typed } from '../lib/autosave.svelte';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  let { store }: { store: Store } = $props();
  const uid = $props.id();

  type NumberKey = 'warmProcessMinutes';
  /** The ranges the inputs offer, checked here so a bad value never reaches the core as a raw refusal. */
  const FIELDS: { key: NumberKey; min: number; max: number }[] = [
    { key: 'warmProcessMinutes', min: 0, max: 120 }
  ];
  const DEFAULTS: Record<NumberKey, number> = { warmProcessMinutes: 5 };

  let values = $state<Record<NumberKey, number | null | undefined>>({ ...DEFAULTS });
  let dirty = $state(false);

  // The fields follow the core while nothing typed waits to be saved: a card
  // mounted before the settings arrive would otherwise save its defaults over them.
  $effect(() => {
    const settings = store.settings;
    if (!settings) return;
    untrack(() => {
      if (!dirty) values = { warmProcessMinutes: settings.warmProcessMinutes };
    });
  });

  function valid(key: NumberKey): boolean {
    const field = FIELDS.find((f) => f.key === key)!;
    const value = values[key];
    return typeof value === 'number' && Number.isInteger(value) && value >= field.min && value <= field.max;
  }
  let allValid = $derived(FIELDS.every((field) => valid(field.key)));

  function label(key: NumberKey): string {
    return strings.settings[key];
  }

  const HINTS: Record<NumberKey, 'warmProcessMinutesHint'> = {
    warmProcessMinutes: 'warmProcessMinutesHint'
  };

  const save = new Autosave(async () => {
    const sent = values.warmProcessMinutes;
    if (!await store.saveSettings({ warmProcessMinutes: sent! })) throw new Error('');
    if (values.warmProcessMinutes === sent) dirty = false;
  }, () => allValid && store.settings ? null : strings.settings.autosave.invalid);
  $effect(() => () => void save.flush());

</script>

<!-- The whole card is the owner's machine, so a paired device does not see it. -->
{#if store.owner}
  <section class="card" id="settings-execution" data-testid="scheduler-settings">
    <h2>{strings.settings.execution}<SaveStatus {save} /></h2>
    <div class="grid">
      {#each FIELDS as field (field.key)}
        <label>
          <span class="name"><span class="ui-label">{label(field.key)}</span><InfoTip topic={label(field.key)} text={strings.settings[HINTS[field.key]]} /></span>
          <input
            type="number"
            min={field.min}
            max={field.max}
            step="1"
            data-testid="setting-{field.key}"
            aria-invalid={!valid(field.key)}
            aria-describedby={valid(field.key) ? undefined : `${uid}-${field.key}-error`}
            bind:value={values[field.key]}
            oninput={() => { dirty = true; typed(save).oninput(); }}
            onchange={() => void save.flush()}
          />
          {#if !valid(field.key)}
            <span class="field-error" id="{uid}-{field.key}-error" data-testid="setting-error-{field.key}">{fill(strings.settings.numberRange, { min: String(field.min), max: String(field.max) })}</span>
          {/if}
        </label>
      {/each}
    </div>
  </section>
{/if}

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 10px;
  }

  .grid label { display: grid; gap: 6px; }
  .name { display: inline-flex; align-items: center; font-size: var(--text-sm); color: var(--color-muted-foreground); }

  input[type='number'] {
    width: 100%;
  }

  input[aria-invalid='true'] {
    border-color: var(--color-danger);
  }

  .field-error {
    display: block;
    margin-top: 4px;
    color: var(--color-danger);
    font-size: var(--text-sm);
  }
</style>
