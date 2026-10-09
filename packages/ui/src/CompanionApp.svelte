<!--
  The desktop companion's window (`companion_window.rs`): a transparent strip
  at the top of a screen, with the character, its reply bubble, the music it
  hears and, once opened, a field to ask it something and the requests agents
  are waiting on. Only the areas marked `data-hit` take clicks; the rest of the
  window lets them through to what is under it.

  The companion talks through an ordinary thread in the drafts project
  (`lib/companion/brain.ts`), so its agent runs the way every thread runs,
  through the core's account and subscription proxy.
-->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { PermissionRequest, QuestionRequest, ThreadSummary } from '@boite/contracts';
  import { WsClient, type Client, type ClientState } from './lib/client';
  import { resolveEndpoint } from './lib/endpoint';
  import { startTheme } from './lib/theme';
  import { fill, strings } from './lib/strings';
  import { readCompanionPrefs, subscribeCompanionPrefs, writeCompanionPrefs, type CompanionPrefs } from './lib/companion/prefs';
  import { createMoodTracker, isWorking, RESTING, type MoodInput, type MoodState } from './lib/companion/mood';
  import { COMPANION_THREAD_TITLE, permissionModeOf, pickBrain, promptFor } from './lib/companion/brain';
  import { readMedia, pressMedia, type MediaAction, type MediaState } from './lib/companion/media';
  import { companionHitRects, inShell, placeCompanion, showMain, type HitRect } from './lib/companion/shell';
  import CompanionCharacter from './components/companion/CompanionCharacter.svelte';
  import CompanionPanel, { type PanelAction } from './components/companion/CompanionPanel.svelte';
  import MediaPill from './components/companion/MediaPill.svelte';
  import { Settings, Square, ExternalLink, X, ArrowUp } from '@lucide/svelte';

  const CELEBRATE_MS = 6000;
  const REFRESH_EVERY = 15_000;
  const MEDIA_EVERY = 2000;
  const HIT_PAD = 6;

  let prefs = $state<CompanionPrefs>(readCompanionPrefs());
  let threads = $state.raw<ThreadSummary[]>([]);
  let projects = $state.raw(new Map<string, string>());
  let permissions = $state.raw<PermissionRequest[]>([]);
  let questions = $state.raw<QuestionRequest[]>([]);
  let mood = $state<MoodState>(RESTING);
  let media = $state<MediaState | null>(null);
  let hover = $state(false);
  let open = $state(false);
  let boing = $state(0);
  let draft = $state('');
  let input = $state<HTMLInputElement | null>(null);

  // The reply bubble: the text parts of the agent's last message, by index.
  type Phase = 'none' | 'thinking' | 'streaming' | 'done' | 'error';
  let phase = $state<Phase>('none');
  let parts = $state<string[]>([]);
  let replyId: string | null = null;
  // The message being written, part by part with each part's type: deltas also
  // stream reasoning and tool input, which the bubble leaves out. The bubble
  // keeps the previous message until this one has text.
  let buffer: string[] = [];
  let kinds: string[] = [];
  let problem = $state('');
  let shown = $state(false);
  // The turn has been seen running, so an idle thread now means it finished.
  let sawRunning = false;

  const reply = $derived(parts.filter(Boolean).join('').trim());
  const thinking = $derived(phase === 'thinking' || phase === 'streaming');
  const finished = $derived(
    mood.justFinished.filter((id) => id !== prefs.threadId).map((id) => threads.find((thread) => thread.id === id)?.title || strings.companion.untitled)
  );

  let client: Client | null = null;
  let reachable = $state(true);
  let disposed = false;
  let autoOpened = false;
  let seen: Set<string> | null = null;
  let subscribed: string | null = null;
  const tracker = createMoodTracker({ celebrateMs: CELEBRATE_MS });

  // ---------------------------------------------------------------------
  // What the core reports
  // ---------------------------------------------------------------------

  function recompute() {
    const input: MoodInput | null = reachable ? { threads, permissions, questions } : null;
    mood = tracker.update(input);
  }

  let celebrateTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    if (mood.justFinished.length === 0) return;
    clearTimeout(celebrateTimer);
    celebrateTimer = setTimeout(recompute, CELEBRATE_MS + 100);
  });

  /** Opens the panel when an agent stops on something new; closes it once nothing waits. */
  function followRequests() {
    const blocking = new Set([...permissions.map((request) => request.id), ...questions.filter((question) => !question.async).map((question) => question.id)]);
    if (seen !== null && [...blocking].some((id) => !seen!.has(id))) {
      if (!open) autoOpened = true;
      open = true;
    }
    if (blocking.size === 0 && autoOpened && draft === '') {
      open = false;
      autoOpened = false;
    }
    seen = blocking;
  }

  async function readProjects() {
    if (!client) return;
    const list = await client.call('projects.list', {});
    projects = new Map(list.map((project) => [project.id, project.name]));
  }

  async function refresh() {
    if (!client || disposed) return;
    try {
      const [threadList, permissionList, questionList] = await Promise.all([
        client.call('threads.list', {}),
        client.call('permissions.list', {}),
        client.call('questions.list', {})
      ]);
      if (disposed) return;
      threads = threadList;
      permissions = permissionList;
      questions = questionList;
      reachable = true;
      if (threadList.some((thread) => thread.projectId && !projects.has(thread.projectId))) await readProjects();
      followOwnThread();
      followRequests();
    } catch {
      reachable = false;
    }
    recompute();
  }

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  function soon(delay = 250) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refresh(), delay);
  }

  /** A thread that changed: its status counts at once, the requests are read again a moment later. */
  function acceptThread(thread: ThreadSummary) {
    threads = threads.some((entry) => entry.id === thread.id) ? threads.map((entry) => (entry.id === thread.id ? thread : entry)) : [...threads, thread];
    followOwnThread();
    recompute();
    soon();
  }

  // ---------------------------------------------------------------------
  // The conversation
  // ---------------------------------------------------------------------

  function followOwnThread() {
    const own = prefs.threadId ? threads.find((thread) => thread.id === prefs.threadId) : undefined;
    if (!own || !thinking) return;
    if (isWorking(own.status)) sawRunning = true;
    else if (sawRunning) settle('done');
  }

  function showBuffer() {
    if (buffer.some(Boolean)) parts = [...buffer];
  }

  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  function settle(next: 'done' | 'error') {
    phase = next;
    holdReply();
  }

  /** A finished reply stays long enough to read, and as long as the pointer is on the companion. */
  function holdReply() {
    clearTimeout(hideTimer);
    if (phase !== 'done' || hover) return;
    hideTimer = setTimeout(() => (shown = false), Math.max(8000, reply.length * 70));
  }

  async function subscribe(threadId: string | null) {
    if (!client || threadId === subscribed) return;
    if (subscribed) void client.call('threads.unsubscribe', { threadId: subscribed }).catch(() => {});
    subscribed = threadId;
    if (!threadId) return;
    try {
      await client.call('threads.subscribe', { threadId });
    } catch {
      // The thread is gone (deleted, or this is another core): the next request starts a new one.
      subscribed = null;
      if (readCompanionPrefs().threadId === threadId) prefs = writeCompanionPrefs({ threadId: null });
    }
  }

  async function ensureThread(): Promise<{ threadId: string; first: boolean } | null> {
    if (!client) return null;
    const known = prefs.threadId;
    if (known && (threads.length === 0 || threads.some((thread) => thread.id === known))) return { threadId: known, first: false };
    const [providers, accounts] = await Promise.all([client.call('providers.list', {}), client.call('accounts.list', {})]);
    const brain = pickBrain(prefs, providers.loaded, accounts);
    if (!brain) {
      problem = prefs.providerId === null ? strings.companion.noBrain : strings.companion.brainOff;
      return null;
    }
    const drafts = await client.call('projects.drafts', {});
    const thread = await client.call('threads.create', {
      projectId: drafts.id,
      providerId: brain.providerId,
      accountId: brain.accountId,
      title: COMPANION_THREAD_TITLE,
      ...(brain.model ? { model: brain.model } : {}),
      effort: brain.effort,
      permissionMode: permissionModeOf(prefs.control)
    });
    prefs = writeCompanionPrefs({ threadId: thread.id });
    threads = [...threads, thread];
    return { threadId: thread.id, first: true };
  }

  async function ask() {
    const request = draft.trim();
    if (!request || !client || thinking) return;
    problem = '';
    parts = [];
    buffer = [];
    kinds = [];
    replyId = null;
    sawRunning = false;
    phase = 'thinking';
    shown = true;
    clearTimeout(hideTimer);
    try {
      const target = await ensureThread();
      if (!target) {
        phase = 'error';
        return;
      }
      await subscribe(target.threadId);
      draft = '';
      await client.call('turns.start', { threadId: target.threadId, prompt: promptFor(request, target.first) });
      sawRunning = true;
      followOwnThread();
    } catch (error) {
      problem = fill(strings.companion.failed, { reason: error instanceof Error ? error.message : String(error) });
      settle('error');
    }
  }

  async function stop() {
    if (!client || !prefs.threadId) return;
    try {
      await client.call('turns.stop', { threadId: prefs.threadId });
    } catch {
      /* the turn ended on its own meanwhile */
    }
  }

  function hideReply() {
    clearTimeout(hideTimer);
    shown = false;
  }

  // ---------------------------------------------------------------------
  // The panel and the window
  // ---------------------------------------------------------------------

  async function act(action: PanelAction) {
    if (!client) return;
    if (action.kind === 'allow' || action.kind === 'deny') {
      await client.call('permissions.answer', { requestId: action.request.id, decision: action.kind });
    } else if (action.kind === 'answer') {
      const { question, optionIds, text } = action;
      await client.call('questions.answer', { threadId: question.threadId, questionId: question.id, optionIds, ...(text ? { text } : {}) });
    } else {
      await client.call('questions.skip', { threadId: action.question.threadId, questionId: action.question.id });
    }
    soon(0);
  }

  async function toggle() {
    boing++;
    open = !open;
    autoOpened = false;
    if (open) {
      await tick();
      input?.focus();
    }
  }

  function press(action: MediaAction) {
    void pressMedia(action)
      .then(readMedia)
      .then((state) => (media = state))
      .catch(() => {});
  }

  let lastRects = '';
  function sendRects() {
    const rects: HitRect[] = [...document.querySelectorAll<HTMLElement>('[data-hit]')].map((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x - HIT_PAD, y: box.y - HIT_PAD, w: box.width + HIT_PAD * 2, h: box.height + HIT_PAD * 2 };
    });
    const key = JSON.stringify(rects);
    if (key === lastRects) return;
    lastRects = key;
    void companionHitRects(rects).catch(() => {
      lastRects = '';
    });
  }

  $effect(() => {
    void [open, shown, phase, media, finished.length, mood.blocking];
    void tick().then(() => requestAnimationFrame(sendRects));
  });

  $effect(() => {
    void placeCompanion(prefs.monitor, prefs.anchor).catch(() => {});
  });

  $effect(() => {
    if (!prefs.music) {
      media = null;
      return;
    }
    const read = () => void readMedia().then((state) => (media = state)).catch(() => (media = null));
    read();
    const timer = setInterval(read, MEDIA_EVERY);
    return () => clearInterval(timer);
  });

  onMount(() => {
    document.documentElement.dataset.companion = '';
    const off: (() => void)[] = [startTheme()];
    off.push(
      subscribeCompanionPrefs((next) => {
        const brainChanged = next.threadId !== prefs.threadId;
        prefs = next;
        if (brainChanged) void subscribe(next.threadId);
      })
    );
    const initialize = async () => {
      // Same gate as `Store.boot`: the fake core is in the dev bundle only.
      if (import.meta.env.DEV && new URLSearchParams(location.search).get('fake') === '1') {
        const { FakeClient } = await import('./lib/fake-client');
        client = new FakeClient();
      } else {
        const endpoint = await resolveEndpoint();
        if (!endpoint) throw new Error(strings.errors.noEndpoint);
        const ws = new WsClient({ ...endpoint, clientName: 'shell' });
        client = ws;
        off.push(
          ws.onState((state: ClientState) => {
            reachable = state === 'ready';
            recompute();
            if (state === 'ready') {
              const again = subscribed;
              subscribed = null;
              void subscribe(again ?? prefs.threadId);
              soon(0);
            }
          })
        );
      }
      if (disposed) return client.close();
      await client.connect();
      if (disposed) return client.close();
      off.push(client.on('thread.updated', acceptThread));
      off.push(client.on('thread.created', acceptThread));
      off.push(client.on('thread.removed', () => soon()));
      off.push(client.on('permission.requested', () => soon(0)));
      off.push(client.on('permission.resolved', () => soon(0)));
      off.push(client.on('question.asked', () => soon(0)));
      off.push(client.on('question.answered', () => soon(0)));
      off.push(
        client.on('message.started', (message) => {
          if (message.threadId !== prefs.threadId || message.role !== 'assistant' || !thinking) return;
          replyId = message.id;
          kinds = message.parts.map((part) => part.type);
          buffer = message.parts.map((part) => (part.type === 'text' ? part.text : ''));
          showBuffer();
          phase = 'streaming';
        })
      );
      off.push(
        client.on('message.delta', ({ messageId, partIndex, text }) => {
          if (messageId !== replyId) return;
          // A delta past the known parts opens a text part, as in the store.
          if ((kinds[partIndex] ??= 'text') !== 'text') return;
          buffer[partIndex] = (buffer[partIndex] ?? '') + text;
          showBuffer();
        })
      );
      off.push(
        client.on('message.part', ({ messageId, partIndex, part }) => {
          if (messageId !== replyId) return;
          kinds[partIndex] = part.type;
          buffer[partIndex] = part.type === 'text' ? part.text : '';
          showBuffer();
        })
      );
      off.push(
        client.on('message.completed', ({ messageId, state }) => {
          if (messageId === replyId && state === 'error') {
            problem = fill(strings.companion.failed, { reason: reply || state });
            settle('error');
          }
        })
      );
      if (window.__TAURI_INTERNALS__) {
        const { listen } = await import('@tauri-apps/api/event');
        const stopHover = await listen<boolean>('companion://hover', ({ payload }) => {
          hover = payload;
          holdReply();
        });
        if (disposed) return stopHover();
        off.push(stopHover);
      }
      await readProjects().catch(() => {});
      await subscribe(prefs.threadId);
      await refresh();
    };
    void initialize().catch(() => {
      reachable = false;
      recompute();
    });
    const timer = setInterval(() => void refresh(), REFRESH_EVERY);
    const rects = setInterval(sendRects, 500);
    return () => {
      disposed = true;
      clearInterval(timer);
      clearInterval(rects);
      clearTimeout(refreshTimer);
      clearTimeout(hideTimer);
      clearTimeout(celebrateTimer);
      off.forEach((stop) => stop());
      client?.close();
    };
  });

  function onkeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    if (open) {
      open = false;
      autoOpened = false;
    } else hideReply();
  }
