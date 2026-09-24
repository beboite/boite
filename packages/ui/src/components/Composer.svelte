<script lang="ts">
  import { ArrowUp, FileText, GitBranch, Paperclip, ShieldCheck, Square, X } from '@lucide/svelte';
  import { tick, untrack } from 'svelte';
  import type { Attachment, PermissionMode, PreviewReference } from '@boite/contracts';
  import { restorePreviewMentions } from '../lib/preview-mentions';
  import { bytes, tokens as formatTokens } from '../lib/format';
  import { confirm } from '../lib/confirm.svelte';
  import { switchDropsHistory, switchResetsCache, type CacheKey } from '../lib/switch-warning';
  import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_TURN } from '@boite/contracts';
  import { acceptAttachments, decodedBytes, readAttachmentFile } from '../lib/attachments';
  import { AGENT_PREFIX, appCommands, isAgentCommand, runCommand } from '../lib/commands.svelte';
  import { rankItems, type PaletteItem } from '../lib/palette';
  import { clearStash, DRAFT_STASH_KEY, readStash, writeStash } from '../lib/prefs';
  import { claudeKeywords, promptSegments, promptText } from '../lib/message-display';
  import { fill, strings } from '../lib/strings';
  import type { Choice, PickPatch, Store } from '../lib/store.svelte';
  import EffortSlider from './EffortSlider.svelte';
  import Menu from './Menu.svelte';
  import ModelPicker from './ModelPicker.svelte';
  import MentionMenu from './MentionMenu.svelte';
  import SlashMenu from './SlashMenu.svelte';
  import ThreadActivity from './ThreadActivity.svelte';
  import Dictation from './Dictation.svelte';
  import ComposerOptions from './ComposerOptions.svelte';
  import PreviewReferences from './PreviewReferences.svelte';

  /**
   * `centered` is the draft's placement: the parent stacks the composer under
   * the heading and centres the pair, so the wrapper drops the padding that
   * holds it off the bottom of the column. Same component, same box.
   */
  let { store, centered = false }: { store: Store; centered?: boolean } = $props();

  const MODES: PermissionMode[] = ['bypassPermissions', 'acceptEdits', 'default'];
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
      untrack(() => void drain(threadId, state));
    }
  });

  /** This thread's own sent prompts, most recent first: what ArrowUp walks. */
  let sent = $derived(
    (store.openThread?.messages ?? [])
      .filter((message) => message.role === 'user')
      .map((message) => ({ text: message.parts
          .filter((part) => part.type === 'text')
          .map((part) => (part.type === 'text' ? promptText(part) : ''))
          .join('\n'), previewReferences: message.parts.flatMap(part => part.type === 'text' ? part.previewReferences ?? [] : [])
      }))
      .filter((prompt) => prompt.text.length > 0 || prompt.previewReferences.length > 0)
      .reverse()
  );

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
  let bound = $derived(store.openThread !== null);
  /** Every agent can read uploaded files through its local tools. */
  let canAttach = $derived(provider !== null && provider !== undefined);
  let canSend = $derived(
    (text.trim().length > 0 || attachments.length > 0 || previewReferences.length > 0) &&
      readingFiles === 0 &&
      choice !== null &&
      store.connection === 'ready' &&
      !picking &&
      !dictating &&
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
    if (previewReferences.some(reference => reference.mention && caret > reference.mention.start && caret <= reference.mention.end)) return null;
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
    (store.openThread?.commands ?? []).filter((command) => !['goal', 'loop'].includes(command.name)).map((command) => ({
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
    { id: 'goal', kind: 'command', label: '/goal', description: strings.activity.goalDescription },
    { id: 'loop', kind: 'command', label: '/loop', description: strings.activity.loopDescription },
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
  let commandToken = $derived.by(() => {
    const token = /^\/[^\s]+/.exec(text)?.[0];
    return token && [...agentItems, ...boiteItems].some(item => item.label === token) ? token : '';
  });
  let segments = $derived(promptSegments(text, commandToken || undefined, claudeKeywords(provider?.protocol, choice?.model)));
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

  // Older modes keep their execution policy until the user makes a choice.
  let displayedMode = $derived<PermissionMode>(choice?.permissionMode ?? 'default');
  let modeItems = $derived(
    MODES.map((mode) => ({
      id: mode,
      label: strings.permissionMode[mode],
      hint: strings.permissionModeLong[mode],
      active: displayedMode === mode
    }))
  );

  // The reasoning chip belongs to the model the choice is on, and a model that
  // offers no scale (an agent that keeps its own) gets no chip at all.
  let effortLevels = $derived((store.modelOf(choice)?.effort?.levels ?? []).filter(level => provider?.protocol === 'claude-sdk' || level.id !== 'ultrathink'));
  let speeds = $derived(store.modelOf(choice)?.speeds ?? []);
  let activeEffort = $derived(choice?.effort ?? store.modelOf(choice)?.effort?.default ?? null);

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

  function grow() {
    const el = box;
    if (!el) return;
    el.style.height = 'auto';
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.height = `${Math.min(el.scrollHeight, line * MAX_LINES + 16)}px`;
    syncInput();
  }

  // Context inserted from a preview changes the shared draft without an input
  // event. Measure after Svelte has written that text into the textarea.
  $effect(() => {
    void text;
    if (!box) return;
    let current = true;
    void tick().then(() => { if (current) grow(); });
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

  async function drain(threadId: string, state: NonNullable<typeof composer>) {
    const entry = state.queued[0];
    if (entry === undefined) return;
    state.sending = true;
    const accepted = await store.send(entry.text, threadId, entry.attachments, entry.previewReferences ?? []);
    if (accepted) state.queued.shift();
    else {
      // Pause after a refusal. The prompt goes back in the box for an explicit
      // retry only when it is the whole queue: taking it out from under the
      // ones behind it would send them in the order they were not typed in.
      state.paused = true;
      if (state.queued.length === 1 && state.text.length === 0 && state.attachments.length === 0 && !state.previewReferences?.length) {
        const back = state.queued.shift()!;
        state.text = back.text;
        state.attachments = back.attachments;
        state.previewReferences = back.previewReferences ?? [];
      }
    }
    state.sending = false;
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

  /**
   * Reads files one at a time, checking their sizes before allocating base64.
   */
  async function take(files: File[]) {
    if (files.length === 0) return;
    const state = stateForInput();
    const attachmentProvider = provider;
    readingFiles += 1;
    try {
    for (const file of files) {
      if (file.size > ATTACHMENT_MAX_BYTES) {
        store.error = fill(strings.composer.attachTooLarge, { name: file.name, max: bytes(ATTACHMENT_MAX_BYTES) });
        continue;
      }
      if (state.attachments.length >= ATTACHMENTS_PER_TURN) {
        store.error = fill(strings.composer.attachTooMany, { name: file.name, max: String(ATTACHMENTS_PER_TURN) });
        break;
      }
      try {
        const attachment = await readAttachmentFile(file);
        if (attachment.kind === 'image' && attachmentProvider && !attachmentProvider.capabilities.images) {
          store.error = fill(strings.composer.attachNoImages, { provider: attachmentProvider.name });
          continue;
        }
        const { accepted, refused } = acceptAttachments(state.attachments, [attachment]);
        state.attachments = accepted;
        if (refused !== null) store.error = refused;
      } catch {
        store.error = fill(strings.composer.attachReadError, { name: file.name });
      }
    }
    } finally { readingFiles -= 1; }
  }

  function onchoose(event: Event) {
    const field = event.currentTarget as HTMLInputElement;
    const files = Array.from(field.files ?? []);
    // The same picture picked twice in a row must fire `change` both times.
    field.value = '';
    void take(files);
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
      void openChip(chip.testid);
      return;
    }
    runCommand(store, item.id, inShell);
  }

  /** The chip's own trigger opens its menu: one popover, owned by one component. */
  async function openChip(testid: string) {
    await tick();
    const bar = box?.closest('[data-testid="composer"]');
    if (window.matchMedia('(max-width: 720px)').matches && testid !== 'composer-picker') testid = 'composer-options';
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
      <div class="queued" data-testid="composer-queued">
        <span class="subtle">{strings.composer.queued}</span>
        {#each composer.queued as entry, at (entry)}
          <button type="button" class="ghost queued-entry"
            title={strings.composer.editQueued}
            disabled={composer.sending || text.length > 0 || attachments.length > 0 || previewReferences.length > 0}
            onclick={() => restoreQueued(at)}>
            <span>{entry.text || strings.composer.attachAlt}</span>
            {#if entry.attachments.length}<span class="subtle">{entry.attachments.length} <Paperclip size={12} /></span>{/if}
            {#if entry.previewReferences?.length}<span class="subtle">@{entry.previewReferences.length}</span>{/if}
            <ArrowUp size={12} />
          </button>
        {/each}
      </div>
    {/if}

    {#if attachments.length > 0}
      <div class="attachments" data-testid="composer-attachments">
        {#each attachments as attachment, at (at)}
          {@const label = attachment.name ?? strings.composer.attachAlt}
          <div class="attachment" class:document={attachment.kind === 'file'} data-testid="composer-attachment" title={label}>
            {#if attachment.kind === 'image'}
              <img src="data:{attachment.mimeType};base64,{attachment.data}" alt={label} />
            {:else}
              <FileText size={20} strokeWidth={1.5} />
              <span class="file-info"><span>{label}</span><small>{bytes(decodedBytes(attachment.data))}</small></span>
            {/if}
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

    <div class="input-wrap">
    {#if painted || previewReferences.length}
      <div class="input-highlight" aria-hidden={previewReferences.length ? undefined : true} data-testid="composer-highlight" style:width={`${inputWidth}px`}>
        <div class="input-paint input-mirror" style:transform={`translateY(${-inputScroll}px)`}>{#if previewReferences.length}<PreviewReferences {text} references={previewReferences} {store} threadId={key} editing onreference={(reference) => {
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

    <div class="bar">
      {#key `${key}:${store.draft?.projectId ?? ''}`}
      <ComposerOptions busy={picking} levels={effortLevels} effort={activeEffort} {speeds} speed={choice?.speed ?? null} mode={displayedMode} worktree={store.draft ? store.draft.worktree : null} {canAttach} onattach={() => picker?.click()} oneffort={pickEffort} onspeed={(speed) => void pick({ speed })} onmode={pickMode} onworktree={() => store.setDraftWorktree(!store.draft?.worktree)} />
      {/key}
      <div class="chips">
        <ModelPicker {store} {choice} disabled={picking} onpick={pick} />

        <div class="desktop-options">
        {#if effortLevels.length > 0 || speeds.length > 0}
          <EffortSlider levels={effortLevels} active={activeEffort} onpick={pickEffort} {speeds} speed={choice?.speed ?? null} onspeed={(speed) => void pick({ speed })} />
        {/if}

        <Menu items={modeItems} onpick={pickMode} label={strings.composer.mode} testid="composer-mode" align="end">
          <ShieldCheck size={14} strokeWidth={1.75} />
          {strings.permissionMode[displayedMode]}
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
          <Dictation {store} onbusy={(busy) => dictating = busy} onpreview={(text, status, error) => { speechPreview = text; speechStatus = status; speechError = error; }} ontext={(transcript) => {
            const current = stateForInput().text;
            put(current + (current && !/\s$/.test(current) ? ' ' : '') + transcript);
          }} />
        {/key}
      {/key}
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

  .queued {
    padding: 6px 14px 0;
    font-size: var(--text-sm);
  }

  .queued-entry { display: flex; gap: 8px; width: 100%; text-align: left; min-width: 0; }
  .queued-entry > span:first-child { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .queued-entry > span { display: inline-flex; align-items: center; gap: 4px; }

  /* The attachments this prompt carries, above the box they were pasted into. */
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

  .attachment.document { width: min(240px, 100%); display: flex; align-items: center; gap: 10px; padding: 0 48px 0 12px; }
  .file-info { min-width: 0; display: flex; flex-direction: column; gap: 3px; font-size: var(--text-sm); }
  .file-info > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-info small { color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .attachment.document .remove { width: 44px; height: 44px; top: 5px; right: 0; background: transparent; }
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
    .composer { box-shadow: none; border-radius: var(--radius-xl); }
    .composer:focus-within { box-shadow: none; border-color: var(--color-edge); }
    .send, .stop { border-radius: 50%; margin-left: 2px; }
    .dictating .send { display: none; }
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
