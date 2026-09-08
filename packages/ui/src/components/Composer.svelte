<script lang="ts">
  import { ArrowUp, Brain, ShieldCheck, Square } from '@lucide/svelte';
  import type { PermissionMode } from '@boite/contracts';
  import { clearStash, DRAFT_STASH_KEY, readStash, writeStash } from '../lib/prefs';
  import { fill, strings } from '../lib/strings';
  import type { Choice, PickPatch, Store } from '../lib/store.svelte';
  import Menu from './Menu.svelte';
  import ModelPicker from './ModelPicker.svelte';

  let { store }: { store: Store } = $props();

  const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk'];
  const MAX_LINES = 8;

  let text = $state('');
  let queued = $state<string | null>(null);
  let choice = $state<Choice | null>(null);
  let box = $state<HTMLTextAreaElement | undefined>(undefined);
  /** Where ArrowUp stands in this thread's sent prompts, or null outside recall. */
  let recall = $state<number | null>(null);

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
        model: thread.model,
        effort: thread.effort
      };
    } else if (draft) {
      choice = store.defaultChoice();
    } else {
      choice = null;
    }
  });

  /** A new draft or thread gets the keyboard, and the recall starts over. */
  $effect(() => {
    store.openThread?.id;
    store.draft;
    recall = null;
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

  /** This thread's own sent prompts, most recent first: what ArrowUp walks. */
  let sent = $derived(
    (store.openThread?.messages ?? [])
      .filter((message) => message.role === 'user')
      .map((message) =>
        message.parts
          .filter((part) => part.type === 'text')
          .map((part) => (part.type === 'text' ? part.text : ''))
          .join('\n')
          .trim()
      )
      .filter((prompt) => prompt.length > 0)
      .reverse()
  );

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

  // The reasoning chip belongs to the model the choice is on, and a model that
  // offers no scale (an agent that keeps its own) gets no chip at all.
  let effortLevels = $derived(store.modelOf(choice)?.effort?.levels ?? []);
  let activeEffort = $derived(choice?.effort ?? store.modelOf(choice)?.effort?.default ?? null);
  let effortLabel = $derived(effortLevels.find((level) => level.id === activeEffort)?.label ?? '');

  let effortItems = $derived(
    effortLevels.map((level) => ({
      id: level.id,
      label: level.label,
      hint: level.description,
      active: level.id === activeEffort
    }))
  );

  /** On a thread only the model and the effort change and they are saved at once; on a draft the whole choice is remembered. */
  function pick(patch: PickPatch) {
    if (!choice) return;
    const thread = store.openThread;

    // An effort alone: the model stays, so nothing else moves.
    if (patch.effort !== undefined) {
      if (patch.effort === choice.effort) return;
      choice = { ...choice, effort: patch.effort };
      if (thread) void store.update(thread.id, { effort: patch.effort });
      else store.remember(choice);
      return;
    }

    // Another model runs on its own scale, so the effort goes back to that model's default.
    if (thread) {
      if (patch.model === choice.model) return;
      choice = { ...choice, model: patch.model ?? null, effort: null };
      void store.update(thread.id, { model: patch.model ?? '', effort: null });
      return;
    }
    choice = { ...choice, ...patch, effort: null };
    store.remember(choice);
  }

  function pickEffort(id: string) {
    pick({ effort: id });
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

  /** Typing is the user's own, so it takes the composer out of recall. */
  function oninput() {
    recall = null;
    grow();
  }

  /** Writes a recalled or restored prompt in, caret at its end. */
  function put(value: string) {
    text = value;
    const el = box;
    if (el) {
      el.value = value;
      el.selectionStart = el.selectionEnd = value.length;
    }
    requestAnimationFrame(grow);
  }

  function submit() {
    const prompt = text;
    if (prompt.trim().length === 0 || !choice) return;
    text = '';
    recall = null;
    requestAnimationFrame(grow);
    if (store.busy) {
      queued = queued === null ? prompt : `${queued}\n${prompt}`;
      return;
    }
    void store.submit(prompt, choice);
  }

  /**
   * Ctrl+Enter: the same send, then a fresh draft on the same choice. A turn
   * that is still running only queues the text, and the queue goes out from
   * this thread, so that case stays what Enter does.
   */
  function submitAndDraft() {
    const prompt = text;
    if (prompt.trim().length === 0 || !choice || store.busy) {
      submit();
      return;
    }
    text = '';
    recall = null;
    requestAnimationFrame(grow);
    void store.submitAndDraft(prompt, choice);
  }

  /** ArrowUp: one prompt older, or nothing when the user typed the text themselves. */
  function older(): boolean {
    if (recall === null && text.length > 0) return false;
    const next = recall === null ? 0 : recall + 1;
    const prompt = sent[next];
    if (prompt === undefined) return recall !== null;
    recall = next;
    put(prompt);
    return true;
  }

  /** ArrowDown: one prompt newer, and past the newest the composer is empty again. */
  function newer(): boolean {
    if (recall === null) return false;
    const next = recall - 1;
    if (next < 0) {
      recall = null;
      put('');
      return true;
    }
    const prompt = sent[next];
    if (prompt === undefined) return true;
    recall = next;
    put(prompt);
    return true;
  }

  /** Ctrl+S: text goes aside for this thread, an empty composer takes it back. */
  function stash() {
    const key = store.openThread?.id ?? DRAFT_STASH_KEY;
    if (text.trim().length > 0) {
      writeStash(key, text);
      recall = null;
      put('');
      return;
    }
    const stashed = readStash(key);
    if (stashed === null) return;
    clearStash(key);
    recall = null;
    put(stashed);
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    const meta = event.ctrlKey || event.metaKey;
    if (meta && event.key === 'Enter') {
      event.preventDefault();
      submitAndDraft();
      return;
    }
    if (meta && event.key.toLowerCase() === 's' && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      stash();
      return;
    }
    if (meta || event.altKey) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    } else if (event.key === 'ArrowUp' && !event.shiftKey) {
      if (older()) event.preventDefault();
    } else if (event.key === 'ArrowDown' && !event.shiftKey) {
      if (newer()) event.preventDefault();
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
      {oninput}
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

        {#if effortLevels.length > 0}
          <Menu items={effortItems} onpick={pickEffort} label={strings.composer.reasoning} testid="composer-effort">
            <Brain size={13} strokeWidth={1.75} />
            {effortLabel}
          </Menu>
        {/if}

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