</script>

<svelte:window {onkeydown} />

<main class="stage" data-anchor={prefs.anchor} data-testid="companion">
  <div class="column">
    <button
      class="character"
      data-hit
      aria-label={open ? strings.companion.close : strings.companion.open}
      aria-expanded={open}
      onclick={toggle}
      onpointerenter={() => { if (!inShell()) hover = true; }}
      onpointerleave={() => { if (!inShell()) { hover = false; holdReply(); } }}
    >
      <CompanionCharacter mood={thinking ? 'working' : mood.mood} music={media?.playing ?? false} busy={mood.busy} {hover} {boing} size={64} />
      {#if mood.blocking > 0}<span class="badge" aria-hidden="true">{mood.blocking}</span>{/if}
    </button>

    {#if media && (open || hover)}
      <div data-hit><MediaPill {media} oncontrol={press} /></div>
    {/if}

    {#if shown && phase !== 'none'}
      <div class="bubble" data-hit role="status" aria-live="polite" data-testid="companion-reply">
        {#if problem}
          <p class="problem">{problem}</p>
        {:else if reply}
          <p class="text">{reply}</p>
        {:else}
          <p class="text waiting">{strings.companion.thinking}</p>
        {/if}
        <div class="tools">
          {#if thinking}
            <button class="ghost icon" aria-label={strings.companion.stop} title={strings.companion.stop} onclick={stop}><Square size={13} /></button>
          {/if}
          {#if prefs.threadId}
            <button class="ghost icon" aria-label={strings.companion.openThread} title={strings.companion.openThread} onclick={() => void showMain(prefs.threadId)}><ExternalLink size={13} /></button>
          {/if}
          <button class="ghost icon" aria-label={strings.companion.hideReply} title={strings.companion.hideReply} onclick={hideReply}><X size={13} /></button>
        </div>
      </div>
    {:else if !open && finished.length > 0}
      <div class="toast" data-hit role="status">{fill(strings.companion.finished, { title: finished[0]! })}</div>
    {/if}

    {#if !reachable && open}
      <p class="toast problem" data-hit role="alert">{strings.companion.unreachable}</p>
    {/if}

    {#if open}
      <section class="sheet" data-hit>
        <form class="askbar" onsubmit={(event) => { event.preventDefault(); void ask(); }}>
          <input bind:this={input} bind:value={draft} type="text" placeholder={strings.companion.ask} aria-label={strings.companion.askLabel} autocomplete="off" />
          {#if thinking}
            <button type="button" class="icon" aria-label={strings.companion.stop} title={strings.companion.stop} onclick={stop}><Square size={14} /></button>
          {:else}
            <button type="submit" class="primary icon" aria-label={strings.companion.send} title={strings.companion.send} disabled={!draft.trim()}><ArrowUp size={15} /></button>
          {/if}
          <button type="button" class="ghost icon" aria-label={strings.companion.openSettings} title={strings.companion.openSettings} onclick={() => void showMain(null)}><Settings size={15} /></button>
        </form>
        <CompanionPanel {threads} {projects} {permissions} {questions} {mood} own={prefs.threadId} onact={act} />
      </section>
    {/if}
  </div>
</main>

<style>
  /* The window is transparent: only what the companion draws shows. */
  :global(html[data-companion]),
  :global(html[data-companion] body),
  :global(html[data-companion] #app) {
    background: transparent !important;
    overflow: hidden;
  }
  :global(html[data-companion] body::before),
  :global(html[data-companion] body::after) {
    display: none;
  }

  /* The window is 440 px wide, which app.css reads as a phone and gives touch
     sizes to: the companion is on a desktop, under a mouse. */
  .stage {
    --control: 30px;
    --control-sm: 26px;
    --control-lg: 36px;
    --input: 34px;
    --row: 34px;
    --touch-target: 30px;
    height: 100dvh;
    padding: 6px 16px;
  }
  .stage :global(input) {
    font-size: var(--text-sm);
  }
  .column {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    max-height: 100%;
  }
  .stage[data-anchor='left'] .column {
    align-items: flex-start;
  }
  .stage[data-anchor='right'] .column {
    align-items: flex-end;
  }

  .character {
    position: relative;
    flex: none;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
  }
  .character:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
    border-radius: var(--radius-md);
  }
  .badge {
    position: absolute;
    top: 0;
    right: -4px;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: var(--radius-full);
    background: var(--color-danger);
    color: var(--color-accent-ink);
    font-size: var(--text-xs);
    font-weight: 600;
    line-height: 18px;
    text-align: center;
  }

  .bubble,
  .toast,
  .sheet {
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    box-shadow: var(--shadow-e2);
  }
  .bubble {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    width: max-content;
    max-width: 380px;
    padding: 8px 6px 8px 12px;
    border-radius: var(--radius-lg);
    animation: rise var(--dur-2) var(--ease-out-quint);
  }
  .text {
    max-height: 220px;
    overflow-y: auto;
    font-size: var(--text-sm);
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    scrollbar-width: thin;
  }
  .waiting {
    color: var(--color-muted-foreground);
  }
  .problem {
    font-size: var(--text-sm);
    color: var(--color-danger);
  }
  .tools {
    flex: none;
    display: flex;
  }
  .tools button {
    width: 24px;
    height: 24px;
  }
  .toast {
    max-width: 380px;
    padding: 5px 12px;
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    animation: rise var(--dur-2) var(--ease-out-quint);
  }

  .sheet {
    display: flex;
    flex-direction: column;
    width: 380px;
    min-height: 0;
    max-height: calc(100dvh - 110px);
    border-radius: var(--radius-lg);
    overflow: hidden;
    animation: rise var(--dur-2) var(--ease-out-quint);
  }
  .sheet > :global(.panel) {
    flex: 1;
    min-height: 0;
  }
  .askbar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 8px;
    border-bottom: 1px solid var(--color-border);
  }
  .askbar input {
    flex: 1;
    min-width: 0;
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }
</style>
