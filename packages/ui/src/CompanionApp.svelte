<!--
  The desktop companion's window (`companion_window.rs`): a transparent area
  on a screen, with the characters, their replies, what they have to tell,
  the music they hear and, once opened, a field to ask the one clicked
  something and the requests agents are waiting on. Only the areas marked
  `data-hit` take clicks; the rest of the window lets them through to what is
  under it.

  Each character is a Boite agent (`lib/companion/crew.svelte.ts`), talked to
  in its own conversation of the Agents page (`lib/companion/talk.svelte.ts`),
  so it runs the way every agent runs, through the core's accounts and
  subscription proxy, with its own memory. The shell tells the window what
  goes on around it (`lib/companion/senses.svelte.ts`).
-->
<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import type { PermissionRequest, QuestionRequest, ThreadSummary } from '@boite/contracts';
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
  import { Crew } from './lib/companion/crew.svelte';
  import { sessionThreadOf, skinOf } from './lib/companion/crew';
  import { taskProjects } from './lib/companion/tasks';
  import { Notes } from './lib/companion/notes.svelte';
  import { Senses } from './lib/companion/senses.svelte';
  import CompanionCrew, { type CrewMember } from './components/companion/CompanionCrew.svelte';
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
  import { Reactions } from './lib/companion/reactions.svelte';
  import { Dropped, joinScreen } from './lib/companion/drop.svelte';
  import { Tasks } from './lib/companion/tasks.svelte';
  import CompanionAttachments from './components/companion/CompanionAttachments.svelte';
  import CompanionTaskCards from './components/companion/CompanionTaskCards.svelte';

  const CELEBRATE_MS = 6000;
  const REFRESH_EVERY = 15_000;
  const MEDIA_EVERY = 2000;
  const HIT_PAD = 6;
  /** How far the pointer goes on a character before a press becomes a drag. */
  const DRAG_FROM = 4;

  const initial = readCompanionPrefs();
  let prefs = $state<CompanionPrefs>(initial);
  let threads = $state.raw<ThreadSummary[]>([]);
  let projects = $state.raw(new Map<string, string>());
  /** The projects a task may go to, by name, for the agents' role; null until read. */
  let projectNames = $state.raw<string[] | null>(null);
  let permissions = $state.raw<PermissionRequest[]>([]);
  let questions = $state.raw<QuestionRequest[]>([]);
  let mood = $state<MoodState>(RESTING);
  let media = $state<MediaState | null>(null);
  let pointerOn = $state(false);
  let open = $state(false);
  let boings = $state<Record<string, number>>({});
  let draft = $state('');
  let sending = $state(false);
  let input = $state<HTMLInputElement | null>(null);
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

  // The agents standing as companions, and one conversation each.
  const crew = new Crew({
    client: () => client,
    prefs: () => prefs,
    projects: () => projectNames,
    waiting: () => talks.some((talk) => talk.waiting),
    answered: (agentId, message, directives, fresh) => {
      talkCache.get(agentId)?.answered(message);
      if (!fresh) return;
      answerer = agentId;
      obey(directives);
    },
    loaded: () => talks.forEach((talk) => talk.follow())
  });

  const talkCache = new Map<string, Talk>();
  function talkOf(agentId: string | null): Talk {
    const key = agentId ?? '';
    let talk = talkCache.get(key);
    if (!talk) {
      talk = new Talk(agentId, {
        client: () => client,
        snapshot: () => crew.snapshot,
        hovering: () => hover,
        missing: () => crew.problem ?? strings.companion.noAgent,
        settled: (outcome) => cue(outcome === 'done' ? 'done' : 'error')
      });
      talkCache.set(key, talk);
    }
    return talk;
  }

  // With no agent yet, a lone character stands, and says so when asked.
  const members = $derived<CrewMember[]>(
    crew.members.length > 0
      ? crew.members.map((agent) => ({ id: agent.id, name: agent.name, skin: skinOf(agent), talk: talkOf(agent.id) }))
      : [{ id: '', name: null, skin: null, talk: talkOf(null) }]
  );
  const talks = $derived(members.map((member) => member.talk));
  /** The character the panel talks to. */
  let activeId = $state('');
  const active = $derived(members.find((member) => member.id === activeId) ?? members[0]!);
  const thinking = $derived(talks.some((talk) => talk.thinking));
  /** The agents' own conversations, which the quotas and the notices leave out. */
  const ownThreads = $derived(crew.members.flatMap((agent) => sessionThreadOf(crew.snapshot, agent.id) ?? []));
  /** The agent whose fresh reply set a task: what the tasks say goes to its bubble. */
  let answerer: string | null = null;

  const attached = new Dropped();
  const tasks = new Tasks({
    client: () => client,
    control: () => prefs.control,
    created: (thread) => acceptThread(thread),
    say: (text) => (talkCache.get(answerer ?? '') ?? active.talk).aside(text)
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
    ownThreads: () => ownThreads,
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
    hover: () => talks.forEach((talk) => talk.hold()),
    outside: () => {
      if (prefs.closeOutside && open) close();
    },
    summon: () => void summon(),
    input: (at) => reactions.sign(at)
  });

  // In the shell the pointer is heard from its watch, since the window stops
  // taking it outside the areas; in a browser the page sees it.
  const hover = $derived(inShell() ? senses.hover : pointerOn);
  const asleep = $derived(senses.asleep && !open && !thinking && !dragging && mood.mood === 'idle' && notes.alarms.length === 0 && !media?.playing);

  // The music pill outlives the pointer a little: crossing the gap between the
  // character, the quotas and the pill must not take it away.
  const MEDIA_LINGER = 900;
  let mediaShown = $state(false);
  $effect(() => {
    if (open || hover) {
      mediaShown = true;
      return;
    }
    const hide = setTimeout(() => (mediaShown = false), MEDIA_LINGER);
    return () => clearTimeout(hide);
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
    projectNames = taskProjects(list).map((project) => project.name);
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
    recompute();
    soon();
  }

  // ---------------------------------------------------------------------
  // Asking
  // ---------------------------------------------------------------------

  async function ask(withScreen: boolean) {
    const request = draft.trim();
    const talk = active.talk;
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
    bounce();
    open = !open;
    autoOpened = false;
    if (open) await focusInput();
  }

  /** A character hops: on a click, on files dropped, when summoned. */
  function bounce(id = active.id) {
    boings = { ...boings, [id]: (boings[id] ?? 0) + 1 };
  }

  /**
   * A click on a character: it opens or closes the panel; with the panel
   * open, a click on another character turns the panel to it instead.
   */
  function pick(id: string) {
    press = null;
    if (dropped) return;
    if (open && id !== active.id) {
      activeId = id;
      bounce(id);
      history = false;
      void focusInput();
      return;
    }
    activeId = id;
    void toggle();
  }

  /** Files dropped on the character or the panel: the panel opens on them, ready to type the question. */
  function dropFiles(event: DragEvent) {
    const reading = attached.drop(event);
    if (!reading) return;
    bounce();
    open = true;
    autoOpened = false;
    history = false;
    if (inShell()) void focusCompanion().catch(() => {});
    void focusInput();
  }

  /** The shortcut: the companion comes forward, ready to type. */
  async function summon() {
    bounce();
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
    void [open, members.length, talks.map((talk) => [talk.shown, talk.phase]), media, mediaShown, notes.notices, notes.alarms, mood.blocking, layout, picking, hudOpen, timer.phase, focus.recap, focus.active, history, attached.held, attached.over, attached.reading, attached.problem, tasks.pending, tasks.launched];
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
        const crewChanged = next.agents.join() !== prefs.agents.join();
        prefs = next;
        if (crewChanged) void crew.load();
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
              crew.resubscribe();
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
      off.push(client.on('message.started', (message) => talks.forEach((talk) => talk.started(message))));
      off.push(client.on('message.delta', (delta) => talks.forEach((talk) => talk.delta(delta))));
      off.push(client.on('message.part', (part) => talks.forEach((talk) => talk.part(part))));
      off.push(client.on('agents.changed', () => crew.changed()));
      connected = true;
      await readProjects().catch(() => {});
      await refresh();
      await crew.load();
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
      crew.dispose();
      talkCache.forEach((talk) => talk.dispose());
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
    else talks.forEach((talk) => talk.hide());
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
    <CompanionCrew
      {members}
      active={active.id}
      {open}
      {layout}
      look={{
        music: media?.playing ?? false,
        hover: hover || dragging,
        asleep,
        typing: senses.typing,
        calm: focus.active,
        rest: timer.phase === 'break',
        game: reactions.game,
        coffee: reactions.coffee,
        startled: attached.over
      }}
      mood={mood.mood}
      busy={mood.busy}
      alarm={notes.alarms.length > 0}
      blocking={mood.blocking}
      cheering={reactions.cheering}
      burst={reactions.cheer}
      {boings}
      pointer={senses.pointer}
      {dragging}
      onpick={pick}
      {onpress}
      {onmove}
      onrelease={() => (press = null)}
      onenter={() => (pointerOn = true)}
      onleave={() => {
        pointerOn = false;
        if (!inShell()) talks.forEach((talk) => talk.hold());
      }}
    >
      <CompanionHud
        {threads}
        {projects}
        own={ownThreads}
        {gauges}
        {hover}
        {reachable}
        {layout}
        bind:expanded={hudOpen}
        onopen={(threadId) => void showMain(threadId)}
        onresize={sendRects}
      />
      <CompanionTimer {timer} {hover} onresize={sendRects} />
    </CompanionCrew>

    {#if media && mediaShown}
      <div data-hit><MediaPill {media} oncontrol={pressMediaKey} /></div>
    {/if}

    <CompanionNotes {members} {notes} {open} {reachable} />
    <CompanionFocusCards {timer} {focus} onopen={(threadId) => void showMain(threadId)} />
    <CompanionTaskCards {tasks} onopen={(threadId) => void showMain(threadId)} />

    {#if open}
      <section class="sheet" data-hit>
        <CompanionAsk
          bind:draft
          bind:input
          thinking={active.talk.thinking || sending}
          canSee={inShell()}
          {screens}
          scope={prefs.screenScope}
          onask={(screen) => void ask(screen)}
          onscope={(screenScope) => writeCompanionPrefs({ screenScope })}
          onstop={() => void active.talk.stop()}
          onsettings={() => void showMain(null)}
          to={members.length > 1 ? active.name : null}
        />
        <CompanionAttachments dropped={attached} />
        <CompanionTools {timer} {focus} workMinutes={prefs.workMinutes} breakMinutes={prefs.breakMinutes} bind:history onstart={() => startTimer()} />
        {#if history}
          <CompanionHistory snapshot={crew.snapshot} agentId={active.id} onpick={(exchange) => active.talk.recall(exchange.reply)} />
        {/if}
        <CompanionPanel {threads} {projects} {permissions} {questions} {mood} own={ownThreads} onact={act} />
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
