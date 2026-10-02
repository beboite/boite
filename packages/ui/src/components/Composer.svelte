<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { Pencil, X } from '@lucide/svelte';
  import type { Attachment, PreviewReference } from '@boite/contracts';
  import { restorePreviewMentions } from '../lib/preview-mentions';
  import { AGENT_PREFIX, isAgentCommand, runCommand } from '../lib/commands.svelte';
  import { agentSlashItems, boiteSlashItems, listKey, mentionQueryOf, mentionRows, slashQueryOf, type ChipCommand } from '../lib/composer-menus';
  import { attachFiles } from '../lib/composer-attachments';
  import { rewindComposerEdit } from '../lib/composer-edit';
  import { fitHeight, selfSizing } from '../lib/composer-size';
  import { editComposerInput, insertImageReference, removeImageReferences, trackImageSend } from '../lib/composer-images';
  import { unresolvedAssetId } from '../lib/draft-attachments';
  import { sentPrompts, type SentPrompt } from '../lib/composer-queue';
  import { rankItems, type PaletteItem } from '../lib/palette';
  import { clearStash, DRAFT_STASH_KEY, readStash, writeStash } from '../lib/prefs';
  import { claudeKeywords, promptSegments } from '../lib/message-display';
  import { fill, strings } from '../lib/strings';
  import type { Choice, Store } from '../lib/store.svelte';
  import { workspace } from '../lib/workspace.svelte';
  import ComposerAttachments from './ComposerAttachments.svelte';
  import ComposerImageReferences from './ComposerImageReferences.svelte';
  import ComposerBar from './ComposerBar.svelte';
  import ComposerQueue from './ComposerQueue.svelte';
  import MentionMenu from './MentionMenu.svelte';
  import SlashMenu from './SlashMenu.svelte';
  import ThreadActivity from './ThreadActivity.svelte';
  import PreviewReferences from './PreviewReferences.svelte';

  /** A centred draft drops the bottom padding so its heading and input form one block. */
  let { store, centered = false }: { store: Store; centered?: boolean } = $props();

  const MAX_LINES = 8;
  const sizesItself = selfSizing();

  let key = $derived(store.openThread?.id ?? DRAFT_STASH_KEY);
  let composer = $derived(store.composerStates[key]);
  let hasQueue = $derived(!!(composer?.queued.length || store.openThread?.pendingAnswers?.length));
  let activityRoom = $state(0);
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
  let attachmentStrip = $state<ReturnType<typeof ComposerAttachments> | undefined>();
  let highlightedImage = $state<Attachment | null>(null);
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

  /** A new draft or thread gets the keyboard; reloading the same thread preserves focus. */
  $effect(() => {
    key;
    store.draft;
    recall = null;
    box?.focus();
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
  /**
   * A thread whose machine dropped still takes prompts: they wait in its queue,
   * which the store keeps on the device and sends once the machine is back.
   * A new thread needs the core to exist, so a draft waits for the machine.
   */
  let offline = $derived(store.connection !== 'ready' && store.openThread !== null && !store.draft);
  let machineLabel = $derived(workspace.machines.find((machine) => machine.store === store)?.label ?? strings.machines.local);
  let canSend = $derived(
    (text.trim().length > 0 || attachments.length > 0 || previewReferences.length > 0) &&
      readingFiles === 0 &&
      !attachments.some(unresolvedAssetId) &&
      choice !== null &&
      (store.connection === 'ready' || offline) &&
      !picking &&
      !dictating &&
      !composer?.sending
  );

  // A new conversation asks what the user wants done; one under way names who reads the message.
  let placeholder = $derived(
    offline
      ? fill(strings.composer.placeholderOffline, { machine: machineLabel })
      : !store.openThread && store.draft
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

  /** Boite's prompt controls follow the agent's own commands. */
  let boiteItems = $derived.by((): PaletteItem[] => boiteSlashItems(CHIP_COMMANDS));

  /** Agent commands first, so a tie goes to the agent's own. */
  let slashItems = $derived(rankItems(slashQuery ?? '', [...agentItems, ...boiteItems]));
  let commandToken = $derived.by(() => {
    const token = /^\/[^\s]+/.exec(text)?.[0];
    return token && [...agentItems, ...boiteItems].some(item => item.label === token) ? token : '';
  });
  let keywords = $derived(claudeKeywords(provider?.protocol, choice?.model));
  let segments = $derived(promptSegments(text, commandToken || undefined, keywords));
  let painted = $derived(segments.some(segment => segment.kind !== 'plain'));
  let highlighted = $derived(painted || previewReferences.length > 0 || attachments.some(item => item.kind === 'image'));

  function syncInput() {
    if (!box) return;
    inputWidth = box.clientWidth;
    inputScroll = box.scrollTop;
  }

  $effect(() => {
    const element = box;
    if (!element) return;
    let resizeFrame = 0;
    const observer = new ResizeObserver(() => {
      if (sizesItself || element.clientWidth === inputWidth) syncInput(); // No height to write: the paint layer's width, this frame.
      else { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(grow); }
    });
    observer.observe(element);
    return () => { observer.disconnect(); cancelAnimationFrame(resizeFrame); };
  });

  $effect(() => {
    void slashItems;
    slashAt = 0;
  });

  let grown = ''; // Last value measured.
  function grow() {
    if (!box) return;
    if (!sizesItself) fitHeight(box, MAX_LINES);
    grown = box.value; syncInput(); // The height can toggle the scrollbar, and the paint layer's width follows it.
  }

  // A preview insertion writes the draft with no input event: measure once Svelte wrote it, unless oninput did.
  $effect(() => {
    void text;
    if (!box || sizesItself) return;
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

  /** Typing is the user's own, so it takes the composer out of recall. A box that sizes itself is measured by the observer, but a scrollbar the key brought under the paint layer is read now. */
  function oninput(event: Event) {
    const input = event as InputEvent;
    const element = event.currentTarget as HTMLTextAreaElement;
    if (pendingEdit && pendingEdit.start === pendingEdit.end && input.inputType?.startsWith('delete')) {
      if (input.inputType.endsWith('Backward')) pendingEdit.start = element.selectionStart;
      else pendingEdit.end += Math.max(0, text.length - element.value.length);
    }
    const whole = editComposerInput(store, key, element, input.inputType === 'historyUndo' || input.inputType === 'historyRedo', pendingEdit);
    pendingEdit = undefined;
    recall = null;
    // Typing is proof the box has the keyboard, whatever the focus event did.
    focused = true;
    if (whole === null) track(); else caret = whole;
    if (!sizesItself) grow(); else if (highlighted) syncInput();
  }

  /** Where the caret is now: read after every key (twice: input and keyup), click and input. An unmoved caret writes nothing. */
  function track() {
    caret = box?.selectionEnd ?? text.length;
    const state = box && stateForInput(), start = box?.selectionStart ?? 0, end = box?.selectionEnd ?? 0;
    if (state && (state.selection?.start !== start || state.selection?.end !== end)) state.selection = { start, end };
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
    if (attachments.some(unresolvedAssetId)) { store.error = strings.errors.draftAttachment; return; }
    const prompt = text;
    const images = attachments;
    const references = previewReferences;
    if (!canSend || !choice) return;
    const inputStore = store, inputKey = key, sendChoice = choice;
    const state = stateForInput();
    const editedThread = state.editing ? inputStore.openThread : null;
    if (state.editing && !await rewindComposerEdit(inputStore, inputKey, state)) return;
    // A queue that still holds something takes this prompt too, whatever the
    // thread's status: sending it on its own would put it ahead of prompts the
    // user typed first. Sending is also how he resumes a queue a refusal paused.
    if (!editedThread && (inputStore.busy || state.queued.length > 0 || offline)) {
      state.queued.push({ text: prompt, attachments: images, afterBoundary: store.inputBoundaries[key]?.boundary, ...(references.length ? { previewReferences: references } : {}) });
      state.editing = null;
      state.text = '';
      state.attachments = [];
      state.previewReferences = [];
      state.paused = false;
      recall = null;
      requestAnimationFrame(grow);
      return;
    }
    state.sending = true;
    const finishImageSend = trackImageSend(state, prompt, images);
    // A rewind can finish after navigation: the replacement belongs to the
    // captured thread and machine, whichever conversation is on screen now.
    const accepted = await (editedThread
      ? inputStore.send(prompt, inputKey, images, references)
      : nextDraft
        ? inputStore.submitAndDraft(prompt, sendChoice, images, references)
        : inputStore.submit(prompt, sendChoice, images, references));
    if (accepted && editedThread && nextDraft && inputStore.openThread?.id === inputKey) {
      inputStore.startDraft(editedThread.projectId);
      inputStore.draftChoice = { ...sendChoice };
    }
    finishImageSend(accepted);
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
    const inputKey = key;
    const inputStore = store;
    readingFiles += 1;
    try {
      await attachFiles(inputStore, files, state, attachmentProvider, () => {
        if (inputStore.composerStates[inputKey] === state) insertImageReference(inputStore, inputKey);
      });
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
    removeImageReferences(store, key, at);
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

  /** Nothing in the box and nothing on its way into it: what a second Enter needs. */
  let boxEmpty = $derived(text.trim().length === 0 && attachments.length === 0 && previewReferences.length === 0 &&
    readingFiles === 0 && !dictating);

  /**
   * What Send now does to the queue: steer the running turn, resume it
   * after a refusal held it, or nothing while a pending prompt is going out.
   */
  let sendNow = $derived<'steer' | 'resume' | null>(
    !composer?.queued.length || composer.sending || store.connection !== 'ready' || !store.openThread ? null
      : store.openThread.status === 'running' ? 'steer' : store.busy ? null : composer.paused ? 'resume' : null
  );

  /**
   * Send now submits queued prompts to the live agent without interrupting it. A queue held after a refusal is resumed too.
   */
  function sendQueuedNow() {
    const state = composer;
    if (!state || sendNow === null) return;
    void store.sendQueuedNow(key);
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
    recallPrompt(prompt);
    return true;
  }

  /**
   * A sent prompt back in the box. On a thread at rest it comes back as the
   * message to edit, pictures and files included: sending replaces it and
   * what followed. A running thread only recalls the words, to queue again.
   * Edit mode asks what `MessageList`'s `branchable` asks, the rules of a rewind.
   */
  function recallPrompt(prompt: SentPrompt) {
    const state = stateForInput();
    const thread = store.openThread;
    const edit = !store.busy && state.queued.length === 0 && thread !== null && !thread.agentSessionId && thread.projectId !== null;
    restorePrompt(prompt.text, prompt.previewReferences);
    if (edit) state.attachments = prompt.attachments;
    else if (state.editing) state.attachments = [];
    state.editing = edit ? prompt.id : null;
  }

  /** Leaves edit mode: the box empties, nothing was rewound. */
  function cancelEdit() {
    const state = stateForInput();
    state.editing = null;
    state.attachments = [];
    state.previewReferences = [];
    recall = null;
    put('');
    box?.focus();
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
      const state = stateForInput();
      state.previewReferences = [];
      if (state.editing) { state.editing = null; state.attachments = []; }
      put('');
      return true;
    }
    const prompt = sent[next];
    if (prompt === undefined) return true;
    recall = next;
    recallPrompt(prompt);
    return true;
  }

  function restorePrompt(text: string, references: PreviewReference[]) {
    const restored = restorePreviewMentions(text, references);
    put(restored.text);
    stateForInput().previewReferences = restored.references;
  }

  /** The stash chord sets text aside for this thread; an empty composer takes it back. */
  function stash() {
    if (previewReferences.length) { store.error = strings.previewComments.stashUnsupported; return; }
    const key = store.threadKey(store.openThread?.id ?? DRAFT_STASH_KEY);
    if (text.trim().length > 0) {
      writeStash(key, text);
      recall = null;
      // The text set aside is plain text: the next prompt typed is not an edit of a sent one.
      const state = stateForInput();
      if (state.editing) { state.editing = null; state.attachments = []; }
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
      if (boxEmpty && sendNow) sendQueuedNow();
      else void submit();
    } else if (event.key === 'ArrowUp' && !event.shiftKey) {
      if (older()) event.preventDefault();
    } else if (event.key === 'ArrowDown' && !event.shiftKey) {
      if (newer()) event.preventDefault();
    } else if (event.key === 'Escape' && (store.busy || store.openThread?.activity?.goal?.status === 'active' || store.openThread?.activity?.loop?.status === 'active')) {
      event.preventDefault();
      void store.stop();
    } else if (event.key === 'Escape' && composer?.editing) {
      event.preventDefault();
      cancelEdit();
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="composer-wrap" class:centered onkeydowncapture={(event) => {
  if (!event.isComposing && event.key === 'Escape' && !mentionOpen && !slashOpen && attachmentStrip?.closePreview()) {
    event.preventDefault(); event.stopPropagation();
  }
}}>
  <div class="queue-region" style:padding-bottom={hasQueue ? `${activityRoom}px` : undefined}>
    {#if store.openThread?.pendingAnswers?.length}
      <div data-testid="question-queued">
        <ComposerQueue queued={store.openThread.pendingAnswers.map(text => ({ text, attachments: [] }))}
          disabled={true} paused={false} sendNow={null} onrestore={() => {}} onsendnow={() => {}} />
      </div>
    {/if}
    {#if composer && composer.queued.length > 0}
      <ComposerQueue queued={composer.queued}
        disabled={composer.sending || text.length > 0 || attachments.length > 0 || previewReferences.length > 0}
        paused={composer.paused}
        {sendNow}
        onrestore={restoreQueued}
        onsendnow={sendQueuedNow} />
    {/if}
  </div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="composer" class:dictating data-testid="composer" {ondragover} {ondrop}>
    <ThreadActivity {store} reserveInComposer={hasQueue} onroom={(height) => (activityRoom = height)} />
    {#if composer?.editing}
      <div class="editing" data-testid="composer-editing">
        <Pencil size={13} />
        <span>{strings.composer.editing}</span>
        <button type="button" class="ghost small icon" data-testid="composer-editing-cancel" title={strings.composer.editingCancel} aria-label={strings.composer.editingCancel} onclick={cancelEdit}><X size={13} /></button>
      </div>
    {/if}

    {#if attachments.length > 0}
      {#key composer}<ComposerAttachments bind:this={attachmentStrip} {attachments} highlighted={highlightedImage} onremove={removeAttachment} onfocus={() => box?.focus()} />{/key}
    {/if}

    <div class="input-wrap">
    {#if highlighted}
      <div class="input-highlight" aria-hidden={previewReferences.length || attachments.length ? undefined : true} data-testid="composer-highlight" style:width={`${inputWidth}px`}>
        <div class="input-paint input-mirror" style:transform={`translateY(${-inputScroll}px)`}><PreviewReferences {text} references={previewReferences} {store} threadId={key} editing {keywords} command={commandToken || undefined} onreference={(reference) => {
          if (box && reference.mention) { box.focus(); box.setSelectionRange(reference.mention.end, reference.mention.end); track(); }
        }}>{#snippet paint(parts)}<ComposerImageReferences segments={parts} {attachments} onopen={(attachment) => attachmentStrip?.open(attachment)} onhover={(attachment) => highlightedImage = attachment} />{/snippet}</PreviewReferences>{'\n'}</div>
      </div>
    {/if}
    <textarea
      class:highlighted
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

  /* A translucent surface with a top reflection. */
  .composer {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: var(--content);
    margin: 0 auto;
    background: var(--composer-glaze) var(--color-composer-surface);
    backdrop-filter: blur(16px) saturate(1.2);
    -webkit-backdrop-filter: blur(16px) saturate(1.2);
    border: 1px solid var(--color-border);
    border-top-color: var(--color-edge);
    border-radius: var(--radius-xl);
    --composer-rest: var(--shadow-composer);
    box-shadow: var(--composer-rest), 0 0 0 3px transparent;
    transition: border-color var(--dur-3) var(--ease-out-quint), box-shadow var(--dur-3) var(--ease-out-quint);
  }

  /* Focus tints the hairline with the accent and lays a faint halo of it around the box. */
  .composer:focus-within { border-color: var(--color-composer-focus); box-shadow: var(--composer-rest), 0 0 0 3px var(--color-composer-halo); }

  /* Editing a sent message: one quiet line above the box, the way out on its right. */
  .editing {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 6px 0 14px;
    color: var(--color-accent);
    font-size: var(--text-xs);
  }
  .editing span { flex: 1; min-width: 0; }

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

  textarea.highlighted { color: transparent; caret-color: var(--color-accent); }
  textarea.highlighted::selection { background: var(--color-accent-soft); }

  textarea, .input-paint {
    width: 100%;
    min-height: 44px;
    max-height: 200px;
    padding: 12px 14px 6px;
    border: none;
    background: transparent;
    font-size: var(--text-reading);
    line-height: var(--leading-reading);
  }

  textarea { display: block; }
  .input-paint { max-height: none; }
  @supports (field-sizing: content) { textarea { field-sizing: content; max-height: min(200px, calc(8lh + 16px)); } }

  textarea:focus {
    outline: none;
    border: none;
  }

  @media (max-width: 720px) {
    .composer { --composer-rest: var(--shadow-e1); border-radius: var(--radius-xl); }
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
