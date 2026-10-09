<!--
  The desktop companion's window (`companion_window.rs`): a transparent area
  on a screen, with the character, its reply, what it has to tell, the music
  it hears and, once opened, a field to ask it something and the requests
  agents are waiting on. Only the areas marked `data-hit` take clicks; the
  rest of the window lets them through to what is under it.

  The companion talks through an ordinary thread in the drafts project
  (`lib/companion/talk.svelte.ts`), so its agent runs the way every thread
  runs, through the core's account and subscription proxy. The shell tells
  it what goes on around it (`lib/companion/senses.svelte.ts`).
-->
<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import type { ImageAttachment, PermissionRequest, QuestionRequest, ThreadSummary } from '@boite/contracts';
  import { WsClient, type Client, type ClientState } from './lib/client';
  import { resolveEndpoint } from './lib/endpoint';
  import { startTheme } from './lib/theme';
  import { fill, strings } from './lib/strings';
  import { readCompanionPrefs, subscribeCompanionPrefs, writeCompanionPrefs, type CompanionPrefs } from './lib/companion/prefs';
  import { createMoodTracker, RESTING, type MoodInput, type MoodState } from './lib/companion/mood';
  import { readMedia, pressMedia, type MediaAction, type MediaState } from './lib/companion/media';
  import { addReminder, writeStatus } from './lib/companion/memory';
  import { captureScreens, captureZone, type ScreenShot } from './lib/companion/screen';
  import { playCue, unlockSounds, type Cue } from './lib/companion/sounds';
  import { companionHitRects, companionMonitors, configureCompanion, coverScreen, dragCompanion, focusCompanion, inShell, layoutOf, placeCompanion, showMain, type CompanionLayout, type HitRect } from './lib/companion/shell';
  import { Talk } from './lib/companion/talk.svelte';
  import { Notes } from './lib/companion/notes.svelte';
  import { Senses } from './lib/companion/senses.svelte';
  import CompanionCharacter, { type Gaze } from './components/companion/CompanionCharacter.svelte';
  import CompanionPanel, { type PanelAction } from './components/companion/CompanionPanel.svelte';
  import CompanionAsk from './components/companion/CompanionAsk.svelte';
  import CompanionNotes from './components/companion/CompanionNotes.svelte';
  import CompanionZone from './components/companion/CompanionZone.svelte';
  import MediaPill from './components/companion/MediaPill.svelte';
  import CompanionHud from './components/companion/CompanionHud.svelte';
  import { followQuotas, hudGauges, shownGauges } from './lib/companion/hud';
  import { GatewayReader } from './lib/quota-reader.svelte';
  import { audible, Focus, PomodoroTimer } from './lib/companion/focus.svelte';
  import type { Directives } from './lib/companion/directives';
  import CompanionTimer from './components/companion/CompanionTimer.svelte';
  import CompanionFocusCards from './components/companion/CompanionFocusCards.svelte';
  import CompanionTools from './components/companion/CompanionTools.svelte';
  import CompanionHistory from './components/companion/CompanionHistory.svelte';
  import CompanionConfetti from './components/companion/CompanionConfetti.svelte';
  import { Reactions } from './lib/companion/reactions.svelte';
  import { Dropped, joinScreen } from './lib/companion/drop.svelte';
  import { Tasks } from './lib/companion/tasks.svelte';
  import CompanionAttachments from './components/companion/CompanionAttachments.svelte';
  import CompanionTaskCards from './components/companion/CompanionTaskCards.svelte';

  const CELEBRATE_MS = 6000;
  const REFRESH_EVERY = 15_000;
  const MEDIA_EVERY = 2000;
  const HIT_PAD = 6;
  /** How far the pointer goes on the character before a press becomes a drag. */
  const DRAG_FROM = 4;
  /** The distance at which the eyes reach the side and the bottom of their sockets. */
  const GAZE_REACH = { x: 240, y: 180 };

  const initial = readCompanionPrefs();
  let prefs = $state<CompanionPrefs>(initial);
  let threads = $state.raw<ThreadSummary[]>([]);
  let projects = $state.raw(new Map<string, string>());
  let permissions = $state.raw<PermissionRequest[]>([]);
  let questions = $state.raw<QuestionRequest[]>([]);
  let mood = $state<MoodState>(RESTING);
  let media = $state<MediaState | null>(null);
  let pointerOn = $state(false);
  let open = $state(false);
  let boing = $state(0);
  let draft = $state('');
  let sending = $state(false);
  let input = $state<HTMLInputElement | null>(null);
  let character = $state<HTMLButtonElement | null>(null);
  let layout = $state<CompanionLayout>(layoutOf(initial.anchor, initial.spot));
  let dragging = $state(false);
  /** The window covers a screen while the user picks what to show. */
  let picking = $state(false);
  let pickDone: ((area: HitRect | null) => void) | null = null;
  let screens = $state(1);

  let client: Client | null = null;
  let reachable = $state(true);
  /** The client answered once: what reads the quotas waits for. */
  let connected = $state(false);
  let hudOpen = $state(false);
  const quotas = new GatewayReader();
  const gauges = $derived(prefs.quotas ? shownGauges(hudGauges(quotas.state), prefs.hiddenQuotas) : []);
  let disposed = false;
  let autoOpened = false;
  let seen: Set<string> | null = null;
  const tracker = createMoodTracker({ celebrateMs: CELEBRATE_MS });

  // In focus, only an agent that needs the user, a reminder and the pomodoro ring.
  const cue = (name: Cue) => {
    if (prefs.sounds && audible(name, focus.active)) playCue(name);
  };

  // A pomodoro's phase chimes; a countdown rings as an alarm until it is
  // dismissed, like a reminder; a stopwatch at its limit just stops.
  const timer = new PomodoroTimer({
    ended: (_, ran) => {
      if (ran.kind === 'pomodoro') cue('phase');
      else if (ran.kind === 'countdown') addReminder(ran.label ? fill(strings.companion.pomodoro.doneFor, { label: ran.label }) : strings.companion.pomodoro.done, Date.now());
    }
  });
  const focus = new Focus({ auto: () => prefs.focusOnWork && timer.working });
  let history = $state(false);

  const talk = new Talk({
    client: () => client,
    prefs: () => prefs,
    threads: () => threads,
    hovering: () => hover,
    created: (thread) => (threads = [...threads, thread]),
    settled: (outcome, directives) => {
      cue(outcome === 'done' ? 'done' : 'error');
      if (directives) obey(directives);
    }
  });

  const attached = new Dropped();
  const tasks = new Tasks({
    client: () => client,
    control: () => prefs.control,
    created: (thread) => acceptThread(thread),
    say: (text) => talk.aside(text)
  });

  /** A work phase starts: an earlier "focus off" gives way to the pomodoro again. */
  function startTimer(workMs = prefs.workMinutes * 60_000, label = '') {
    focus.release();
    timer.start({ workMs, breakMs: prefs.breakMinutes * 60_000, label });
  }

  /** The timer, the focus and the threads a reply asks for ([[timer: …]], [[pomodoro: …]], [[focus: …]], [[task: …]]). */
  function obey({ timer: asked, focus: on, task }: Directives) {
    if (task.length > 0) void tasks.request(task);
    if (asked === 'stop') timer.stop();
    else if (asked?.kind === 'pomodoro') startTimer(asked.ms ?? undefined, asked.label);
    else if (asked?.kind === 'countdown' && asked.ms !== null) timer.countdown(asked.ms, asked.label);
    else if (asked?.kind === 'stopwatch') timer.stopwatch(asked.label);
    if (on !== null) focus.set(on);
  }

  const reactions = new Reactions({ quiet: () => focus.active });

  const notes = new Notes({
    client: () => client,
    threads: () => threads,
    ownThread: () => prefs.threadId,
    holding: () => hover || open,
    rang: () => {
      senses.wake();
      cue('remind');
    },
    setAside: (notice) => {
      if (!focus.active) return false;
      focus.keep({ threadId: notice.threadId, title: notice.title, failed: notice.failed });
      return true;
    },
    answered: (text) => reactions.answered(text)
  });

  // The focus ended: what it set aside goes to one card.
  $effect(() => {
    if (!focus.active) untrack(() => focus.follow());
  });

  const senses = new Senses({
    hover: () => talk.hold(),
    outside: () => {
      if (prefs.closeOutside && open) close();
    },
    summon: () => void summon(),
    input: (at) => reactions.sign(at)
  });

  // In the shell the pointer is heard from its watch, since the window stops
  // taking it outside the areas; in a browser the page sees it.
  const hover = $derived(inShell() ? senses.hover : pointerOn);
  const asleep = $derived(senses.asleep && !open && !talk.thinking && !dragging && mood.mood === 'idle' && notes.alarms.length === 0 && !media?.playing);

  /** Where the pointer is, seen from the character's eyes. */
  const gaze = $derived.by((): Gaze | null => {
    const point = senses.pointer;
    if (!point || !character || dragging) return null;
    const box = character.getBoundingClientRect();
    const clamp = (value: number) => Math.max(-1, Math.min(1, value));
    return { x: clamp((point.x - box.x - box.width / 2) / GAZE_REACH.x), y: clamp((point.y - box.y - box.height / 2) / GAZE_REACH.y) };
  });

  // ---------------------------------------------------------------------
  // What the core reports
  // ---------------------------------------------------------------------

  function recompute() {
    const state: MoodInput | null = reachable ? { threads, permissions, questions } : null;
    mood = tracker.update(state);
  }

  let celebrateTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const finished = mood.justFinished;
    if (finished.length === 0) return;
    untrack(() => {
      notes.finished(finished);
      tasks.finished(finished);
    });
    clearTimeout(celebrateTimer);
    celebrateTimer = setTimeout(recompute, CELEBRATE_MS + 100);
  });

  /** Opens the panel when an agent stops on something new; closes it once nothing waits. */
  function followRequests() {
    const blocking = new Set([...permissions.map((request) => request.id), ...questions.filter((question) => !question.async).map((question) => question.id)]);
    if (seen !== null && [...blocking].some((id) => !seen!.has(id))) {
      if (!open) autoOpened = true;
      open = true;
      history = false;
      cue('call');
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
      talk.follow();
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
    talk.follow();
    recompute();
    soon();
  }

  // ---------------------------------------------------------------------
  // Asking
  // ---------------------------------------------------------------------

  async function ask(withScreen: boolean) {
    const request = draft.trim();
    if (!request || sending || talk.thinking) return;
    sending = true;
    try {
      let shot: ScreenShot | null = null;
      if (withScreen) {
        if (prefs.screenScope === 'zone') {
          const picked = await pickZone().catch(() => null);
          // Cancelled: the request waits in the field.
          if (picked === 'cancelled') return void input?.focus();
          shot = picked;
        } else shot = await captureScreens(prefs.screenScope).catch(() => null);
        if (!shot) return talk.fail(strings.companion.screenFailed);
      }
      const files = attached.held;
      const together = joinScreen(files, shot);
      if (typeof together === 'string') return talk.fail(together);
      draft = '';
      attached.clear();
      // A request that could not go comes back to the field with its files, to try again.
      if (!(await talk.ask(request, shot, files)) && draft === '') {
        draft = request;
        if (attached.held.length === 0) attached.held = files;
      }
    } finally {
      sending = false;
    }
  }

  /**
   * The window covers the screen under the pointer and the user drags over
   * what to show (`CompanionZone`). Afterwards the placement effect puts the
   * window back where it was.
   */
  async function pickZone(): Promise<ScreenShot | null | 'cancelled'> {
    picking = true;
    try {
      await coverScreen(true);
      const area = await new Promise<HitRect | null>((resolve) => (pickDone = resolve));
      return area ? await captureZone(area) : 'cancelled';
    } finally {
      pickDone = null;
      // Uncovered before placed: the shell would carry the cover along otherwise.
      await coverScreen(false).catch(() => {});
      picking = false;
    }
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

  function close() {
    open = false;
    autoOpened = false;
  }

  async function focusInput() {
    await tick();
    input?.focus();
  }

  async function toggle() {
    boing++;
    open = !open;
    autoOpened = false;
    if (open) await focusInput();
  }

  /** Files dropped on the character or the panel: the panel opens on them, ready to type the question. */
  function dropFiles(event: DragEvent) {
    const reading = attached.drop(event);
    if (!reading) return;
    boing++;
    open = true;
    autoOpened = false;
    history = false;
    if (inShell()) void focusCompanion().catch(() => {});
    void focusInput();
  }

  /** The shortcut: the companion comes forward, ready to type. */
  async function summon() {
    boing++;
    open = true;
    autoOpened = false;
    cue('open');
    await focusInput();
  }

  // A press on the character that moves is a drag: the shell carries the
  // window and says where it was dropped; the click after it is not a click.
  let press: { x: number; y: number } | null = null;
  let dropped = false;

  function onpress(event: PointerEvent) {
    unlockSounds();
    press = event.button === 0 && inShell() ? { x: event.screenX, y: event.screenY } : null;
  }

  function onmove(event: PointerEvent) {
    if (!press || Math.hypot(event.screenX - press.x, event.screenY - press.y) < DRAG_FROM) return;
    press = null;
    void drag();
  }

  async function drag() {
    dragging = true;
    dropped = true;
    try {
      const place = await dragCompanion();
      if (place) prefs = writeCompanionPrefs({ monitor: place.monitor, anchor: 'free', spot: place.spot });
    } catch {
      /* the window stays where it was */
    } finally {
      dragging = false;
      setTimeout(() => (dropped = false), 300);
    }
  }

  function onclick() {
    press = null;
    if (!dropped) void toggle();
  }

  function pressMediaKey(action: MediaAction) {
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
    void [open, talk.shown, talk.phase, media, notes.notices, notes.alarms, mood.blocking, layout, picking, hudOpen, timer.phase, focus.recap, focus.active, history, attached.held, attached.over, attached.reading, attached.problem, tasks.pending, tasks.launched];
    void tick().then(() => requestAnimationFrame(sendRects));
  });

  // The proxy's quotas, read now, every minute and on each update, while shown.
  $effect(() => {
    if (!prefs.quotas || !connected || !client) return;
    return followQuotas(client, quotas);
  });

  // Covering a screen, the window stays put; uncovered, it goes back to its place.
  $effect(() => {
    const [monitor, anchor, spot] = [prefs.monitor, prefs.anchor, prefs.spot];
    if (picking) return;
    void placeCompanion(monitor, anchor, spot)
      .then((next) => (layout = next))
      .catch(() => {});
  });

  // How many screens there are, for the choice of what the companion sees.
  $effect(() => {
    if (!open || !inShell()) return;
    void companionMonitors()
      .then((list) => (screens = list.length))
      .catch(() => {});
  });

  // Hiding for full-screen apps and the shortcut live in the shell; how the
  // shortcut fared goes to Settings, in the other window.
  $effect(() => {
    const [hideFullscreen, hotkey] = [prefs.hideFullscreen, prefs.hotkey];
    if (!inShell()) return;
    void configureCompanion(hideFullscreen, hotkey)
      .then(() => writeStatus({ hotkeyError: null }))
      .catch(() => writeStatus({ hotkeyError: hotkey }));
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
        if (brainChanged) void talk.subscribe(next.threadId);
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
              talk.resubscribe();
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
      off.push(client.on('message.started', (message) => talk.started(message)));
      off.push(client.on('message.delta', (delta) => talk.delta(delta)));
      off.push(client.on('message.part', (part) => talk.part(part)));
      off.push(client.on('message.completed', (done) => talk.completed(done)));
      connected = true;
      await readProjects().catch(() => {});
      await talk.subscribe(prefs.threadId);
      await refresh();
    };
    void initialize().catch(() => {
      reachable = false;
      recompute();
    });
    const refresher = setInterval(() => void refresh(), REFRESH_EVERY);
    const rects = setInterval(sendRects, 500);
    return () => {
      disposed = true;
      clearInterval(refresher);
      clearInterval(rects);
      clearTimeout(refreshTimer);
      clearTimeout(celebrateTimer);
      talk.dispose();
      notes.dispose();
      timer.dispose();
      senses.dispose();
      reactions.dispose();
      attached.dispose();
      off.forEach((stop) => stop());
      client?.close();
    };
  });

  function onkeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    if (picking) pickDone?.(null);
    else if (open) close();
    else talk.hide();
  }
