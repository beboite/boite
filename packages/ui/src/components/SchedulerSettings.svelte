<script lang="ts">
  import { untrack } from 'svelte';
  import InfoTip from './InfoTip.svelte';
  import { time } from '../lib/format';
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
  let saving = $state(false);
  let savedAt = $state<number | null>(null);

  // The fields follow the core while nothing typed waits for Save: a card
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

  async function save() {
    if (!allValid || saving) return;
    saving = true;
    const ok = await store.saveSettings({
      warmProcessMinutes: values.warmProcessMinutes!
    });
    saving = false;
    savedAt = ok ? Date.now() : null;
    if (ok) dirty = false;
  }

</script>

<!-- The whole card is the owner's machine, so a paired device does not see it. -->
{#if store.owner}
  <section class="card" id="settings-execution" data-testid="scheduler-settings">
    <h2>{strings.settings.execution}</h2>
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
            oninput={() => { dirty = true; savedAt = null; }}
          />
          {#if !valid(field.key)}
            <span class="field-error" id="{uid}-{field.key}-error" data-testid="setting-error-{field.key}">{fill(strings.settings.numberRange, { min: String(field.min), max: String(field.max) })}</span>
          {/if}
        </label>
      {/each}
    </div>
    <div class="actions">
      <button type="button" class="primary" data-testid="scheduler-save" disabled={!allValid || saving || !store.settings} onclick={() => void save()}><span class="ui-label">{strings.settings.save}</span></button>
      {#if savedAt !== null}
        <span class="muted ui-label" data-testid="scheduler-saved">{strings.settings.saved} {time(savedAt)}</span>
      {/if}
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

  .actions {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 12px;
  }
</style>
