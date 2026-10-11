<script lang="ts">
  import { ArrowRight, Settings2, ShieldAlert } from '@lucide/svelte';
  import type { QuestionAnswer, Settings, SettingAsk } from '@boite/contracts';
  import { keepFocus } from '../lib/focus';
  import { settingHeading, settingLabel, settingPlaceText, settingValueText } from '../lib/setting-requests';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /**
   * A settings card an agent put in the conversation (`boite settings
   * request|open`). It writes nothing by itself: Apply goes through
   * `settings.set` like the Settings page, and the core closes the card once
   * the setting moved, whoever moved it. A sensitive setting has no Apply; the
   * card opens its page instead.
   */
  let {
    store,
    text,
    setting,
    answer,
    pending,
    docked = false,
    respond
  }: {
    store: Store;
    /** The agent's reason. */
    text: string;
    setting: SettingAsk;
    answer: QuestionAnswer | null;
    /** False on a card that closed without an answer. */
    pending: boolean;
    /** Drawn inside the dock above the composer, whose own row names it: no frame, no heading. */
    docked?: boolean;
    /** Answers the card with `refuse` or `open`. False gives it back. */
    respond: (optionId: 'refuse' | 'open') => Promise<unknown>;
  } = $props();

  let busy = $state(false);

  const change = $derived(setting.kind === 'change' ? setting : null);
  const canApply = $derived(change !== null && !change.sensitive && store.owner);
  const place = $derived(settingPlaceText(setting, store.providers));
  const heading = $derived(settingHeading(setting));

  function value(raw: unknown): string {
    return change ? settingValueText(change.key, raw, store.providers) : '';
  }

  async function apply(): Promise<void> {
    if (!change || busy) return;
    busy = true;
    // The core settles the card when the value lands; until then it stays busy.
    if (!(await store.saveSettings({ [change.key]: change.value } as Partial<Settings>))) busy = false;
  }

  function show(): void {
    store.showSettings(setting.page, setting.section, { flash: true });
  }

  async function answerWith(optionId: 'refuse' | 'open'): Promise<void> {
    if (busy) return;
    busy = true;
    if (optionId === 'open') show();
    if ((await respond(optionId)) === false) busy = false;
  }

  /** What the closed card says it came to. */
  function verdict(given: QuestionAnswer): string {
    const outcome = given.optionIds[0];
    if (outcome === 'applied') return strings.settingRequest.applied;
    if (outcome === 'changed') return fill(strings.settingRequest.changed, { value: value(given.value) });
    if (outcome === 'open') return strings.settingRequest.opened;
    return setting.kind === 'open' ? strings.settingRequest.dismissed : strings.settingRequest.refused;
  }

  function subject(given: QuestionAnswer | null): string {
    if (!change) return place;
    const shown = given?.optionIds[0] === 'applied' ? change.value : given?.optionIds[0] === 'changed' ? given.value : change.previous;
    return `${settingLabel(change.key)}: ${value(shown)}`;
  }
</script>

