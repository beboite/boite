<script lang="ts">
  import { ArrowUp, GitBranch, Paperclip, ShieldCheck, Square, X } from '@lucide/svelte';
  import { tick, untrack } from 'svelte';
  import type { ImageAttachment, PermissionMode } from '@boite/contracts';
  import { acceptAttachments, readImageFile } from '../lib/attachments';
  import { AGENT_PREFIX, appCommands, isAgentCommand, runCommand } from '../lib/commands.svelte';
  import { rankItems, type PaletteItem } from '../lib/palette';
  import { clearStash, DRAFT_STASH_KEY, readStash, writeStash } from '../lib/prefs';
  import { fill, strings } from '../lib/strings';
  import type { Choice, PickPatch, Store } from '../lib/store.svelte';
  import EffortSlider from './EffortSlider.svelte';
  import Menu from './Menu.svelte';
  import ModelPicker from './ModelPicker.svelte';
  import MentionMenu from './MentionMenu.svelte';
  import SlashMenu from './SlashMenu.svelte';

  /**
   * `centered` is the draft's placement: the parent stacks the composer under
   * the heading and centres the pair, so the wrapper drops the padding that
   * holds it off the bottom of the column. Same component, same box.
   */
  let { store, centered = false }: { store: Store; centered?: boolean } = $props();

  const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk'];
  const MAX_LINES = 8;

  let key = $derived(store.openThread?.id ?? DRAFT_STASH_KEY);
  let composer = $derived(store.composerStates[key]);
  let text = $derived(composer?.text ?? '');
  /** The images this prompt carries, the same array the strip above the box draws. */
  let attachments = $derived<ImageAttachment[]>(composer?.attachments ?? []);
  let choice = $state<Choice | null>(null);
  let box = $state<HTMLTextAreaElement | undefined>(undefined);
  let picker = $state<HTMLInputElement | undefined>(undefined);
  /** Where ArrowUp stands in this thread's sent prompts, or null outside recall. */
  let recall = $state<number | null>(null);
  /** The box has the keyboard: one of the two things that open the slash menu. */
  let focused = $state(false);
  /** Escape shuts the menu on text it keeps, until that text changes again. */
  let slashDismissed = $state(false);
  /** The row the keyboard is on in the slash menu. */
  let slashAt = $state(0);
  /** Where the caret stands in the text, kept for the mention menu. */
  let caret = $state(0);
  /** Escape shuts the mention menu on text it keeps, until that text changes again. */
  let mentionDismissed = $state(false);
  /** The row the keyboard is on in the mention menu. */
  let mentionAt = $state(0);
  /** The core's last page of files for the mention query. */
  let mentionItems = $state<PaletteItem[]>([]);
  /** How many matches the core held beyond that page. */
  let mentionMore = $state(0);
  /** The number of the last `projects.files` asked, so an older answer is dropped. */
  let mentionAsk = 0;
  const MENTION_PAGE = 30;
  const MENTION_DEBOUNCE_MS = 60;

  const inShell = window.__TAURI_INTERNALS__ !== undefined;
  /** The three commands the composer runs itself: each one opens a chip's menu. */
  const CHIP_COMMANDS: Record<string, { testid: string; description: string }> = {
    model: { testid: 'composer-picker', description: strings.slash.model },
    effort: { testid: 'composer-effort', description: strings.slash.effort },
    mode: { testid: 'composer-mode', description: strings.slash.mode }
  };

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

  /** Only this thread's next prompt goes out, after the previous turn ends. */
  $effect(() => {
    const state = composer;
    const threadId = store.openThread?.id;
    if (store.connection === 'ready' && !store.busy && threadId && state &&
        state.queued.length > 0 && !state.sending && !state.paused) {
      untrack(() => void drain(threadId, state));
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
  /** The attach button is only there for an agent that reads images. */
  let takesImages = $derived(provider?.capabilities.images ?? false);
  let canSend = $derived(
    (text.trim().length > 0 || attachments.length > 0) &&
      choice !== null &&
      store.connection === 'ready' &&
      !composer?.sending
  );

  let placeholder = $derived(
    store.openProject && provider
      ? fill(strings.composer.placeholder, { provider: provider.name, project: store.openProject.name })
      : strings.composer.placeholderNoProject
  );

  // -- the slash menu -----------------------------------------------------------
  // `/` on an empty box, then the word being typed: nothing else opens it, and a
  // space or a second line closes it, since the input of a command is not a query.

  /** What was typed after the slash, or null while the box is not a bare `/word`. */
  let slashQuery = $derived.by((): string | null => {
    const match = /^\/(\S*)$/.exec(text);
    return match ? (match[1] ?? '') : null;
  });

  // -- the mention menu ---------------------------------------------------------
  // `@` at the start of a word, wherever the caret is: the word after it is the
  // query, and the core ranks the project's files on it. The pick writes the
  // path in as `@path`, plain text every agent reads, its own way.

  /** The word being typed after an `@`, or null while the caret is not on one. */
  let mentionQuery = $derived.by((): string | null => {
    const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
    return match ? (match[1] ?? '') : null;
  });

  /** A mention wins over the slash menu on the odd `/@word`: it is the word under the caret. */
  let slashOpen = $derived(slashQuery !== null && mentionQuery === null && focused && !slashDismissed);

  /** Typing anything takes the box out of the dismissal Escape put it in. */
  $effect(() => {
    void text;
    slashDismissed = false;
    mentionDismissed = false;
  });

  let mentionOpen = $derived(mentionQuery !== null && focused && !mentionDismissed);

  /** The project whose files are named: the open thread's, or the draft's. */
  let mentionProject = $derived(store.openThread?.projectId ?? store.draft?.projectId ?? null);

  /** The core's page for the query, asked a beat after the last keystroke, the stale answer dropped. */
  $effect(() => {
    const query = mentionQuery;
    const projectId = mentionProject;
    const client = store.client;
    if (query === null || projectId === null || !client) return;
    const ask = ++mentionAsk;
    const timer = setTimeout(() => {
      void client
        .call('projects.files', { projectId, query, limit: MENTION_PAGE })
        .then((page) => {
          if (ask !== mentionAsk) return;
          mentionItems = page.files.map((path) => {
            const cut = path.lastIndexOf('/');
            return {
              id: path,
              kind: 'command' as const,
              label: cut < 0 ? path : path.slice(cut + 1),
              description: cut < 0 ? undefined : path.slice(0, cut)
            };
          });
          mentionMore = Math.max(0, page.total - page.files.length);
          mentionAt = 0;
        })
        .catch(() => {
          // A project gone or a core away: the menu says nothing matches, the text stands.
          if (ask !== mentionAsk) return;
          mentionItems = [];
          mentionMore = 0;
        });
    }, MENTION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  /** The agent's own, in the order it reported them. Never on a draft: there is no agent yet. */
  let agentItems = $derived.by((): PaletteItem[] =>
    (store.openThread?.commands ?? []).map((command) => ({
      id: `${AGENT_PREFIX}${command.name}`,
      kind: 'command' as const,
      label: `/${command.name}`,
      hint: command.hint ?? undefined,
      description: command.description ?? undefined
    }))
  );

  /**
   * Boite's own under them: the palette's list plus the three the composer runs
   * itself. A row reads as the `/name` it is typed as, the sentence under it.
   */
  let boiteItems = $derived.by((): PaletteItem[] => [
    ...Object.entries(CHIP_COMMANDS).map(([name, chip]) => ({
      id: name,
      kind: 'command' as const,
      label: `/${name}`,
      description: chip.description
    })),
    // A command is looked up by the `/name` it is typed as, so the palette's
    // sentence becomes the line under it and never part of what is ranked: it
    // is a whole sentence, and one of its words would outrank every real name.
    ...appCommands(store, inShell).map((item) => ({
      id: item.id,
      kind: 'command' as const,
      label: `/${item.id}`,
      description: item.label,
      keywords: item.keywords
    }))
  ]);

  /** Agent commands first, so a tie goes to the agent's own. */
  let slashItems = $derived(rankItems(slashQuery ?? '', [...agentItems, ...boiteItems]));

  $effect(() => {
    void slashItems;
    slashAt = 0;
  });

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
    // Typing is proof the box has the keyboard, whatever the focus event did.
    focused = true;
    track();
    grow();
  }

  /** Where the caret is now: read after every key, click and input. */
  function track() {
    caret = box?.selectionEnd ?? text.length;
  }

  /** Writes a recalled or restored prompt in, caret at its end. */
  function put(value: string, at = value.length) {
    setText(value);
    const el = box;
    if (el) {
      el.value = value;
      el.selectionStart = el.selectionEnd = at;
    }
    caret = at;
    requestAnimationFrame(grow);
  }

  /**
   * This input's state, created on first use. The entry is read back rather
   * than returned from the `??=`: that operator hands back the plain object it
   * wrote, and a write to it would land beside the store's own `$state` proxy
   * instead of inside it, so nothing would redraw.
   */
  function stateForInput() {
    store.composerStates[key] ??= {
      text: '',
      attachments: [],
      queued: [],
      sending: false,
      paused: false
    };
    return store.composerStates[key]!;
  }

  function setText(value: string) {
    stateForInput().text = value;
  }

  async function drain(threadId: string, state: NonNullable<typeof composer>) {
    const entry = state.queued[0];
    if (entry === undefined) return;
    state.sending = true;
    const accepted = await store.send(entry.text, threadId, entry.attachments);
    if (accepted) state.queued.shift();
    else {
      // Pause after a refusal. Put the rejected prompt back for an explicit retry.
      state.paused = true;
      if (state.text.length === 0 && state.attachments.length === 0) {
        const back = state.queued.shift()!;
        state.text = back.text;
        state.attachments = back.attachments;
      }
    }
    state.sending = false;
  }

  async function submit(nextDraft = false) {
    const prompt = text;
    const images = attachments;
    if (!canSend || !choice) return;
    const state = stateForInput();
    if (store.busy) {
      state.queued.push({ text: prompt, attachments: images });
      state.text = '';
      state.attachments = [];
      recall = null;
      requestAnimationFrame(grow);
      return;
    }
    state.sending = true;
    const accepted = await (nextDraft
      ? store.submitAndDraft(prompt, choice, images)
      : store.submit(prompt, choice, images));
    if (accepted) {
      // Text typed and images attached while the RPC was pending belong to the
      // next prompt: only what went out is cleared.
      if (state.text === prompt) state.text = '';
      if (state.attachments === images) state.attachments = [];
      state.paused = false;
      recall = null;
      requestAnimationFrame(grow);
    }
    state.sending = false;
  }

  // -- images -----------------------------------------------------------------
  // Three ways in, one path: the attach button, a paste carrying image items,
  // and image files dropped on the box. `lib/attachments.ts` owns the caps.

  /**
   * Reads the files and keeps what the caps allow. A provider that reads no
   * image refuses the lot by name rather than dropping them in silence.
   */
  async function take(files: File[]) {
    if (files.length === 0) return;
    if (provider && !provider.capabilities.images) {
      store.error = fill(strings.composer.attachNoImages, { provider: provider.name });
      return;
    }
    const state = stateForInput();
    const read = await Promise.all(files.map(readImageFile));
    const { accepted, refused } = acceptAttachments(state.attachments, read);
    state.attachments = accepted;
    if (refused !== null) store.error = refused;
  }

  function imagesOf(list: FileList | null | undefined): File[] {
    return Array.from(list ?? []).filter((file) => file.type.startsWith('image/'));
  }

  function onchoose(event: Event) {
    const field = event.currentTarget as HTMLInputElement;
    const files = imagesOf(field.files);
    // The same picture picked twice in a row must fire `change` both times.
    field.value = '';
    void take(files);
  }

  function onpaste(event: ClipboardEvent) {
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    // The text of a clipboard that also carries an image stays out of the box.
    event.preventDefault();
    void take(files);
  }

  /** Only an image is taken here; a folder falls through to the app's own drop. */
  function ondragover(event: DragEvent) {
    if (!Array.from(event.dataTransfer?.items ?? []).some((item) => item.type.startsWith('image/'))) return;
    event.preventDefault();
    event.stopPropagation();
  }

  function ondrop(event: DragEvent) {
    const files = imagesOf(event.dataTransfer?.files);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    void take(files);
  }

  function removeAttachment(at: number) {
    const state = stateForInput();
    state.attachments = state.attachments.filter((_, index) => index !== at);
    box?.focus();
  }

  /**
   * Ctrl+Enter: the same send, then a fresh draft on the same choice. A turn
   * that is still running only queues the text, and the queue goes out from
   * this thread, so that case stays what Enter does.
   */
  function submitAndDraft() {
    void submit(true);
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

  /**
   * An agent command is completed into the box for the user to finish, since
   * only they know its input; one of Boite's runs on the spot and the `/word`
   * goes. Either way the text stops matching `/word`, so the menu closes itself.
   */
  function pickSlash(item: PaletteItem) {
    if (isAgentCommand(item)) {
      put(`/${item.id.slice(AGENT_PREFIX.length)} `);
      box?.focus();
      return;
    }
    put('');
    const chip = CHIP_COMMANDS[item.id];
    if (chip) {
      void openChip(chip.testid);
      return;
    }
    runCommand(store, item.id, inShell);
  }

  /** The chip's own trigger opens its menu: one popover, owned by one component. */
  async function openChip(testid: string) {
    await tick();
    const bar = box?.closest('[data-testid="composer"]');
    bar?.querySelector<HTMLElement>(`[data-testid="${testid}"]`)?.click();
  }

  /**
   * The `@word` under the caret becomes `@path `, the rest of the text stays,
   * and the caret lands after the space. The text stops matching, so the menu
   * closes itself.
   */
  function pickMention(item: PaletteItem) {
    const head = text.slice(0, caret);
    const at = head.lastIndexOf('@');
    if (at < 0) return;
    const written = `${head.slice(0, at)}@${item.id} `;
    put(written + text.slice(caret), written.length);
    box?.focus();
  }

  /**
   * The keys of whichever menu is open. True when the key was ours: Escape
   * shuts it on the text as typed, Enter and Tab take the row, the arrows move.
   */
  function menuKey(event: KeyboardEvent): boolean {
    if (mentionOpen) {
      return listKey(event, mentionItems, mentionAt, (index) => (mentionAt = index), () => (mentionDismissed = true), pickMention);
    }
    if (slashOpen) {
      return listKey(event, slashItems, slashAt, (index) => (slashAt = index), () => (slashDismissed = true), pickSlash);
    }
    return false;
  }

  function listKey(
    event: KeyboardEvent,
    items: PaletteItem[],
    at: number,
    move: (index: number) => void,
    dismiss: () => void,
    pick: (item: PaletteItem) => void
  ): boolean {
    if (event.key === 'Escape') {
      dismiss();
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      const item = items[at];
      if (!item) return false;
      pick(item);
      return true;
    }
    if (items.length === 0) return false;
    if (event.key === 'ArrowDown') move((at + 1) % items.length);
    else if (event.key === 'ArrowUp') move((at - 1 + items.length) % items.length);
    else return false;
    return true;
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
    // The menu takes the arrows, Enter, Tab and Escape while it is open; every
    // other key, the recall and the send included, is untouched.
    if (!event.shiftKey && menuKey(event)) {
      event.preventDefault();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
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

<div class="composer-wrap" class:centered>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="composer" data-testid="composer" {ondragover} {ondrop}>
    {#if composer && composer.queued.length > 0}
      <div class="queued subtle" data-testid="composer-queued">{strings.composer.queued}</div>
    {/if}

    {#if attachments.length > 0}
      <div class="attachments" data-testid="composer-attachments">
        {#each attachments as attachment, at (at)}
          {@const label = attachment.name ?? strings.composer.attachAlt}
          <div class="attachment" data-testid="composer-attachment" title={label}>
            <img src="data:{attachment.mimeType};base64,{attachment.data}" alt={label} />
            <button
              type="button"
              class="icon small remove"
              data-testid="composer-attachment-remove"
              title={fill(strings.composer.attachRemove, { name: label })}
              aria-label={fill(strings.composer.attachRemove, { name: label })}
              onclick={() => removeAttachment(at)}
            >
              <X size={12} strokeWidth={2.25} />
            </button>
          </div>
        {/each}
      </div>
    {/if}

    <textarea
      bind:this={box}
      bind:value={() => text, setText}
      {oninput}
      {onkeydown}
      {onpaste}
      onkeyup={track}
      onclick={track}
      onfocus={() => {
        focused = true;
        track();
      }}
      onblur={() => (focused = false)}
      rows="1"
      {placeholder}
      aria-label={placeholder}
      data-testid="composer-input"
      spellcheck="true"
    ></textarea>

    <SlashMenu
      open={slashOpen}
      items={slashItems}
      selected={slashAt}
      onpick={pickSlash}
      onhover={(index) => (slashAt = index)}
    />

    <MentionMenu
      open={mentionOpen}
      items={mentionItems}
      selected={mentionAt}
      more={mentionMore}
      onpick={pickMention}
      onhover={(index) => (mentionAt = index)}
    />

    <div class="bar">
      <div class="chips">
        <ModelPicker {store} {choice} locked={bound} onpick={pick} />

        {#if takesImages}
          <button
            type="button"
            class="chip attach"
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
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            tabindex="-1"
            aria-hidden="true"
            data-testid="composer-file"
            onchange={onchoose}
          />
        {/if}

        {#if effortLevels.length > 0}
          <EffortSlider levels={effortLevels} active={activeEffort} onpick={pickEffort} />
        {/if}

        <Menu items={modeItems} onpick={pickMode} label={strings.composer.mode} testid="composer-mode">
          <ShieldCheck size={14} strokeWidth={1.75} />
          {choice ? strings.permissionMode[choice.permissionMode] : strings.permissionMode.default}
        </Menu>

        <!-- A thread keeps its directory, so the switch exists on a draft alone. -->
        {#if store.draft}
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
        disabled={!canSend}
        onclick={() => void submit()}
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

  /* Centred under the draft's heading: the air above and below is the column's
     to give, and the horizontal padding is the one the heading uses too. */
  .composer-wrap.centered {
    padding: 0 20px;
  }

  /* The one raised object in the column: it floats over the timeline instead of
     repeating the sidebar's slab. e1 rides on e2 for the inset top highlight. */
  .composer {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: var(--content);
    margin: 0 auto;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-e2), var(--shadow-e1);
    transition: border-color var(--dur-2) var(--ease-out-quint);
  }

  .composer:focus-within {
    border-color: var(--color-edge);
    box-shadow:
      var(--shadow-e2),
      var(--shadow-e1),
      0 0 0 2px color-mix(in srgb, var(--color-foreground) 22%, transparent);
  }

  .queued {
    padding: 6px 14px 0;
    font-size: var(--text-sm);
  }

  /* The images this prompt carries, above the box they were pasted into. */
  .attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 10px 14px 0;
  }

  .attachment {
    position: relative;
    width: 56px;
    height: 56px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    overflow: hidden;
    animation: pop var(--dur-2) var(--ease-out-quint);
  }

  .attachment img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  /* The remove button rides the corner, readable over any picture. */
  .attachment .remove {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: var(--radius-sm);
    background: var(--color-scrim);
    color: var(--color-foreground);
  }

  .attachment .remove:hover:not(:disabled) {
    background: var(--color-danger);
    color: var(--color-on-danger);
  }

  /* The button in the chip bar is what opens it; the field itself never shows. */
  .file {
    display: none;
  }

  .attach {
    padding: 0 7px;
  }

  /* Off it reads like the other chips; on it takes the active fill, the same as a pressed tab. */
  .worktree.on {
    background: var(--color-active);
    border-color: var(--color-active);
    color: var(--color-foreground);
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

  /* Read at rest, not a reward for focusing the box: the two keys are learned
     here. It goes under 720 px, where the row has no width to spare. */
  .hint {
    margin-left: auto;
    font-size: var(--text-sm);
    color: var(--color-subtle);
    white-space: nowrap;
  }

  .send,
  .stop {
    width: var(--control);
    height: var(--control);
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

    .composer-wrap.centered {
      padding: 0 10px;
    }

    .hint {
      display: none;
    }
  }
</style>
