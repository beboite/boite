<script lang="ts">
  import { ArrowUp, ShieldCheck, Square } from '@lucide/svelte';
  import type { PermissionMode } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import type { Choice, Store } from '../lib/store.svelte';
  import Menu from './Menu.svelte';
  import ModelPicker from './ModelPicker.svelte';

  let { store }: { store: Store } = $props();

  const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk'];
  const MAX_LINES = 8;

  let text = $state('');
  let queued = $state<string | null>(null);
  let choice = $state<Choice | null>(null);
  let box = $state<HTMLTextAreaElement | undefined>(undefined);

  /** The chips follow the open thread, or the remembered choice on a draft. */
  $effect(() => {
    const thread = store.openThread;
    const draft = store.draft;
    store.providers;
    store.accounts;
    if (thread) {
      choice = {
        providerId: thread.providerId,
        accountId: thread.accountId,
        permissionMode: thread.permissionMode,
        model: thread.model
      };
    } else if (draft) {
      choice = store.defaultChoice();
    } else {
      choice = null;
    }
  });

  /** A new draft or thread gets the keyboard. */
  $effect(() => {
    store.openThread?.id;
    store.draft;
    box?.focus();
  });

  /** What was typed during a turn goes out once the turn ends. */
  $effect(() => {
    if (!store.busy && queued !== null && choice) {
      const prompt = queued;
      queued = null;
      void store.submit(prompt, choice);
    }
  });

  let provider = $derived(choice ? store.providerOf(choice.providerId) : null);
  let bound = $derived(store.openThread !== null);
  let canSend = $derived(text.trim().length > 0 && choice !== null && !store.busy);

  let placeholder = $derived(
    store.openProject && provider
      ? fill(strings.composer.placeholder, { provider: provider.name, project: store.openProject.name })
      : strings.composer.placeholderNoProject
  );

  let modeItems = $derived(
    MODES.map((mode) => ({
      id: mode,
      label: strings.permissionMode[mode],
      hint: strings.permissionModeLong[mode],
      active: choice?.permissionMode === mode
    }))
  );

  /** On a thread only the model changes and it is saved at once; on a draft the whole choice is remembered. */
  function pick(patch: { providerId: string; accountId: string; model: string | null }) {
    if (!choice) return;
    const thread = store.openThread;
    if (thread) {
      if (patch.model === choice.model) return;
      choice = { ...choice, model: patch.model };
      void store.update(thread.id, { model: patch.model ?? '' });
      return;
    }
    choice = { ...choice, ...patch };
    store.remember(choice);
  }

  function pickMode(id: string) {
    const mode = id as PermissionMode;
    if (!choice) return;
    choice = { ...choice, permissionMode: mode };
    if (bound) void store.setPermissionMode(mode);
    else store.remember(choice);
  }

  function grow() {
    const el = box;
    if (!el) return;
    el.style.height = 'auto';
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.height = `${Math.min(el.scrollHeight, line * MAX_LINES + 16)}px`;
  }

  function submit() {
    const prompt = text;
    if (prompt.trim().length === 0 || !choice) return;
    text = '';
    requestAnimationFrame(grow);
    if (store.busy) {
      queued = queued === null ? prompt : `${queued}\n${prompt}`;
      return;
    }
    void store.submit(prompt, choice);
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    } else if (event.key === 'Escape' && store.busy) {
      event.preventDefault();
      void store.stop();
    }
  }
</script>

<div class="composer-wrap">
  <div class="composer" data-testid="composer">
    {#if queued !== null}
      <div class="queued subtle" data-testid="composer-queued">{strings.composer.queued}</div>
    {/if}
    <textarea
      bind:this={box}
      bind:value={text}
      oninput={grow}
      {onkeydown}
      rows="1"
      {placeholder}
      aria-label={placeholder}
      data-testid="composer-input"
      spellcheck="true"
    ></textarea>

    <div class="bar">
      <div class="chips">
        <ModelPicker {store} {choice} locked={bound} onpick={pick} />

        <Menu items={modeItems} onpick={pickMode} label={strings.composer.mode} testid="composer-mode">
          <ShieldCheck size={13} strokeWidth={1.75} />
          {choice ? strings.permissionMode[choice.permissionMode] : strings.permissionMode.default}
        </Menu>
      </div>

      <span class="hint subtle">{strings.composer.hint}</span>

      {#if store.busy}
        <button type="button" class="icon stop" data-testid="composer-stop" title={strings.composer.stop} aria-label={strings.composer.stop} onclick={() => void store.stop()}>
          <Square size={12} strokeWidth={2.5} />
        </button>
      {/if}
      <button
        type="button"
        class="primary icon send"
        data-testid="composer-send"
        title={strings.composer.send}
        aria-label={strings.composer.send}
        disabled={!canSend && !(store.busy && text.trim().length > 0)}
        onclick={submit}
      >
        <ArrowUp size={16} strokeWidth={2.25} />
      </button>
    </div>
  </div>
</div>

<style>
  .composer-wrap {
    flex: none;
    padding: 8px 20px 16px;
  }

  .composer {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: var(--content);
    margin: 0 auto;
    background: var(--color-surface);
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-e1);
    transition: border-color var(--dur-2) var(--ease-out-quint);
  }

  .composer:focus-within {
    border-color: color-mix(in srgb, var(--color-foreground) 35%, var(--color-edge));
  }

  .queued {
    padding: 6px 14px 0;
    font-size: var(--text-xs);
  }

  textarea {
    width: 100%;
    min-height: 44px;
    max-height: 200px;
    padding: 12px 14px 6px;
    border: none;
    background: transparent;
    font-size: var(--text-base);
    line-height: 1.5;
  }

  textarea:focus {
    outline: none;
    border: none;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px 8px 10px;
  }

  .chips {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
    min-width: 0;
  }

  .hint {
    margin-left: auto;
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .send,
  .stop {
    width: 30px;
    height: 30px;
    border-radius: var(--radius-md);
    flex: none;
  }

  .stop {
    color: var(--color-foreground);
  }

  @media (max-width: 720px) {
    .composer-wrap {
      padding: 6px 10px 10px;
    }

    .hint {
      display: none;
    }
  }
</style>
