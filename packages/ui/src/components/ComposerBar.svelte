<script lang="ts">
  import { ArrowUp, GitBranch, Paperclip, ShieldAlert, ShieldCheck, Square } from '@lucide/svelte';
  import { tick } from 'svelte';
  import type { PermissionMode, ProviderSummary } from '@boite/contracts';
  import { tokens as formatTokens } from '../lib/format';
  import { confirm } from '../lib/confirm.svelte';
  import { switchDropsHistory, switchResetsCache, type CacheKey } from '../lib/switch-warning';
  import { modeHint, modeLabel, modesFor, shownMode } from '../lib/permission-modes';
  import { fill, strings } from '../lib/strings';
  import type { Choice, PickPatch, Store } from '../lib/store.svelte';
  import { work } from '../lib/work-prefs.svelte';
  import EffortSlider from './EffortSlider.svelte';
  import Menu from './Menu.svelte';
  import ModelPicker from './ModelPicker.svelte';
  import Dictation from './Dictation.svelte';
  import ComposerOptions from './ComposerOptions.svelte';

  /**
   * The row under the composer's box: the model, effort, mode and worktree
   * chips (folded into Options on a phone), then stop, attach, dictation and
   * send. A pick on a thread is saved at once, after the switch warnings; on a
   * draft the whole choice is remembered. `choice`, `picking` and `dictating`
   * are the composer's, bound here.
   */
  let {
    store,
    key,
    provider,
    canSend,
    choice = $bindable(),
    picking = $bindable(),
    dictating = $bindable(),
    onsubmit,
    onfiles,
    onpreview,
    ontranscript
  }: {
    store: Store;
    /** The open thread's id, or the draft's stash key. */
    key: string;
    provider: ProviderSummary | null | undefined;
    canSend: boolean;
    choice: Choice | null;
    picking: boolean;
    dictating: boolean;
    onsubmit: () => void;
    onfiles: (files: File[]) => void;
    onpreview: (text: string, status: string, error: boolean) => void;
    ontranscript: (transcript: string) => void;
  } = $props();

  let picker = $state<HTMLInputElement | undefined>(undefined);
  let bar = $state<HTMLDivElement | undefined>(undefined);

  let bound = $derived(store.openThread !== null);
  /** Every agent can read uploaded files through its local tools. */
  let canAttach = $derived(provider !== null && provider !== undefined);

  // Older modes keep their execution policy until the user makes a choice.
  let displayedMode = $derived<PermissionMode>(shownMode(choice?.permissionMode ?? 'default', provider));
  let modes = $derived(modesFor(provider));
  /** The chosen account answered that it is signed out: the next send would fail on it. */
  let signedOut = $derived.by(() => {
    const account = choice ? store.accountOf(choice.accountId) : null;
    return account?.status === 'unauthenticated' ? account : null;
  });
  let modeItems = $derived(
    modes.map((mode) => ({
      id: mode,
      label: modeLabel(mode, provider),
      hint: modeHint(mode, provider),
      active: displayedMode === mode
    }))
  );
  // The worktree switch exists where the core can honour it: a draft on a git repository.
  let draftRepository = $derived(
    store.draft && !store.draftInDrafts ? store.projects.find((project) => project.id === store.draft?.projectId)?.repository !== false : false
  );

  // The reasoning chip belongs to the model the choice is on, and a model that
  // offers no scale (an agent that keeps its own) gets no chip at all.
  let effortLevels = $derived((store.modelOf(choice)?.effort?.levels ?? []).filter(level => provider?.protocol === 'claude-sdk' || level.id !== 'ultrathink'));
  let speeds = $derived(store.modelOf(choice)?.speeds ?? []);
  let activeEffort = $derived(choice?.effort ?? store.modelOf(choice)?.effort?.default ?? null);
  // A chip stays in the bar when this device pinned it, or when it holds
  // something other than the default: a choice nobody can see is a trap.
  let effortChip = $derived(
    (effortLevels.length > 0 || speeds.length > 0) &&
      (work.current.pins.effort || activeEffort !== (store.modelOf(choice)?.effort?.default ?? null) || Boolean(choice?.speed))
  );
  let worktreeChip = $derived(Boolean(store.draft && draftRepository && (work.current.pins.worktree || store.draft.worktree)));

  /** A null effort runs at the model's own default, not at a preset the client configured. */
  function cacheKey(selection: Choice): CacheKey {
    return {
      accountId: selection.accountId,
      model: selection.model ?? null,
      effort: selection.effort ?? store.modelOf(selection)?.effort?.default ?? null,
      speed: selection.speed ?? null,
    };
  }

  /** On a thread only the model and the effort change and they are saved at once; on a draft the whole choice is remembered. */
  async function pick(patch: PickPatch) {
    if (!choice || picking) return;
    const thread = store.openThread;

    if (thread) {
      const changedModel = patch.model !== undefined || patch.accountId !== undefined;
      const target = { ...choice, ...patch, effort: patch.effort !== undefined ? patch.effort : changedModel ? null : choice.effort, speed: patch.speed !== undefined ? patch.speed : changedModel ? null : choice.speed ?? null };
      picking = true;
      try {
        if (switchDropsHistory(thread, target.accountId)) {
          const from = store.providers.find((entry) => entry.id === thread.providerId)?.name ?? thread.providerId;
          const to = store.providers.find((entry) => entry.id === target.providerId)?.name ?? target.providerId;
          const go = await confirm.ask({
            title: fill(strings.composer.switchTitle, { tokens: formatTokens(thread.context?.tokens ?? 0), provider: to }),
            body: fill(strings.composer.switchBody, { provider: to }),
            confirmLabel: strings.composer.switchConfirm,
            cancelLabel: fill(strings.composer.switchCancel, { provider: from }),
          });
          if (!go) return;
        } else if (switchResetsCache(thread, cacheKey(choice), cacheKey(target))) {
          const go = await confirm.ask({
            title: fill(strings.composer.cacheTitle, { tokens: formatTokens(thread.context?.tokens ?? 0) }),
            body: strings.composer.cacheBody,
            confirmLabel: strings.composer.cacheConfirm,
            cancelLabel: strings.composer.cacheCancel,
          });
          if (!go) return;
        }
        const accepted = await store.update(thread.id, {
          accountId: target.accountId, model: target.model, effort: target.effort, speed: target.speed,
          expectedSelectionVersion: thread.selectionVersion ?? 0,
        });
        if (accepted) store.remember(target);
      } finally { picking = false; }
      return;
    }

    if (patch.speed !== undefined) { choice = { ...choice, speed: patch.speed }; store.remember(choice); return; }
    // An effort alone: the model stays, so nothing else moves.
    if (patch.effort !== undefined) {
      if (patch.effort === choice.effort) return;
      choice = { ...choice, effort: patch.effort };
      store.remember(choice);
      return;
    }

    // Another model runs on its own scale, so the effort goes back to that model's default.
    const target = { ...choice, ...patch };
    choice = { ...target, effort: store.defaultEffortOf(target.providerId, target.accountId, target.model), speed: null };
    store.remember(choice);
  }

  function pickEffort(id: string) {
    pick({ effort: id });
  }

  function pickMode(id: string) {
    const mode = id as PermissionMode;
    if (!choice || picking) return;
    choice = { ...choice, permissionMode: mode };
    if (bound) void store.setPermissionMode(mode);
    else store.remember(choice);
  }

  function onchoose(event: Event) {
    const field = event.currentTarget as HTMLInputElement;
    const files = Array.from(field.files ?? []);
    // The same picture picked twice in a row must fire `change` both times.
    field.value = '';
    onfiles(files);
  }

  /** The chip's own trigger opens its menu: one popover, owned by one component. */
  export async function openChip(testid: string) {
    await tick();
    const composer = bar?.closest('[data-testid="composer"]');
    if (window.matchMedia('(max-width: 720px)').matches && testid !== 'composer-picker') testid = 'composer-options';
    // An unpinned effort lives in the Options menu.
    else if (testid === 'composer-effort' && !effortChip) testid = 'composer-more';
    composer?.querySelector<HTMLElement>(`[data-testid="${testid}"]`)?.click();
  }