{#if answer !== null || !pending}
  <div class="setting-card resolved" data-testid="setting-card" data-state={answer === null ? 'closed' : 'answered'} data-outcome={answer?.optionIds[0]} title={text}>
    <span class="glyph"><Settings2 size={15} strokeWidth={1.75} /></span>
    <span class="verdict ui-label" data-testid="setting-verdict">{answer === null ? strings.settingRequest.closed : verdict(answer)}</span>
    <span class="given ui-label" data-testid="setting-subject">{subject(answer)}</span>
  </div>
{:else}
  <div class="setting-card" class:docked class:sensitive={setting.kind === 'change' && setting.sensitive} data-testid="setting-card" data-state="pending" data-kind={setting.kind} role="group" aria-label={heading}>
    {#if !docked}
      <div class="head">
        <span class="glyph">
          {#if setting.kind === 'change' && setting.sensitive}<ShieldAlert size={15} strokeWidth={1.75} />{:else}<Settings2 size={15} strokeWidth={1.75} />{/if}
        </span>
        <span class="muted ui-label">{heading}</span>
      </div>
    {/if}
    <p class="reason" data-testid="setting-reason">{text}</p>

    {#if change}
      <div class="delta" data-testid="setting-delta">
        <span class="name">{settingLabel(change.key)}</span>
        <span class="values">
          <span class="old" data-testid="setting-previous">{value(change.previous)}</span>
          <ArrowRight size={14} strokeWidth={1.75} aria-label={strings.settingRequest.to} />
          <span class="new" data-testid="setting-proposed">{value(change.value)}</span>
        </span>
      </div>
    {/if}
    <p class="place ui-label" data-testid="setting-place">{place}</p>
    {#if change && !store.owner}
      <p class="hint" data-testid="setting-guest-hint">{strings.settingRequest.guestHint}</p>
    {:else if change?.sensitive}
      <p class="hint" data-testid="setting-sensitive-hint">{strings.settingRequest.sensitiveHint}</p>
    {/if}

    <div class="actions">
      {#if setting.kind === 'open'}
        <button type="button" class="primary" data-testid="setting-open" disabled={busy} onmousedown={keepFocus} onclick={() => answerWith('open')}><span class="ui-label">{strings.settingRequest.open}</span></button>
        <button type="button" class="ghost" data-testid="setting-refuse" disabled={busy} onmousedown={keepFocus} onclick={() => answerWith('refuse')}><span class="ui-label">{strings.settingRequest.dismiss}</span></button>
      {:else}
        {#if canApply}
          <button type="button" class="primary" data-testid="setting-apply" disabled={busy} onmousedown={keepFocus} onclick={apply}><span class="ui-label">{strings.settingRequest.apply}</span></button>
        {/if}
        <!-- A paired device has no owner's page to show it on. -->
        {#if store.owner}
          <button type="button" class={canApply ? 'ghost' : 'primary'} data-testid="setting-show" onmousedown={keepFocus} onclick={show}><span class="ui-label">{canApply ? strings.settingRequest.show : strings.settingRequest.open}</span></button>
        {/if}
        <button type="button" class="ghost" data-testid="setting-refuse" disabled={busy} onmousedown={keepFocus} onclick={() => answerWith('refuse')}><span class="ui-label">{strings.settingRequest.refuse}</span></button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .setting-card {
    border: 1px solid var(--color-edge);
    border-left-style: dashed;
    border-radius: var(--radius-md);
    background: var(--color-surface);
    box-shadow: var(--shadow-e1);
    padding: 8px 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .setting-card.docked {
    border: none;
    background: transparent;
    box-shadow: none;
    padding: 4px 10px 8px;
  }

  .head { display: flex; align-items: center; gap: 6px; }
  .glyph { display: inline-flex; flex: none; color: var(--color-accent); }
  .sensitive .glyph { color: var(--color-danger); }

  .reason { margin: 0; font-weight: 500; white-space: pre-wrap; overflow-wrap: anywhere; }

  .delta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 6px 12px;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--color-surface-2);
    font-size: var(--text-sm);
  }
  .name { min-width: 0; overflow-wrap: anywhere; }
  .values { display: inline-flex; align-items: center; gap: 8px; color: var(--color-subtle); min-width: 0; }
  .old { color: var(--color-muted-foreground); text-decoration: line-through; overflow-wrap: anywhere; }
  .new { color: var(--color-accent); font-weight: 600; overflow-wrap: anywhere; }
  .sensitive .new { color: var(--color-danger); }

  .place { margin: 0; font-size: var(--text-xs); color: var(--color-subtle); }
  .hint { margin: 0; font-size: var(--text-sm); color: var(--color-muted-foreground); }

  .actions { display: flex; flex-wrap: wrap; gap: 6px; }

  /* Closed: one quiet row in the timeline, like an answered question. */
  .setting-card.resolved {
    flex-direction: row;
    align-items: center;
    gap: var(--activity-gap);
    border: none;
    background: transparent;
    box-shadow: none;
    min-height: var(--control);
    padding: var(--activity-padding);
    color: var(--color-muted-foreground);
  }
  .resolved .glyph { width: var(--activity-glyph); justify-content: center; color: var(--color-subtle); }
  .verdict { flex: none; font-size: var(--text-sm); }
  .given { min-width: 0; font-size: var(--text-sm); color: var(--color-foreground); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
</style>
