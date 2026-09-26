<script lang="ts">
  import { tick, untrack } from 'svelte';
  import type { Attachment, PreviewReference } from '@boite/contracts';
  import { restorePreviewMentions } from '../lib/preview-mentions';
  import { AGENT_PREFIX, isAgentCommand, runCommand } from '../lib/commands.svelte';
  import { agentSlashItems, boiteSlashItems, listKey, mentionQueryOf, mentionRows, slashQueryOf, type ChipCommand } from '../lib/composer-menus';
  import { attachFiles } from '../lib/composer-attachments';
  import { drainQueue, sentPrompts } from '../lib/composer-queue';
  import { rankItems, type PaletteItem } from '../lib/palette';
  import { clearStash, DRAFT_STASH_KEY, readStash, writeStash } from '../lib/prefs';
  import { claudeKeywords, promptSegments } from '../lib/message-display';
  import { fill, strings } from '../lib/strings';
  import type { Choice, Store } from '../lib/store.svelte';
  import ComposerAttachments from './ComposerAttachments.svelte';
  import ComposerBar from './ComposerBar.svelte';
  import ComposerQueue from './ComposerQueue.svelte';
  import MentionMenu from './MentionMenu.svelte';
  import SlashMenu from './SlashMenu.svelte';
  import ThreadActivity from './ThreadActivity.svelte';
  import PreviewReferences from './PreviewReferences.svelte';

  /**
   * `centered` is the draft's placement: the parent stacks the composer under
   * the heading and centres the pair, so the wrapper drops the padding that
   * holds it off the bottom of the column. Same component, same box.
   */
  let { store, centered = false }: { store: Store; centered?: boolean } = $props();

  const MAX_LINES = 8;

  let key = $derived(store.openThread?.id ?? DRAFT_STASH_KEY);
  let composer = $derived(store.composerStates[key]);
  let text = $derived(composer?.text ?? '');
  /** The attachments this prompt carries, the same array the strip above the box draws. */
  let attachments = $derived<Attachment[]>(composer?.attachments ?? []);
  let previewReferences = $derived(composer?.previewReferences ?? []);
  let choice = $state<Choice | null>(null);
  let picking = $state(false);
  let readingFiles = $state(0);
  let dictating = $state(false);
  let speechPreview = $state(''), speechStatus = $state(''), speechError = $state(false);
  let box = $state<HTMLTextAreaElement | undefined>(undefined);
  let inputWidth = $state(0);
  let inputScroll = $state(0);
  let toolbar = $state<ReturnType<typeof ComposerBar> | undefined>(undefined);
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
  let pendingEdit: { start: number; end: number } | undefined;
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
  /** The project `mentionItems` was ranked in: another one's paths are never shown. */
  let mentionFrom: string | null = null;
  const MENTION_PAGE = 30;
  const MENTION_DEBOUNCE_MS = 60;

  const inShell = window.__TAURI_INTERNALS__ !== undefined;
  /** The three commands the composer runs itself: each one opens a chip's menu. */
  const CHIP_COMMANDS: Record<string, ChipCommand> = {
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
      choice = store.composerChoice({
        providerId: thread.providerId,
        accountId: thread.accountId,
        permissionMode: thread.permissionMode,
        model: thread.model,
        effort: thread.effort,
        speed: thread.speed ?? null
      });
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
      untrack(() => void drainQueue(store, threadId, state));
    }
  });

  /** This thread's own sent prompts, most recent first: what ArrowUp walks. */
  let sent = $derived(sentPrompts(store.openThread?.messages ?? []));

  let provider = $derived(choice ? store.providerOf(choice.providerId) : null);
  $effect(() => {
    if (provider?.available && provider.protocol !== 'echo' && choice) {
      const id = provider.id, accountId = choice.accountId;
      untrack(() => void store.probeModels(id, accountId));
    }
  });
  // OpenCode names a model's efforts only once a session is on it.
  $effect(() => {
    if (provider?.available && provider.protocol === 'acp' && choice?.model) {
      const id = provider.id, accountId = choice.accountId, model = choice.model;
      untrack(() => void store.probeModelEffort(id, accountId, model));
    }
  });
  let canSend = $derived(
    (text.trim().length > 0 || attachments.length > 0 || previewReferences.length > 0) &&
      readingFiles === 0 &&
      choice !== null &&
      store.connection === 'ready' &&
      !picking &&
      !dictating &&
      !composer?.sending
  );

  // A new conversation asks what the user wants done; one under way names who reads the message.
  let placeholder = $derived(
    !store.openThread && store.draft
      ? strings.composer.placeholderNew
      : store.openProject && provider
        ? fill(strings.composer.placeholder, { provider: provider.name, project: store.openProject.name })
        : strings.composer.placeholderNoProject
  );

  // -- the slash menu -----------------------------------------------------------
  // `/` on an empty box, then the word being typed: nothing else opens it, and a
  // space or a second line closes it, since the input of a command is not a query.

  /** What was typed after the slash, or null while the box is not a bare `/word`. */
  let slashQuery = $derived(slashQueryOf(text));

  // -- the mention menu ---------------------------------------------------------
  // `@` at the start of a word, wherever the caret is: the word after it is the
  // query, and the core ranks the project's files on it. The pick writes the
  // path in as `@path`, plain text every agent reads, its own way.

  /** The word being typed after an `@`, or null while the caret is not on one. */
  let mentionQuery = $derived(mentionQueryOf(text, caret, previewReferences));

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
    // Every run drops the page in flight, the one that shuts the menu included.
    const ask = ++mentionAsk;
    // The menu opens on the frame `@` is typed, a whole round trip before the
    // answer: a list ranked in another project, or for a word the user has
    // left, would be pickable until then. Narrowing inside one project keeps
    // its rows, which is what makes the list stand still while he types.
    if (query === null || projectId !== mentionFrom) {
      mentionFrom = projectId;
      mentionItems = [];
      mentionMore = 0;
    }
    if (query === null || projectId === null || !client) return;
    const timer = setTimeout(() => {
      void client
        .call('projects.files', { projectId, query, limit: MENTION_PAGE })
        .then((page) => {
          if (ask !== mentionAsk) return;
          mentionItems = mentionRows(page.files);
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
  let agentItems = $derived.by((): PaletteItem[] => agentSlashItems(store.openThread?.commands ?? []));

  /** Boite's own under them: the palette's list plus the three the composer runs itself. */
  let boiteItems = $derived.by((): PaletteItem[] => boiteSlashItems(store, inShell, CHIP_COMMANDS));

  /** Agent commands first, so a tie goes to the agent's own. */
  let slashItems = $derived(rankItems(slashQuery ?? '', [...agentItems, ...boiteItems]));
  let commandToken = $derived.by(() => {
    const token = /^\/[^\s]+/.exec(text)?.[0];
    return token && [...agentItems, ...boiteItems].some(item => item.label === token) ? token : '';
  });
  let keywords = $derived(claudeKeywords(provider?.protocol, choice?.model));
  let segments = $derived(promptSegments(text, commandToken || undefined, keywords));
  let painted = $derived(segments.some(segment => segment.kind !== 'plain'));

  function syncInput() {
    if (!box) return;
    inputWidth = box.clientWidth;
    inputScroll = box.scrollTop;
  }

  $effect(() => {
    const element = box;
    if (!element) return;
    const observer = new ResizeObserver(syncInput);
    observer.observe(element);
    return () => observer.disconnect();
  });

  $effect(() => {
    void slashItems;
    slashAt = 0;
  });

  let grown = ''; // Last value measured. Reading the style before the auto write forces one layout, not two.
  function grow() {
    const el = box;
    if (!el) return;
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, line * MAX_LINES + 16)}px`;
    grown = el.value; syncInput(); // The height can toggle the scrollbar, and the paint layer's width follows it.
  }

  // A preview insertion writes the draft with no input event: measure once Svelte wrote it, unless oninput did.
  $effect(() => {
    void text;
    if (!box) return;
    let current = true;
    void tick().then(() => { if (current && box?.value !== grown) grow(); });
    return () => { current = false; };
  });

  $effect(() => {
    const insertion = composer?.mentionInsertion;
    if (!insertion) return;
    const currentKey = key;
    const selection = untrack(() => composer?.selection);
    void tick().then(() => {
      if (key === currentKey && box && selection) {
        box.setSelectionRange(selection.start, selection.end);
        caret = selection.end;
      }
    });
  });

  $effect(() => {
    const element = box;
    if (!element) return;
    return store.registerComposerInsertion(key, (start, end, replacement) => {
      element.focus();
      element.setSelectionRange(start, end);
      // Chromium and WebKit keep insertText in the textarea's native undo stack.
      // Hosts without that editing command still receive the shared draft below.
      if (typeof document.execCommand === 'function') document.execCommand('insertText', false, replacement);
    });
  });

  /** Typing is the user's own, so it takes the composer out of recall. */
  function oninput(event: Event) {
    const input = event as InputEvent;
    const element = event.currentTarget as HTMLTextAreaElement;
    if (pendingEdit && pendingEdit.start === pendingEdit.end && input.inputType?.startsWith('delete')) {
      if (input.inputType.endsWith('Backward')) pendingEdit.start = element.selectionStart;
      else pendingEdit.end += Math.max(0, text.length - element.value.length);
    }
    store.editComposerText(key, element.value, input.inputType === 'historyUndo' || input.inputType === 'historyRedo', pendingEdit);
    pendingEdit = undefined;
    recall = null;
    // Typing is proof the box has the keyboard, whatever the focus event did.
    focused = true;
    track();
    grow();
  }

  /** Where the caret is now: read after every key, click and input. */
  function track() {
    caret = box?.selectionEnd ?? text.length;
    if (box) stateForInput().selection = { start: box.selectionStart, end: box.selectionEnd };
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
    store.editComposerText(key, value);
  }

  async function submit(nextDraft = false) {
    const prompt = text;
    const images = attachments;
    const references = previewReferences;
    if (!canSend || !choice) return;
    const state = stateForInput();
    // A queue that still holds something takes this prompt too, whatever the
    // thread's status: sending it on its own would put it ahead of prompts the
    // user typed first. Sending is also how he resumes a queue a refusal paused.
    if (store.busy || state.queued.length > 0) {
      state.queued.push({ text: prompt, attachments: images, ...(references.length ? { previewReferences: references } : {}) });
      state.text = '';
      state.attachments = [];
      state.previewReferences = [];
      state.paused = false;
      recall = null;
      requestAnimationFrame(grow);
      return;
    }
    state.sending = true;
    const accepted = await (nextDraft
      ? store.submitAndDraft(prompt, choice, images, references)
      : store.submit(prompt, choice, images, references));
    if (accepted) {
      // Text typed and images attached while the RPC was pending belong to the
      // next prompt: only what went out is cleared.
      if (state.text === prompt) state.text = '';
      if (state.attachments === images) state.attachments = [];
      if (state.previewReferences === references) state.previewReferences = [];
      state.paused = false;
      recall = null;
      requestAnimationFrame(grow);
    }
    state.sending = false;
  }

  // -- attachments -----------------------------------------------------------------
  // Three ways in, one path: the attach button, pasted files,
  // and files dropped on the box. `lib/attachments.ts` owns the caps.

  /** Reads files one at a time into this input's attachments (`lib/composer-attachments.ts`). */
  async function take(files: File[]) {
    if (files.length === 0) return;
    const state = stateForInput();
    const attachmentProvider = provider;
    readingFiles += 1;
    try {
      await attachFiles(store, files, state, attachmentProvider);
    } finally { readingFiles -= 1; }
  }

  function onpaste(event: ClipboardEvent) {
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    // The text of a clipboard that also carries an image stays out of the box.
    event.preventDefault();
    void take(files);
  }

  /** File drops belong to the composer. */
  function ondragover(event: DragEvent) {
    if (!Array.from(event.dataTransfer?.items ?? []).some((item) => item.kind === 'file')) return;
    event.preventDefault();
    event.stopPropagation();
  }

  function ondrop(event: DragEvent) {
    const files = Array.from(event.dataTransfer?.files ?? []);
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
    if (recall === null && (text.length > 0 || previewReferences.length > 0)) return false;
    if (recall === null && composer?.queued.length && !composer.sending && attachments.length === 0) {
      restoreQueued(composer.queued.length - 1);
      return true;
    }
    const next = recall === null ? 0 : recall + 1;
    const prompt = sent[next];
    if (prompt === undefined) return recall !== null;
    recall = next;
    restorePrompt(prompt.text, prompt.previewReferences);
    return true;
  }

  function restoreQueued(at: number) {
    const state = composer;
    if (!state || state.sending || text.length > 0 || attachments.length > 0 || previewReferences.length > 0) return;
    const entry = state.queued.splice(at, 1)[0];
    if (!entry) return;
    state.attachments = entry.attachments;
    recall = null;
    restorePrompt(entry.text, entry.previewReferences ?? []);
    box?.focus();
  }

  /** ArrowDown: one prompt newer, and past the newest the composer is empty again. */
  function newer(): boolean {
    if (recall === null) return false;
    const next = recall - 1;
    if (next < 0) {
      recall = null;
      stateForInput().previewReferences = [];
      put('');
      return true;
    }
    const prompt = sent[next];
    if (prompt === undefined) return true;
    recall = next;
    restorePrompt(prompt.text, prompt.previewReferences);
    return true;
  }

  function restorePrompt(text: string, references: PreviewReference[]) {
    const restored = restorePreviewMentions(text, references);
    put(restored.text);
    stateForInput().previewReferences = restored.references;
  }

  /** Ctrl+S: text goes aside for this thread, an empty composer takes it back. */
  function stash() {
    if (previewReferences.length) { store.error = strings.previewComments.stashUnsupported; return; }
    const key = store.threadKey(store.openThread?.id ?? DRAFT_STASH_KEY);
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
    if (item.id === 'goal' || item.id === 'loop') {
      put(`/${item.id} `);
      box?.focus();
      return;
    }
    if (isAgentCommand(item)) {
      put(`/${item.id.slice(AGENT_PREFIX.length)} `);
      box?.focus();
      return;
    }
    put('');
    const chip = CHIP_COMMANDS[item.id];
    if (chip) {
      void toolbar?.openChip(chip.testid);
      return;
    }
    runCommand(store, item.id, inShell);
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

  function onkeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    const meta = event.ctrlKey || event.metaKey;
    // The two composer chords come from the keyboard table, like the app's.
    if (store.isKey(event, 'send-and-draft')) {
      event.preventDefault();
      submitAndDraft();
      return;
    }
    if (store.isKey(event, 'stash')) {
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
    } else if (event.key === 'Escape' && (store.busy || store.openThread?.activity?.goal?.status === 'active' || store.openThread?.activity?.loop?.status === 'active')) {
      event.preventDefault();
      void store.stop();
    }
  }
</script>

<div class="composer-wrap" class:centered>
  <ThreadActivity {store} />
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="composer" class:dictating data-testid="composer" {ondragover} {ondrop}>
    {#if composer && composer.queued.length > 0}
      <ComposerQueue queued={composer.queued}
        disabled={composer.sending || text.length > 0 || attachments.length > 0 || previewReferences.length > 0}
        onrestore={restoreQueued} />
    {/if}

    {#if attachments.length > 0}
      <ComposerAttachments {attachments} onremove={removeAttachment} />
    {/if}

    <div class="input-wrap">
    {#if painted || previewReferences.length}
      <div class="input-highlight" aria-hidden={previewReferences.length ? undefined : true} data-testid="composer-highlight" style:width={`${inputWidth}px`}>
        <div class="input-paint input-mirror" style:transform={`translateY(${-inputScroll}px)`}>{#if previewReferences.length}<PreviewReferences {text} references={previewReferences} {store} threadId={key} editing {keywords} onreference={(reference) => {
          if (box && reference.mention) { box.focus(); box.setSelectionRange(reference.mention.end, reference.mention.end); track(); }
        }} />{:else}<span aria-hidden="true">{#each segments as segment, index (index)}{#if segment.kind === 'command'}<span class="command-token" data-testid="command-highlight">{segment.text}</span>{:else if segment.kind === 'plain'}{segment.text}{:else}<span class="keyword-{segment.kind}" data-testid="keyword-highlight">{segment.text}</span>{/if}{/each}</span>{/if}{'\n'}</div>
      </div>
    {/if}
    <textarea
      class:highlighted={painted || previewReferences.length > 0}
      bind:this={box}
      value={text}
      onbeforeinput={() => { pendingEdit = box ? { start: box.selectionStart, end: box.selectionEnd } : undefined; }}
      {oninput}
      {onkeydown}
      {onpaste}
      onkeyup={track}
      onscroll={syncInput}
      onclick={track}
      onselect={track}
      onfocus={() => {
        focused = true;
        track();
      }}
      onblur={() => { track(); focused = false; }}
      rows="1"
      {placeholder}
      aria-label={placeholder}
      data-testid="composer-input"
      spellcheck={!commandToken}
    ></textarea>
    </div>

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

    {#if speechStatus}
      <div class="speech-preview" class:error={speechError} data-testid="dictation-preview">
        <span class="speech-status" role={speechError ? 'alert' : 'status'}>{speechStatus}</span>
        {#if speechPreview}<p aria-live="polite" aria-atomic="true">{speechPreview}</p>{/if}
      </div>
    {/if}

    <ComposerBar bind:this={toolbar} {store} {key} {provider} {canSend} bind:choice bind:picking bind:dictating
      onsubmit={() => void submit()}
      onfiles={(files) => void take(files)}
      onpreview={(text, status, error) => { speechPreview = text; speechStatus = status; speechError = error; }}
      ontranscript={(transcript) => {
        const current = stateForInput().text;
        put(current + (current && !/\s$/.test(current) ? ' ' : '') + transcript);
      }} />
  </div>
</div>

<style>
  .speech-preview { padding: 0 14px 6px; min-width: 0; }
  .speech-status { font-size: var(--text-xs); color: var(--color-muted-foreground); }
  .speech-preview.error .speech-status { color: var(--color-danger); }
  .speech-preview p { margin: 2px 0 0; font-size: var(--text-sm); line-height: 1.5; color: var(--color-foreground); overflow-wrap: anywhere; max-height: 3em; overflow-y: auto; }
  .composer-wrap {
    position: relative;
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

  .input-wrap { position: relative; }

  .input-highlight {
    position: absolute;
    inset: 0 auto 0 0;
    overflow: hidden;
    pointer-events: none;
    z-index: 1;
  }

  .input-paint {
    white-space: pre-wrap;
    overflow-wrap: break-word;
    color: var(--color-foreground);
  }

  .command-token { color: var(--color-accent); }
  textarea.highlighted { color: transparent; caret-color: var(--color-foreground); }
  textarea.highlighted::selection { background: var(--color-accent-soft); }

  textarea, .input-paint {
    width: 100%;
    min-height: 44px;
    max-height: 200px;
    padding: 12px 14px 6px;
    border: none;
    background: transparent;
    font-size: var(--text-base);
    line-height: 1.5;
  }

  textarea { display: block; }
  .input-paint { max-height: none; }

  textarea:focus {
    outline: none;
    border: none;
  }

  @media (max-width: 720px) {
    .composer { box-shadow: none; border-radius: var(--radius-xl); }
    .composer:focus-within { box-shadow: none; border-color: var(--color-edge); }
    .speech-preview { padding: 0 16px 8px; }
    .speech-status { color: var(--color-accent); }
    textarea, .input-mirror { font-size: var(--text-md); }
    .composer-wrap {
      padding: 6px 10px 10px;
    }

    .composer-wrap.centered {
      padding: 0 10px;
    }

  }
</style>