</script>

<div class="bar" bind:this={bar}>
  {#key `${key}:${store.draft?.projectId ?? ''}`}
  <ComposerOptions busy={picking} levels={effortLevels} effort={activeEffort} {speeds} speed={choice?.speed ?? null} {modes} modeLabel={(mode) => modeLabel(mode, provider)} modeHint={(mode) => modeHint(mode, provider)} mode={displayedMode} worktree={store.draft && draftRepository ? store.draft.worktree : null} {canAttach} onattach={() => picker?.click()} oneffort={pickEffort} onspeed={(speed) => void pick({ speed })} onmode={pickMode} onworktree={() => store.setDraftWorktree(!store.draft?.worktree)} />
  {/key}
  <div class="chips">
    <ModelPicker {store} {choice} disabled={picking} onpick={pick} />
    {#if signedOut && store.owner}
      <button type="button" class="chip signed-out" data-testid="composer-reconnect" title={fill(strings.connect.signedOut, { provider: provider?.name ?? '' })} onclick={() => store.openConnect(signedOut.providerId, signedOut.id)}>{strings.connect.reconnect}</button>
    {/if}

    <div class="desktop-options">
    {#if effortChip}
      <EffortSlider levels={effortLevels} active={activeEffort} onpick={pickEffort} {speeds} speed={choice?.speed ?? null} onspeed={(speed) => void pick({ speed })} />
    {/if}

    {#if modes.length > 0}
      <Menu items={modeItems} onpick={pickMode} label={strings.composer.mode} testid="composer-mode" align="end">
        {#if displayedMode === 'bypassPermissions'}<span class="open-mode"><ShieldAlert size={14} strokeWidth={1.75} /></span>{:else}<ShieldCheck size={14} strokeWidth={1.75} />{/if}
        {modeLabel(displayedMode, provider)}
      </Menu>
    {/if}

    <!-- A thread keeps its directory, so the switch exists on a draft alone. -->
    {#if store.draft && worktreeChip}
      <button
        type="button"
        class="chip worktree"
        class:on={store.draft.worktree}
        data-testid="composer-worktree"
        title={store.draft.worktree ? strings.composer.worktreeOn : strings.composer.worktreeOff}
        aria-label={strings.composer.worktree}
        aria-pressed={store.draft.worktree}
        onclick={() => store.setDraftWorktree(!store.draft?.worktree)}
      >
        <GitBranch size={14} strokeWidth={1.75} />
        {strings.composer.worktree}
      </button>
    {/if}

    {#key `${key}:${store.draft?.projectId ?? ''}`}
      <ComposerOptions variant="desktop" busy={picking} levels={effortLevels} effort={activeEffort} {speeds} speed={choice?.speed ?? null} {modes} modeLabel={(mode) => modeLabel(mode, provider)} modeHint={(mode) => modeHint(mode, provider)} mode={displayedMode} worktree={store.draft && draftRepository ? store.draft.worktree : null} {canAttach} pins={work.current.pins} onattach={() => picker?.click()} oneffort={pickEffort} onspeed={(speed) => void pick({ speed })} onmode={pickMode} onworktree={() => store.setDraftWorktree(!store.draft?.worktree)} onpin={(id, on) => work.pin(id, on)} />
    {/key}
    </div>
  </div>



  {#if store.busy}
    <button type="button" class="icon stop" data-testid="composer-stop" title={strings.composer.stop} aria-label={strings.composer.stop} onclick={() => void store.stop()}>
      <Square size={12} strokeWidth={2.5} />
    </button>
  {/if}
    {#if canAttach}
      <button
        type="button"
        class="icon attach"
        data-testid="composer-attach"
        title={strings.composer.attach}
        aria-label={strings.composer.attach}
        onclick={() => picker?.click()}
      >
        <Paperclip size={14} strokeWidth={1.75} />
      </button>
      <input
        bind:this={picker}
        class="file"
        type="file"
        multiple
        tabindex="-1"
        aria-hidden="true"
        data-testid="composer-file"
        onchange={onchoose}
      />
    {/if}


  {#key store}
    {#key `${key}:${store.draft?.projectId ?? ''}`}
      <Dictation {store} onbusy={(busy) => dictating = busy} {onpreview} ontext={ontranscript} />
    {/key}
  {/key}
  <button
    type="button"
    class="primary icon send"
    data-testid="composer-send"
    title={strings.composer.send}
    aria-label={strings.composer.send}
    disabled={!canSend}
    onclick={() => onsubmit()}
  >
    <ArrowUp size={16} strokeWidth={2.25} />
  </button>
</div>

<style>
  /* The button in the chip bar is what opens it; the field itself never shows. */
  .file {
    display: none;
  }

  .attach {
    padding: 0 7px;
  }

  /* Off it reads like the other chips; on it takes the active fill, the same as a pressed tab. */
  .open-mode { display: inline-flex; color: var(--color-live); }
  .chip.signed-out { color: var(--color-live); }

  .worktree.on {
    background: var(--color-active);
    border-color: var(--color-active);
    color: var(--color-foreground);
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px 8px 10px;
  }

  .chips {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    min-width: 0;
  }
  .desktop-options { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }

  .chips :global(.trigger), .chips :global(.speed), .chips .worktree {
    height: var(--control);
    padding: 0 10px;
    gap: 7px;
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: 500;
  }

  .chips :global(.trigger) {
    border-color: var(--color-edge);
    background: var(--color-surface);
    color: var(--color-foreground);
  }

  /* Nothing to pick yet: the one chip that gets somewhere wears the accent. */
  .chips :global(.trigger.connect) {
    border-color: transparent;
    background: var(--color-accent-soft);
    color: var(--color-accent);
  }

  .chips :global(.trigger:hover) {
    background: var(--color-surface-3);
  }


  .send,
  .stop {
    margin-left: auto;
    width: var(--control);
    height: var(--control);
    border-radius: var(--radius-md);
    flex: none;
  }

  .stop {
    color: var(--color-foreground);
  }

  @media (max-width: 720px) {
    .bar { gap: 2px; padding: 0 8px 6px; }
    .desktop-options, .attach { display: none; }
    .chips { flex: 1; flex-wrap: nowrap; }
    .chips :global(.picker) { min-width: 0; max-width: 100%; }
    .chips :global(.picker > .trigger) { max-width: 100%; height: var(--touch-target); padding: 0 6px; border: none; background: transparent; font-weight: 500; color: var(--color-muted-foreground); }
    .chips :global(.picker > .trigger > .label) { min-width: 0; max-width: none; }
    .chips :global(.picker > .trigger.connect) { padding: 0 12px; border-radius: var(--radius-md); background: var(--color-accent-soft); color: var(--color-accent); }
    .send, .stop { border-radius: 50%; margin-left: 2px; }
    /* The composer carries `dictating` while a dictation runs. */
    :global(.dictating) .send { display: none; }
  }
</style>
