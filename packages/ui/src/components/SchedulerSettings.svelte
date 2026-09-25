<script lang="ts">
  import { untrack } from 'svelte';
  import InfoTip from './InfoTip.svelte';
  import { time } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  let { store }: { store: Store } = $props();
  const uid = $props.id();

  type NumberKey = 'maxConcurrentTurns' | 'perAccountConcurrency' | 'warmProcessMinutes';
  /** The ranges the inputs offer, checked here so a bad value never reaches the core as a raw refusal. */
  const FIELDS: { key: NumberKey; min: number; max: number }[] = [
    { key: 'maxConcurrentTurns', min: 1, max: 64 },
    { key: 'perAccountConcurrency', min: 1, max: 32 },
    { key: 'warmProcessMinutes', min: 0, max: 120 }
  ];
  const DEFAULTS: Record<NumberKey, number> = { maxConcurrentTurns: 6, perAccountConcurrency: 2, warmProcessMinutes: 5 };

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
      if (!dirty) values = { maxConcurrentTurns: settings.maxConcurrentTurns, perAccountConcurrency: settings.perAccountConcurrency, warmProcessMinutes: settings.warmProcessMinutes };
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

  async function save() {
    if (!allValid || saving) return;
    saving = true;
    const ok = await store.saveSettings({
      maxConcurrentTurns: values.maxConcurrentTurns!,
      perAccountConcurrency: values.perAccountConcurrency!,
      warmProcessMinutes: values.warmProcessMinutes!
    });
    saving = false;
    savedAt = ok ? Date.now() : null;
    if (ok) dirty = false;
  }

  /** A switch saves when it flips, as every other switch in Settings does; a refusal puts it back. */
  async function toggle(key: 'listenOnLan' | 'asyncQuestions', input: HTMLInputElement) {
    const ok = await store.saveSettings({ [key]: input.checked });
    if (!ok) input.checked = store.settings?.[key] ?? !input.checked;
  }
</script>

<!-- The whole card is the owner's machine, so a paired device does not see it.
     `listenOnLan` decides whether a phone can reach the core at all. -->
{#if store.owner}
  <section class="card" id="settings-scheduler" data-testid="scheduler-settings">
    <h2>{strings.settings.scheduler}</h2>
    <div class="grid">
      {#each FIELDS as field (field.key)}
        <label>
          <span>{label(field.key)}</span>
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
    <label for="{uid}-listen-on-lan" class="switch-row">
      <span class="text">
        <span id="{uid}-listen-on-lan-name">{strings.settings.listenOnLan}</span><InfoTip topic={strings.settings.listenOnLan} text={strings.settings.listenOnLanHint} />
      </span>
      <input id="{uid}-listen-on-lan" aria-labelledby="{uid}-listen-on-lan-name" type="checkbox" role="switch" data-testid="setting-listen-on-lan"
        checked={store.settings?.listenOnLan ?? false} disabled={!store.settings}
        onchange={(event) => void toggle('listenOnLan', event.currentTarget)} />
    </label>
    <label class="switch-row">
      <span class="text">
        {strings.settings.asyncQuestions}
        <span class="hint">{strings.settings.asyncQuestionsHint}</span>
      </span>
      <input type="checkbox" role="switch" data-testid="setting-async-questions"
        checked={store.settings?.asyncQuestions ?? true} disabled={!store.settings}
        onchange={(event) => void toggle('asyncQuestions', event.currentTarget)} />
    </label>
    <div class="actions">
      <button type="button" class="primary" data-testid="scheduler-save" disabled={!allValid || saving || !store.settings} onclick={() => void save()}>{strings.settings.save}</button>
      {#if savedAt !== null}
        <span class="muted" data-testid="scheduler-saved">{strings.settings.saved} {time(savedAt)}</span>
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
