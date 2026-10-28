<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { supportsSideQuestions, type Attachment, type PreviewReference } from '@boite/contracts';
  import { restorePreviewMentions } from '../lib/preview-mentions';
  import { runCommand } from '../lib/commands.svelte';
  import { agentSlashItems, boiteSlashItems, skillSlashItems, slashCompletion, listKey, mentionQueryOf, slashQueryOf, type ChipCommand } from '../lib/composer-menus';
  import { AgentsView, agentOfThread } from '../lib/agents.svelte';
  import { composerPlaceholder } from '../lib/composer-placeholder';
  import { receiveDroppedFiles, takeFiles } from '../lib/composer-attachments';
  import { rewindComposerEdit } from '../lib/composer-edit';
  import { editWhole } from '../lib/reading-window';
  import { fitHeight, selfSizing } from '../lib/composer-size';
  import { editComposerInput, insertImageReference, removeImageReferences, sameSend, sendShape, touchesImageReference, trackImageSend, type SendShape } from '../lib/composer-images';
  import { checkpoint, editKind, recordEdit, resetHistory, settled } from '../lib/composer-history';
  import { boxSelection, closeDraftUndo, copySelection, offerDraftUndo, pasteImages, travel, type EditingHost } from '../lib/composer-editing';
  import { ComposerMentions } from '../lib/composer-mentions.svelte';
  import { isLoading, unresolvedAssetId } from '../lib/draft-attachments';
  import { focusInitial, focusWithin } from '../lib/focus';
  import { touchScreen } from '../lib/device';
  import { ignoreQuestions, noteTyping, repliesOf, replyTarget, sendAnswer } from '../lib/question-reply.svelte';
  import { emptyBox, returnPrompt, sentPrompts, textEntries, type ComposerState, type SentPrompt } from '../lib/composer-queue';
  import { rankItems, type PaletteItem } from '../lib/palette';
  import { clearStash, DRAFT_STASH_KEY, readStash, writeStash } from '../lib/prefs';
  import { claudeKeywords, promptSegments } from '../lib/message-display';
  import { strings } from '../lib/strings';
  import type { Choice, Store } from '../lib/store.svelte';
  import { machineName, workspace } from '../lib/workspace.svelte';
  import ComposerAttachments from './ComposerAttachments.svelte';
  import ComposerImageReferences from './ComposerImageReferences.svelte';
  import ComposerBar from './ComposerBar.svelte';
  import ComposerIntent from './ComposerIntent.svelte';
  import ComposerQueue from './ComposerQueue.svelte';
  import ComposerSpeechPreview from './ComposerSpeechPreview.svelte';
  import MentionMenu from './MentionMenu.svelte';
  import SlashMenu from './SlashMenu.svelte';
  import ThreadActivity from './ThreadActivity.svelte';
  import SideAnswer from './SideAnswer.svelte';
  import { ComposerSide } from '../lib/composer-side.svelte';
  import PreviewReferences from './PreviewReferences.svelte';
  import { chipChoice, queuedChoice, sendToTarget, type ComposerTarget } from '../lib/composer-target';

  /** A centred draft drops the bottom padding so its heading and input form one block. A `target` makes it an agent's box. */
  let { store, centered = false, target = null }: { store: Store; centered?: boolean; target?: ComposerTarget | null } = $props();

  const MAX_LINES = 8, sizesItself = selfSizing();
  const side = new ComposerSide();
  $effect(() => { key; store.client; return () => side.clear(); });
  let key = $derived(target?.key ?? store.openThread?.id ?? DRAFT_STASH_KEY);
  $effect(() => { const left = key; if (left === DRAFT_STASH_KEY) void store.draft?.id; return () => closeDraftUndo(left); }); // A phone's Undo toast ends as the box moves to another draft, new conversations included.
  /** The thread this box sends to: none when it speaks to an agent, whatever thread is open behind it. */
  let thread = $derived(target ? null : store.openThread);
  let composer = $derived(store.composerStates[key]);
  let hasQueue = $derived(!!(composer?.queued.length || thread?.pendingAnswers?.length));
  let activityRoom = $state(0);
  const answerEntries = textEntries();
  let text = $derived(composer?.text ?? '');
  /** The attachments this prompt carries, the same array the strip above the box draws. */
  let attachments = $derived<Attachment[]>(composer?.attachments ?? []);
  let previewReferences = $derived(composer?.previewReferences ?? []);
  let choice = $state<Choice | null>(null);
  let picking = $state(false);
  /** Files still being read into this prompt: their tiles show, Send waits for them. */
  let loadingFiles = $derived(attachments.some(isLoading));
  /** Send pressed while files were still being read: it goes once they are ready, unless the user types on. */
  let sendWhenLoaded = $state.raw<{ store: Store; key: string; state: ComposerState; shape: SendShape; nextDraft: boolean } | null>(null);
  let dictating = $state(false);
  let speechPreview = $state(''), speechStatus = $state(''), speechError = $state(false);
  let box = $state<HTMLTextAreaElement | undefined>(undefined);
  let inputGutter = $state(0), measuredWidth = 0; // The box's scrollbar, which the paint layer leaves out; the width the last fit was for.
  let inputScroll = $state(0);
  let toolbar = $state<ReturnType<typeof ComposerBar> | undefined>(undefined);
  let attachmentStrip = $state<ReturnType<typeof ComposerAttachments> | undefined>();
  let highlightedImage = $state<Attachment | null>(null);
  /** Where ArrowUp stands in this thread's sent prompts, or null outside recall. */
  let recall = $state<number | null>(null);
  let recallRead = $state<Promise<boolean> | null>(null);
  $effect(() => { if (recall === null) recallRead = null; });
  /** The box has the keyboard: one of the two things that open the slash menu. */
  let focused = $state(false);
  /** Escape shuts the menu on text it keeps, until that text changes again. */
  let slashDismissed = $state(false);
  /** The row the keyboard is on in the slash menu. */
  let slashAt = $state(0);
  /** Where the caret stands in the text, kept for the mention menu. */
  let caret = $state(0);
  let pendingEdit: { start: number; end: number } | undefined;
  const mentions = new ComposerMentions();

  const inShell = window.__TAURI_INTERNALS__ !== undefined;
  /** The three commands the composer runs itself: each one opens a chip's menu. */
  const CHIP_COMMANDS: Record<string, ChipCommand> = {
    model: { testid: 'composer-picker', description: strings.slash.model },
    effort: { testid: 'composer-effort', description: strings.slash.effort },
    mode: { testid: 'composer-mode', description: strings.slash.mode }
  };

  /** The chips follow the open thread, or the remembered choice on a draft; an agent's box has none. */
  $effect(() => {
    store.providers;
    store.accounts;
    choice = chipChoice(store, thread, target);
  });

  /** Desktop drafts take the keyboard; touch navigation leaves it closed. */
  $effect(() => {
    key;
    store.draft;
    recall = null;
    focusInitial(box, box?.closest<HTMLElement>('[data-testid=composer]'));
  });

  /** This thread's own sent prompts, most recent first: what ArrowUp walks. */
  let sent = $derived(target ? target.sent : sentPrompts(thread?.messages ?? []));

  let provider = $derived(target ? target.provider : choice ? store.providerOf(choice.providerId) : null);
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
   * A thread whose machine dropped still takes prompts: they wait in its queue on the device and go out
   * once the machine is back. A draft's queue starts its conversation then (`launchQueuedDrafts`); an
   * incognito draft is never kept on the device, so it waits for the machine.
   */
  let offline = $derived(!target && store.connection !== 'ready' && (thread !== null ? !store.draft : !!store.draft && !store.draft.incognito));
  let machineLabel = $derived.by(() => { const found = workspace.machines.find((machine) => machine.store === store); return found ? machineName(found) : strings.machines.local; });
  /**
   * A question waiting for a written answer makes the box its free field: Send
   * answers it with the card's picks, the text and the attachments
   * (`lib/question-reply.svelte.ts`). Editing a sent message takes precedence.
   */
  let reply = $derived(target ? null : replyTarget(store));
  // An answer counts the card's picks, needs no model and cannot wait in the outbox.
  let sendable = $derived(
    (text.trim().length > 0 || attachments.length > 0 || (reply ? !!repliesOf(store).picks[reply.id]?.length : previewReferences.length > 0)) &&
      recallRead === null &&
      !attachments.some(unresolvedAssetId) &&
      (reply !== null || choice !== null || target !== null) &&
      (store.connection === 'ready' || (offline && !reply)) &&
      !picking &&
      !dictating &&
      // A prompt on its way holds back an edit, an answer and a draft's second prompt; on a thread the next one queues.
      !(composer?.sending && (composer.editing || reply !== null || !thread))
  );
  let canSend = $derived(sendable && !loadingFiles);
  $effect(() => {
    const waiting = sendWhenLoaded;
    if (waiting && !loadingFiles) untrack(() => { sendWhenLoaded = null; if (waiting.store === store && waiting.key === key && waiting.state === store.composerStates[key] && sameSend(waiting.shape, sendShape(text, attachments))) void submit(waiting.nextDraft); });
  });
  // Another conversation or machine on screen: the waiting send stays with the box it was pressed in, unsent.
  $effect(() => { void key; void store; untrack(() => { sendWhenLoaded = null; }); });

  /** A persistent agent's own thread: the box is addressed to it by name, and its model, effort and mode live in its settings, not on chips. */
  const bot = $derived(thread?.agentSessionId ? agentOfThread(AgentsView.of(store).snapshot, thread.id)?.name ?? null : null);

  let placeholder = $derived(composerPlaceholder({ target, replying: !!reply, bot, offline, onThread: !!thread, draft: !!store.draft,
    machine: machineLabel, project: store.openProject?.name ?? null, provider: provider?.name ?? null }));

  // -- the slash menu -----------------------------------------------------------
  // `/` on an empty box, then the word being typed: nothing else opens it, and a
  // space or a second line closes it, since the input of a command is not a query.

  let slashQuery = $derived(slashQueryOf(text));

  // -- the mention menu ---------------------------------------------------------
  // `@` at the start of a word, wherever the caret is: the word after it is the
  // query, and the core ranks the project's files on it. The pick writes the
  // path in as `@path`, plain text every agent reads, its own way.

  let mentionQuery = $derived(mentionQueryOf(text, caret, previewReferences));

  /** A mention wins over the slash menu on the odd `/@word`: it is the word under the caret. */
  let slashOpen = $derived(!target && slashQuery !== null && mentionQuery === null && focused && !slashDismissed);

  /** Typing anything takes the box out of the dismissal Escape put it in. */
  $effect(() => {
    void text;
    slashDismissed = false;
    mentions.dismissed = false;
  });

  let mentionOpen = $derived(!target && mentionQuery !== null && focused && !mentions.dismissed);

  /** The project whose files are named: the open thread's, or the draft's. */
  let mentionProject = $derived(target ? null : thread?.projectId ?? store.draft?.projectId ?? null);

  $effect(() => mentions.follow(mentionQuery, mentionProject, store.client));

  let agentItems = $derived.by((): PaletteItem[] => agentSlashItems(thread?.commands ?? []));
  let skillItems = $derived(skillSlashItems(store.brainCommands, thread?.commands ?? [], Object.keys(CHIP_COMMANDS)));

  $effect(() => {
    if (slashOpen) void store.loadBrainCommands();
  });

  /** Boite's prompt controls follow the agent's own commands. */
  let boiteItems = $derived.by((): PaletteItem[] => boiteSlashItems(CHIP_COMMANDS, !!thread && !!provider && supportsSideQuestions(provider.protocol)));

  /** Agent commands first, so a tie goes to the agent's own. */
  let slashItems = $derived(rankItems(slashQuery ?? '', [...agentItems, ...skillItems, ...boiteItems]));
  let commandToken = $derived.by(() => {
    const token = target ? undefined : /^\/[^\s]+/.exec(text)?.[0];
    return token && [...agentItems, ...skillItems, ...boiteItems].some(item => item.label === token) ? token : '';
  });
  let keywords = $derived(claudeKeywords(provider?.protocol, choice?.model));
  let segments = $derived(promptSegments(text, commandToken || undefined, keywords));
  let painted = $derived(segments.some(segment => segment.kind !== 'plain'));
  let highlighted = $derived(painted || previewReferences.length > 0 || attachments.some(item => item.kind === 'image'));

  function syncInput() {
    if (!box) return;
    measuredWidth = box.clientWidth; inputGutter = box.offsetWidth - measuredWidth;
    inputScroll = box.scrollTop;
  }

  $effect(() => {
    const element = box;
    if (!element) return;
    let resizeFrame = 0;
    const observer = new ResizeObserver(() => {
      if (sizesItself || element.clientWidth === measuredWidth) syncInput(); // No height to write: the paint layer's gutter, this frame.
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
    grown = box.value; syncInput(); // The height can toggle the scrollbar, and the paint layer's gutter follows it.
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
    const before = pendingEdit && { ...pendingEdit };
    if (pendingEdit && pendingEdit.start === pendingEdit.end && input.inputType?.startsWith('delete')) {
      if (input.inputType.endsWith('Backward')) pendingEdit.start = element.selectionStart;
      else pendingEdit.end += Math.max(0, text.length - element.value.length);
    }
    // A host whose undo could not be cancelled already rewrote the box: the old path keeps its references.
    const nativeUndo = input.inputType === 'historyUndo' || input.inputType === 'historyRedo';
    const state = stateForInput(); noteTyping(store, key); closeDraftUndo();
    const prior = { text: state.text, attachments: state.attachments.length };
    // Still writing: a send pressed while files were loading waits for the next Send.
    sendWhenLoaded = null;
    // The state still holds the text before this edit: that is the step undo returns to.
    const kind = nativeUndo ? null : touchesImageReference(state.text, state.attachments, pendingEdit) ? 'big' : editKind(input.inputType, pendingEdit);
    if (kind) recordEdit(state, kind, before, input.data ?? null);
    const whole = editComposerInput(store, key, element, nativeUndo, pendingEdit);
    settled(state);
    if (kind === 'big' && !state.text && !state.attachments.length) offerDraftUndo(editing(), prior, strings.composer.draftCleared);
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

  /** Writes a recalled or restored prompt in, caret at its end. One undo step, with whatever else the caller changes. */
  function put(value: string, at = value.length) {
    checkpoint(stateForInput());
    setText(value);
    const el = box;
    if (el) {
      el.value = value;
      el.selectionStart = el.selectionEnd = at;
    }
    caret = at;
    requestAnimationFrame(grow);
  }

  /** What the composer's own edits write to (`lib/composer-editing.ts`). An answer's files reach the agent as paths, so it takes images whatever the provider reads. */
  function editing(): EditingHost {
    return { store, key, box, state: stateForInput(), provider: reply ? null : provider,
      moved: (at) => { caret = at; recall = null; if (!sizesItself) grow(); else syncInput(); }, shown: () => key };
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
    if (loadingFiles) { if (sendable) sendWhenLoaded = { store, key, state: stateForInput(), shape: sendShape(text, attachments), nextDraft }; return; }
    const prompt = text;
    const images = attachments;
    const references = previewReferences;
    if (reply) {
      const answeredKey = key;
      if (canSend && await sendAnswer(store, reply)) {
        const answered = store.composerStates[answeredKey];
        if (answered) resetHistory(answered);
        recall = null; requestAnimationFrame(grow);
      }
      return;
    }
    if (target) {
      if (canSend && await sendToTarget(target, stateForInput(), prompt, images)) recall = null;
      requestAnimationFrame(grow);
      return;
    }
    if (!canSend || !choice) return;
    const inputStore = store, inputKey = key, sendChoice = choice;
    const state = stateForInput();
    if (side.submit(inputStore, inputKey, prompt)) { requestAnimationFrame(grow); return; }
    const editedThread = state.editing ? inputStore.openThread : null;
    const edited = state.editing ? await rewindComposerEdit(inputStore, inputKey, state, prompt, images, references) : null; if (edited === false) return;
    // The queue keeps this prompt behind earlier entries; sending resumes a paused queue.
    if (!editedThread && (inputStore.busy || state.queued.length > 0 || state.sending || offline)) {
      // Written while the machine is away, it joins the outbox: its own request id and the chips' model and effort.
      // Every queued prompt keeps the chips it was written with: a later change of the picker does not redirect it.
      // Chips that only show what the thread resolves to keep the thread's own selection, so the prompt can steer a turn left on the agent's default.
      const kept = queuedChoice(inputStore, inputStore.openThread?.id === inputKey ? inputStore.openThread : null, $state.snapshot(sendChoice));
      inputStore.queuePrompt(inputKey, { text: prompt, attachments: images, afterBoundary: store.inputBoundaries[key]?.boundary, choice: kept, ...(references.length ? { previewReferences: references } : {}) },
        offline ? { choice: { ...kept } } : undefined);
      state.editing = null;
      emptyBox(state);
      resetHistory(state);
      recall = null;
      requestAnimationFrame(grow);
      return;
    }
    state.sending = true;
    const finishImageSend = trackImageSend(state, prompt, images);
    // The box empties and the prompt joins the timeline now; the core's answer only ticks its receipts. A `/goal` writes no message.
    const local = edited ? edited.local : inputStore.stageSend(inputKey, prompt, images, references);
    // Undo never brings back a prompt that left.
    if (local) { emptyBox(state); resetHistory(state); recall = null; requestAnimationFrame(grow); }
    // A rewind's replacement belongs to the captured thread and machine, even after navigation.
    const accepted = await (editedThread
      ? inputStore.send(prompt, inputKey, images, references)
      : nextDraft
        ? inputStore.submitAndDraft(prompt, sendChoice, images, references)
        : inputStore.submit(prompt, sendChoice, images, references));
    if (accepted && editedThread && nextDraft && inputStore.openThread?.id === inputKey) {
      inputStore.startDraft(editedThread.projectId, { fresh: true });
      inputStore.draftChoice = { ...sendChoice };
    }
    finishImageSend(accepted);
    // A command clears only what it went out with. A refused or lost prompt leaves the timeline for the box, or the head of the queue.
    if (accepted && !local) {
      if (state.text === prompt) state.text = '';
      if (state.attachments === images) state.attachments = [];
      if (state.text === '') resetHistory(state);
      state.paused = false;
    } else if (!accepted && local) { inputStore.unstageSend(local); returnPrompt(state, prompt, images, references); }
    if (accepted) recall = null;
    requestAnimationFrame(grow);
    state.sending = false;
  }

  // -- attachments -----------------------------------------------------------------
  // Three ways in, one path: the attach button, pasted files,
  // and files dropped on the box. `lib/attachments.ts` owns the caps.

  /** Each file shows at once as a loading tile, its `[Image N]` at the caret, and is read behind the box. */
  function take(files: File[]) {
    if (files.length === 0) return;
    track();
    // An answer's files reach the agent as paths, so it takes images whatever the provider reads.
    const taken = stateForInput();
    void takeFiles(store, taken, files, reply ? null : provider, () => { if (sendWhenLoaded?.state === taken) sendWhenLoaded = null; });
  }

  function onpaste(event: ClipboardEvent) {
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) { pasteImages(editing(), event); return; }
    // The text of a clipboard that also carries an image stays out of the box.
    event.preventDefault();
    void take(files);
  }

  $effect(() => receiveDroppedFiles(take)); // File drops belong to the composer, in the shell too (`lib/native-drop.ts`).
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
    checkpoint(state);
    // The keyboard's remove button goes with its chip, so focus returns to the box; a tap leaves it, which would open a phone's keyboard.
    const refocus = focusWithin(box?.closest('[data-testid="composer"]'));
    removeImageReferences(store, key, at);
    state.attachments = state.attachments.filter((_, index) => index !== at);
    if (!state.text.trim() && !state.attachments.length) offerDraftUndo(editing(), { text: '', attachments: 1 }, strings.composer.draftCleared);
    if (refocus) focusInitial(box, box?.closest<HTMLElement>('[data-testid=composer]'));
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
  let boxEmpty = $derived(text.trim().length === 0 && attachments.length === 0 && previewReferences.length === 0 && !dictating);

  /**
   * What Send now does to the queue: steer the running turn, resume it
   * after a refusal held it, or nothing while a pending prompt is going out.
   */
  let sendNow = $derived<'steer' | 'resume' | null>(
    !composer?.queued.length || composer.sending || store.connection !== 'ready' || !thread ? null
      // A refused outbox prompt has its own Send again; one written offline is a turn of its own, not steering.
      : composer.queued[0]!.request?.failed !== undefined ? null
      : thread.status === 'running' ? (composer.queued[0]!.request ? null : 'steer') : store.busy ? null : composer.paused ? 'resume' : null
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

  /** An idle thread recalls a fully hydrated edit; a running thread recalls words to queue. */
  function recallPrompt(prompt: SentPrompt) {
    const state = stateForInput();
    const edit = !store.busy && state.queued.length === 0 && thread !== null && (!!thread.agentSessionId || thread.projectId !== null);
    if (edit) {
      const owner = store, inputKey = key, at = recall;
      const message = thread?.messages.find(message => message.id === prompt.id);
      if (!message) return;
      checkpoint(state);
      const loading = editWhole(owner, inputKey, message, () => store === owner && key === inputKey && recall === at && recallRead === loading);
      recallRead = loading;
      void loading.then(applied => {
        if (applied) { caret = state.text.length; requestAnimationFrame(grow); }
      }).finally(() => { if (recallRead === loading) recallRead = null; });
      return;
    }
    recallRead = null;
    restorePrompt(prompt.text, prompt.previewReferences);
    if (state.editing) state.attachments = [];
    state.editing = null;
  }

  /** Leaves edit mode: the box empties, nothing was rewound. */
  function cancelEdit() {
    const state = stateForInput();
    checkpoint(state);
    state.editing = null;
    state.attachments = [];
    state.previewReferences = [];
    recall = null; recallRead = null;
    put('');
    focusInitial(box, box?.closest<HTMLElement>('[data-testid=composer]'));
  }

  function restoreQueued(at: number) {
    const state = composer;
    if (!state || state.sending || text.length > 0 || attachments.length > 0 || previewReferences.length > 0) return;
    const entry = store.restoreQueued(key, at);
    if (!entry) return;
    checkpoint(state);
    state.attachments = entry.attachments;
    recall = null;
    restorePrompt(entry.text, entry.previewReferences ?? []);
    box?.focus({ preventScroll: true });
  }

  /** ArrowDown: one prompt newer, and past the newest the composer is empty again. */
  function newer(): boolean {
    if (recall === null) return false;
    const next = recall - 1;
    if (next < 0) {
      recall = null;
      const state = stateForInput();
      checkpoint(state);
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
    const stashKey = store.threadKey(key);
    if (text.trim().length > 0) {
      writeStash(stashKey, text);
      recall = null;
      // The text set aside is plain text: the next prompt typed is not an edit of a sent one.
      const state = stateForInput();
      checkpoint(state);
      if (state.editing) { state.editing = null; state.attachments = []; }
      put('');
      return;
    }
    const stashed = readStash(stashKey);
    if (stashed === null) return;
    clearStash(stashKey);
    recall = null;
    put(stashed);
  }

  /** Prompt commands complete the box; other commands execute and close the menu. */
  function pickSlash(item: PaletteItem) {
    const completion = slashCompletion(item);
    if (completion !== null) {
      put(completion);
      box?.focus({ preventScroll: true });
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
    box?.focus({ preventScroll: true });
  }

  /**
   * The keys of whichever menu is open. True when the key was ours: Escape
   * shuts it on the text as typed, Enter and Tab take the row, the arrows move.
   */
  function menuKey(event: KeyboardEvent): boolean {
    if (mentionOpen) {
      return listKey(event, mentions.items, mentions.at, (index) => (mentions.at = index), () => (mentions.dismissed = true), pickMention);
    }
    if (slashOpen) {
      return listKey(event, slashItems, slashAt, (index) => (slashAt = index), () => (slashDismissed = true), pickSlash);
    }
    return false;
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    const meta = event.ctrlKey || event.metaKey;
    // Ahead of the modifier return below: the box's undo is the composer's, never the textarea's.
    const letter = event.key?.toLowerCase();
    if (meta && !event.altKey && (letter === 'z' || letter === 'y') && !store.isKey(event, 'send-and-draft') && !store.isKey(event, 'stash')) {
      event.preventDefault();
      travel(editing(), letter === 'z' && !event.shiftKey);
      return;
    }
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
    if (event.key === 'Enter' && !event.shiftKey && !touchScreen()) {
      event.preventDefault();
      if (boxEmpty && sendNow && !reply) sendQueuedNow();
      else void submit();
    } else if (event.key === 'ArrowUp' && !event.shiftKey) {
      if (older()) event.preventDefault();
    } else if (event.key === 'ArrowDown' && !event.shiftKey) {
      if (newer()) event.preventDefault();
    } else if (event.key === 'Escape' && !reply && (target ? target.busy && !!target.stop : store.busy || thread?.activity?.goal?.status === 'active' || thread?.activity?.loop?.status === 'active')) {
      // Not while the box answers a question: a thread waiting on one opens
      // with the focus there, and an Escape pressed out of habit threw the
      // question away with the turn. Skip and the stop button still end it.
      event.preventDefault();
      if (target) target.stop?.(); else void store.stop();
    } else if (event.key === 'Escape' && (composer?.editing || recallRead !== null)) {
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
    {#if thread?.pendingAnswers?.length}
      <div data-testid="question-queued">
        <ComposerQueue queued={answerEntries(thread.pendingAnswers)} disabled={true} paused={false} sendNow={null} onrestore={() => {}} onsendnow={() => {}} />
      </div>
    {/if}
    {#if composer && composer.queued.length > 0}
      <ComposerQueue queued={composer.queued}
        disabled={composer.sending || text.length > 0 || attachments.length > 0 || previewReferences.length > 0}
        paused={composer.paused} sending={composer.sending} outgoing={composer.outgoing ?? 0} connected={store.connection === 'ready'} machine={machineLabel} starts={!thread}
        {sendNow}
        onrestore={restoreQueued} onremove={(at) => store.removeQueued(key, at)} onretry={(at) => store.retryQueued(key, at)}
        onsendnow={sendQueuedNow} />
    {/if}
  </div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="composer" class:dictating data-testid="composer" tabindex="-1" {ondragover} {ondrop} onkeydown={(event) => {
    if (event.target !== event.currentTarget || event.key !== 'Escape') return;
    // The touch focus target shares the box's Escape handling, including pending questions.
    onkeydown(event);
    event.stopPropagation();
  }}>
    {#if !target}<ThreadActivity {store} reserveInComposer={hasQueue} onroom={(height) => (activityRoom = height)} />{/if}
    <ComposerIntent editing={!!composer?.editing} reply={reply?.async && reply.id === repliesOf(store).docked ? null : reply} oncancel={cancelEdit} onignore={() => ignoreQuestions(store)} />

    {#if side.current && side.current.threadId === thread?.id}<SideAnswer {...side.current} {store} onclose={() => { side.clear(); focusInitial(box, box?.closest<HTMLElement>('[data-testid=composer]')); }} />{/if}
    {#if attachments.length > 0}
      {#key composer}<ComposerAttachments bind:this={attachmentStrip} {attachments} highlighted={highlightedImage} onremove={removeAttachment} onfocus={() => focusInitial(box, box?.closest<HTMLElement>('[data-testid=composer]'))} />{/key}
    {/if}

    <div class="input-wrap">
    {#if highlighted}
      <div class="input-highlight" aria-hidden={previewReferences.length || attachments.length ? undefined : true} data-testid="composer-highlight" style:right={`${inputGutter}px`}>
        <div class="input-paint input-mirror" style:transform={`translateY(${-inputScroll}px)`}><PreviewReferences {text} references={previewReferences} {store} threadId={key} editing {keywords} command={commandToken || undefined} onreference={(reference) => {
          if (box && reference.mention) { box.focus({ preventScroll: true }); box.setSelectionRange(reference.mention.end, reference.mention.end); track(); }
        }}>{#snippet paint(parts)}<ComposerImageReferences segments={parts} {attachments} onopen={(attachment) => attachmentStrip?.open(attachment)} onhover={(attachment) => highlightedImage = attachment} />{/snippet}</PreviewReferences>{'\n'}</div>
      </div>
    {/if}
    <textarea
      class:highlighted
      bind:this={box}
      value={text}
      onbeforeinput={(event) => {
        if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') { event.preventDefault(); travel(editing(), event.inputType === 'historyUndo'); return; }
        pendingEdit = boxSelection(box);
      }}
      oncopy={(event) => copySelection(editing(), event, false)}
      oncut={(event) => copySelection(editing(), event, true)}
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
      items={mentions.items}
      selected={mentions.at}
      more={mentions.more}
      onpick={pickMention}
      onhover={(index) => (mentions.at = index)}
    />

    <ComposerSpeechPreview status={speechStatus} preview={speechPreview} error={speechError} />

    <ComposerBar bind:this={toolbar} {store} {key} {target} {bot} {provider} canSend={sendable} waiting={sendWhenLoaded !== null} answering={!!reply} sendLabel={reply ? strings.composer.replySend : undefined} bind:choice bind:picking bind:dictating
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

  /* A translucent surface with a top reflection. Focus lights its edge and lays a bloom under it: app.css, beside its themes. */
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
    /* The bar's chips read the composer's own width: the side panel narrows it on a wide window. */
    container: composer / inline-size;
    --composer-rest: var(--shadow-composer);
    box-shadow: var(--composer-rest);
    transition: border-color var(--dur-3) var(--ease-out-quint), box-shadow var(--dur-3) var(--ease-out-quint);
  }

  .input-wrap { position: relative; }

  .input-highlight {
    position: absolute;
    inset: 0; /* Stretched by CSS: clientWidth is rounded, and 0.4 px off broke lines a word apart, the caret trailing the paint. */
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
    /* A textarea's own text-rendering: auto drops kerning on Android, and the caret drifted from the painted letters. */
    text-rendering: optimizeLegibility; font-kerning: normal; font-variant-ligatures: normal; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; width: 100%;
    min-height: var(--composer-input-height, 44px);
    max-height: 200px;
    padding: var(--composer-input-padding, 12px 14px 6px);
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
    textarea, .input-mirror { font-size: var(--text-md); }
    .composer-wrap, .composer-wrap.centered {
      padding: 8px 12px max(10px, env(safe-area-inset-bottom));
    }

    :global(html[data-keyboard='open']) .composer-wrap { padding-bottom: 8px; }
  }
</style>
