<script lang="ts">
  import { ArrowRight, Settings2, ShieldAlert } from '@lucide/svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { currentSetting, experimentOf, isExperimentKey, type QuestionAnswer, type Settings, type SettingAsk } from '@boite/contracts';
  import { readExperiments, setExperiment, subscribeExperiments } from '../lib/experiments';
  import { keepFocus } from '../lib/focus';
  import { desktopSettings } from '../lib/settings-tabs';
  import { retiredHint, settingHeading, settingHint, settingLabel, settingPlaceText, settingsReachable, settingValueText } from '../lib/setting-requests';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { GroupLinks } from '../lib/group-links.svelte';
  import { workspace } from '../lib/workspace.svelte';
  import InfoTip from './InfoTip.svelte';

  /**
   * A settings card an agent put in the conversation (`boite settings
   * request|open`). A change is made right here: a true-or-false setting
   * draws its switch, any other value an Apply. The switch or Apply goes
   * through `settings.set` like the Settings page, or flips this device's
   * experiment, and the core closes the card once the setting moved, whoever
   * moved it. A card about another machine of the group writes there,
   * through that machine's Store, and its core tells this one.
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

  const uid = $props.id();
  let busy = $state(false);
  /** The same test Settings makes to draw the phone's own page (`SettingsShell.svelte`). */
  const narrow = new MediaQuery('(max-width: 720px)');
  const phone = $derived(!desktopSettings(narrow.current));

  const change = $derived(setting.kind === 'change' ? setting : null);
  /** An experiment is this device's own switch, which any of the user's devices flips for itself. */
  const experiment = $derived(change === null ? null : experimentOf(change.key));
  /** An experiment this build no longer lists: it graduated, and the card can only be refused. */
  const retired = $derived(change !== null && experiment === null && isExperimentKey(change.key));
  let experiments = $state(readExperiments());
  $effect(() => subscribeExperiments((enabled) => { experiments = enabled; }));
  /** True or false: the card draws the switch itself. */
  const toggle = $derived(change !== null && typeof change.value === 'boolean');
  /** The machine of the group a card is about, when this client is connected to it; else the card's own machine. */
  const remote = $derived(change?.machine === undefined ? null : workspace.machines.find((machine) => GroupLinks.coreOf(machine) === change.machine?.coreId)?.store ?? null);
  const away = $derived(change?.machine !== undefined && (remote === null || remote.connection !== 'ready'));
  const holder = $derived(remote ?? store);
  /** What the switch shows now, from this device or the core's settings. */
  const now = $derived(change === null ? null : experiment !== null ? experiments.includes(experiment) : retired || away ? change.previous : (holder.settings === null ? change.previous : currentSetting(change.key, holder.settings, null)));
  const canApply = $derived(change !== null && !retired && !away && (experiment !== null || holder.owner));
  /** This client's Settings has the card: Show and Open land on it rather than on Home. */
  const reachable = $derived(settingsReachable(setting, { owner: store.owner, phone }));
  const place = $derived([settingPlaceText(setting, store.providers), change?.machine?.name].filter(Boolean).join(' › '));
  const heading = $derived(settingHeading(setting));
  const label = $derived(change ? settingLabel(change.key) : '');
  const hint = $derived(change ? settingHint(change.key) : null);

  function value(raw: unknown): string {
    return change ? settingValueText(change.key, raw, store.providers) : '';
  }

  /** The core settles the card when the value lands; until then it stays busy. */
  async function apply(next: unknown): Promise<boolean> {
    if (!change || busy || !canApply) return false;
    if (experiment !== null) {
      // The app reports the flip to the core, which settles the card. The
      // switch stays free: it shows this device, and a flip that settles
      // nothing (offline, an old core) must not leave it stuck.
      setExperiment(experiment, next === true);
      return true;
    }
    busy = true;
    if (await holder.saveSettings({ [change.key]: next } as Partial<Settings>)) return true;
    busy = false;
    return false;
  }

  async function flip(input: HTMLInputElement): Promise<void> {
    const wanted = input.checked;
    if (!(await apply(wanted))) input.checked = now === true;
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
    return `${label}: ${value(shown)}`;
  }
</script>

<!-- An answer this client just sent clears the pending list before the card's answer arrives: it stays busy until then. -->
{#if answer !== null || (!pending && !busy)}
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

    {#if change && toggle}
      <div class="delta toggle" data-testid="setting-toggle">
        <span class="name ui-label-box"><span class="ui-label" id="{uid}-name">{label}</span>{#if hint}<InfoTip topic={label} text={hint} />{/if}</span>
        <input type="checkbox" role="switch" aria-labelledby="{uid}-name" data-testid="setting-switch" checked={now === true} disabled={busy || !canApply} onchange={(event) => flip(event.currentTarget)} />
      </div>
    {:else if change}
      <div class="delta" data-testid="setting-delta">
        <span class="name">{label}</span>
        <span class="values">
          <span class="old" data-testid="setting-previous">{value(change.previous)}</span>
          <ArrowRight size={14} strokeWidth={1.75} aria-label={strings.settingRequest.to} />
          <span class="new" data-testid="setting-proposed">{value(change.value)}</span>
        </span>
      </div>
    {/if}
    <p class="place ui-label" data-testid="setting-place">{place}</p>
    {#if retired}
      <p class="hint" data-testid="setting-retired-hint">{retiredHint(change?.key ?? '')}</p>
    {:else if away && change?.machine}
      <p class="hint" data-testid="setting-machine-away">{fill(strings.settingRequest.machineAway, { machine: change.machine.name })}</p>
    {:else if change && !canApply}
      <p class="hint" data-testid="setting-guest-hint">{strings.settingRequest.guestHint}</p>
    {:else if !reachable && !canApply}
      <p class="hint" data-testid="setting-elsewhere-hint">{strings.settingRequest.elsewhere}</p>
    {:else if change?.sensitive}
      <p class="hint" data-testid="setting-sensitive-hint">{strings.settingRequest.sensitiveHint}</p>
    {/if}

    <div class="actions">
      {#if setting.kind === 'open'}
        {#if reachable}
          <button type="button" class="primary" data-testid="setting-open" disabled={busy} onmousedown={keepFocus} onclick={() => answerWith('open')}><span class="ui-label">{strings.settingRequest.open}</span></button>
        {/if}
        <button type="button" class="ghost" data-testid="setting-refuse" disabled={busy} onmousedown={keepFocus} onclick={() => answerWith('refuse')}><span class="ui-label">{strings.settingRequest.dismiss}</span></button>
      {:else}
        {#if canApply && !toggle}
          <button type="button" class="primary" data-testid="setting-apply" disabled={busy} onmousedown={keepFocus} onclick={() => apply(change?.value)}><span class="ui-label">{strings.settingRequest.apply}</span></button>
        {/if}
        <!-- A paired device has no owner's page to show it on, and a phone lacks some cards. -->
        {#if canApply && reachable}
          <button type="button" class="ghost" data-testid="setting-show" onmousedown={keepFocus} onclick={show}><span class="ui-label">{strings.settingRequest.show}</span></button>
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
  .toggle { flex-wrap: nowrap; }
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