</script>

<svelte:window {onkeydown} />

<main
  class="stage"
  class:picking
  data-align={layout.align}
  data-edge={layout.edge}
  data-testid="companion"
  ondragenter={(event) => attached.dragover(event)}
  ondragover={(event) => attached.dragover(event)}
  ondrop={dropFiles}
>
  <div class="column">
    <div class="head">
      <button
        bind:this={character}
        class="character"
        class:dragging
        data-hit
        aria-label={open ? strings.companion.close : strings.companion.open}
        aria-expanded={open}
        {onclick}
        onpointerdown={onpress}
        onpointermove={onmove}
        onpointerup={() => (press = null)}
        onpointerenter={() => (pointerOn = true)}
        onpointerleave={() => {
          pointerOn = false;
          if (!inShell()) talk.hold();
        }}
      >
        <CompanionCharacter
          mood={talk.thinking ? 'working' : mood.mood}
          music={media?.playing ?? false}
          busy={mood.busy}
          hover={hover || dragging}
          {boing}
          {gaze}
          {asleep}
          typing={senses.typing}
          alarm={notes.alarms.length > 0}
          calm={focus.active}
          rest={timer.phase === 'break'}
          game={reactions.game}
          coffee={reactions.coffee}
          cheer={reactions.cheering}
          startled={attached.over}
          size={64}
        />
        {#if reactions.cheering}<CompanionConfetti burst={reactions.cheer} />{/if}
        {#if mood.blocking > 0}<span class="badge" aria-hidden="true">{mood.blocking}</span>{/if}
      </button>
      <div class="hud">
        <CompanionHud
          {threads}
          {projects}
          own={prefs.threadId}
          {gauges}
          {hover}
          {reachable}
          {layout}
          bind:expanded={hudOpen}
          onopen={(threadId) => void showMain(threadId)}
          onresize={sendRects}
        />
        <CompanionTimer {timer} {hover} onresize={sendRects} />
      </div>
    </div>

    {#if media && (open || hover)}
      <div data-hit><MediaPill {media} oncontrol={pressMediaKey} /></div>
    {/if}

    <CompanionNotes {talk} {notes} {open} {reachable} threadId={prefs.threadId} />
    <CompanionFocusCards {timer} {focus} onopen={(threadId) => void showMain(threadId)} />
    <CompanionTaskCards {tasks} onopen={(threadId) => void showMain(threadId)} />

    {#if open}
      <section class="sheet" data-hit>
        <CompanionAsk
          bind:draft
          bind:input
          thinking={talk.thinking || sending}
          canSee={inShell()}
          {screens}
          scope={prefs.screenScope}
          onask={(screen) => void ask(screen)}
          onscope={(screenScope) => writeCompanionPrefs({ screenScope })}
          onstop={() => void talk.stop()}
          onsettings={() => void showMain(null)}
        />
        <CompanionAttachments dropped={attached} />
        <CompanionTools {timer} {focus} workMinutes={prefs.workMinutes} breakMinutes={prefs.breakMinutes} bind:history onstart={() => startTimer()} />
        {#if history}
          <CompanionHistory client={() => client} threadId={prefs.threadId} onpick={(exchange) => talk.recall(exchange.reply)} />
        {/if}
        <CompanionPanel {threads} {projects} {permissions} {questions} {mood} own={prefs.threadId} onact={act} />
      </section>
    {/if}
  </div>

  {#if picking}
    <CompanionZone {screens} onpick={(area) => pickDone?.(area)} oncancel={() => pickDone?.(null)} />
  {/if}
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
     sizes to: the companion is on a desktop, under a mouse. The paddings put
     the character's centre where the shell expects it (`CHARACTER_TOP`,
     `CHARACTER_BOTTOM`, `CHARACTER_SIDE`). */
  .stage {
    --control: 30px;
    --control-sm: 26px;
    --control-lg: 36px;
    --input: 34px;
    --row: 34px;
    --touch-target: 30px;
    display: flex;
    flex-direction: column;
    height: 100dvh;
    /* Room above the lid and the headphones: drawn flush, they seem cut by the screen's edge. */
    padding: 24px 16px 6px;
  }
  .stage[data-edge='bottom'] {
    justify-content: flex-end;
    padding: 6px 16px 12px;
  }
  /* The companion steps aside while the user picks what to show it. */
  .stage.picking .column {
    visibility: hidden;
  }
  .stage :global(input) {
    font-size: var(--text-sm);
  }
  .column {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    min-height: 0;
    max-height: 100%;
  }
  /* Near the bottom of the screen, what it shows opens upwards. */
  .stage[data-edge='bottom'] .column {
    flex-direction: column-reverse;
  }
  .stage[data-align='left'] .column {
    align-items: flex-start;
  }
  .stage[data-align='right'] .column {
    align-items: flex-end;
  }

  /* The character and its HUD: under it in the centre, where the sides leave
     too little room, beside it towards the middle of the screen otherwise. The
     character stays first, so its centre does not move. */
  .head {
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    max-width: 100%;
  }
  .stage[data-edge='bottom'] .head {
    flex-direction: column-reverse;
  }
  .stage[data-align='left'] .head,
  .stage[data-align='right'] .head {
    flex-direction: row;
    align-items: flex-start;
    gap: 14px;
  }
  .stage[data-align='right'] .head {
    flex-direction: row-reverse;
  }
  .stage[data-edge='bottom'][data-align='left'] .head,
  .stage[data-edge='bottom'][data-align='right'] .head {
    align-items: flex-end;
  }
  /* The HUD: the activity pill and the pomodoro side by side under the
     character, one over the other beside it. */
  .hud {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: 100%;
  }
  .stage[data-align='left'] .hud,
  .stage[data-align='right'] .hud {
    flex-direction: column;
    align-items: flex-start;
  }
  .stage[data-align='right'] .hud {
    align-items: flex-end;
  }
  .stage[data-edge='bottom'][data-align='left'] .hud,
  .stage[data-edge='bottom'][data-align='right'] .hud {
    flex-direction: column-reverse;
  }
  /* Some air between the character and its HUD, so the pill does not touch it. */
  .head > .hud:has(> :global(*)) {
    margin-top: 10px;
  }
  /* At the bottom edge the HUD sits over the character, whose lid needs more. */
  .stage[data-edge='bottom'][data-align='center'] .head > .hud:has(> :global(*)) {
    margin-top: 0;
    margin-bottom: 14px;
  }
  /* Beside the character, the pill sits level with its middle. */
  .stage[data-align='left'] .head > .hud,
  .stage[data-align='right'] .head > .hud {
    margin-top: 11px;
  }
  .stage[data-edge='bottom'][data-align='left'] .head > .hud,
  .stage[data-edge='bottom'][data-align='right'] .head > .hud {
    margin-top: 0;
    margin-bottom: 11px;
  }

  .character {
    position: relative;
    flex: none;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
    touch-action: none;
    /* Air between the character and what it shows, on the side it shows it. */
    margin-bottom: 10px;
  }
  .stage[data-edge='bottom'] .character {
    margin-top: 10px;
    margin-bottom: 0;
  }
  .character.dragging {
    cursor: grabbing;
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

  .sheet {
    display: flex;
    flex-direction: column;
    width: 380px;
    min-height: 0;
    max-height: calc(100dvh - 110px);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
    box-shadow: var(--shadow-e2);
    overflow: hidden;
    animation: rise var(--dur-2) var(--ease-out-quint);
  }
  .sheet > :global(.panel) {
    flex: 1;
    min-height: 0;
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }
</style>
