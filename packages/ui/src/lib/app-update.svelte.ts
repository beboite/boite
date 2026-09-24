import { strings } from './strings';

export type UpdateChannel = 'stable' | 'nightly';

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'current'
  | 'error';

export interface UpdateSnapshot {
  phase: UpdatePhase;
  currentVersion: string;
  currentChannel: UpdateChannel;
  channel: UpdateChannel;
  version: string | null;
  notes: string | null;
  publishedAt: string | null;
  received: number;
  total: number | null;
  error: string | null;
  supported: boolean;
}

export interface AppUpdateBackend {
  status(): Promise<UpdateSnapshot>;
  check(channel: UpdateChannel): Promise<UpdateSnapshot>;
  download(): Promise<UpdateSnapshot>;
  install(): Promise<void>;
  listen(handler: (snapshot: UpdateSnapshot) => void): Promise<() => void>;
}

export interface UpdateClock {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, delay: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface AppUpdateTestFixture {
  snapshot: UpdateSnapshot;
  checks?: Partial<Record<UpdateChannel, UpdateSnapshot>>;
  download?: UpdateSnapshot;
}

const FIRST_CHECK_MS = 8_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

const idleSnapshot: UpdateSnapshot = {
  phase: 'idle',
  currentVersion: '',
  currentChannel: 'stable',
  channel: 'stable',
  version: null,
  notes: null,
  publishedAt: null,
  received: 0,
  total: null,
  error: null,
  supported: false
};

const systemClock: UpdateClock = {
  setTimeout: (callback, delay) => window.setTimeout(callback, delay),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
  setInterval: (callback, delay) => window.setInterval(callback, delay),
  clearInterval: (handle) => window.clearInterval(handle as number)
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tauriBackend(): AppUpdateBackend {
  const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    const api = await import('@tauri-apps/api/core');
    return api.invoke<T>(command, args);
  };
  return {
    status: () => invoke<UpdateSnapshot>('app_update_status'),
    check: (channel) => invoke<UpdateSnapshot>('app_update_check', { channel }),
    download: () => invoke<UpdateSnapshot>('app_update_download'),
    install: () => invoke<void>('app_update_install'),
    listen: async (handler) => {
      const { listen } = await import('@tauri-apps/api/event');
      return listen<UpdateSnapshot>('app-update', (event) => handler(event.payload));
    }
  };
}

function testBackend(fixture: AppUpdateTestFixture): AppUpdateBackend {
  let current = fixture.snapshot;
  const handlers = new Set<(snapshot: UpdateSnapshot) => void>();
  const publish = (snapshot: UpdateSnapshot): UpdateSnapshot => {
    current = snapshot;
    for (const handler of handlers) handler(snapshot);
    return snapshot;
  };
  return {
    status: async () => current,
    check: async (channel) => publish(fixture.checks?.[channel] ?? { ...current, phase: 'current', channel, error: null }),
    download: async () => publish(fixture.download ?? {
      ...current,
      phase: 'ready',
      received: current.total ?? current.received,
      error: null
    }),
    install: async () => {
      publish({ ...current, phase: 'installing', error: null });
    },
    listen: async (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    }
  };
}

function queryFixture(): AppUpdateTestFixture | undefined {
  const query = new URLSearchParams(window.location.search);
  if (!import.meta.env.DEV || query.get('fake') !== '1') return undefined;
  if (window.__BOITE_APP_UPDATE_TEST__) return window.__BOITE_APP_UPDATE_TEST__;
  const phase = query.get('appUpdate');
  if (!['ready', 'downloading', 'error'].includes(phase ?? '')) return undefined;
  const channel: UpdateChannel = query.get('appUpdateChannel') === 'nightly' ? 'nightly' : 'stable';
  const currentChannel: UpdateChannel = query.get('appUpdateCurrentChannel') === 'nightly' ? 'nightly' : 'stable';
  const snapshot: UpdateSnapshot = {
    phase: phase as 'ready' | 'downloading' | 'error',
    currentVersion: currentChannel === 'nightly' ? '2.0.0-nightly.7' : '2.0.0-beta.1',
    currentChannel,
    channel,
    version: channel === 'nightly' ? '2.0.0-nightly.8' : '2.0.0-beta.2',
    notes: '## What changed\n\n- Faster startup\n- More reliable desktop updates',
    publishedAt: '2026-09-22T12:00:00Z',
    received: phase === 'downloading' ? 38_000_000 : 0,
    total: phase === 'downloading' ? 100_000_000 : null,
    error: phase === 'error' ? 'The release server did not answer.' : null,
    supported: true
  };
  return { snapshot };
}

const fixture = queryFixture();

/** True for the native window, plus the explicit fake harness used by visual tests. */
export function showAppUpdateUi(): boolean {
  return window.__TAURI_INTERNALS__ !== undefined || fixture !== undefined;
}

/**
 * Window update state is separate from the active core Store. The desktop can
 * be looking at another machine while its own shell downloads an update.
 */
export class AppUpdater {
  snapshot = $state.raw<UpdateSnapshot>({ ...idleSnapshot });
  lastCheckedAt = $state<number | null>(null);

  #backend: AppUpdateBackend;
  #clock: UpdateClock;
  #isShell: () => boolean;
  #started = false;
  #generation = 0;
  #unlisten: (() => void) | null = null;
  #firstCheck: unknown = null;
  #interval: unknown = null;
  #active: Promise<void> | null = null;
  #pendingCheck: UpdateChannel | null = null;
  #downloadRequested = false;

  constructor(
    backend: AppUpdateBackend = tauriBackend(),
    clock: UpdateClock = systemClock,
    isShell: () => boolean = () => window.__TAURI_INTERNALS__ !== undefined
  ) {
    this.#backend = backend;
    this.#clock = clock;
    this.#isShell = isShell;
  }

  get ready(): boolean {
    return this.snapshot.supported && this.snapshot.phase === 'ready';
  }

  get busy(): boolean {
    return ['checking', 'downloading', 'installing'].includes(this.snapshot.phase);
  }

  /** Start once from App after mount. The returned function owns every timer and listener. */
  start(): () => void {
    if (this.#started || !this.#isShell()) return () => undefined;
    this.#started = true;
    const generation = ++this.#generation;

    void this.#backend.listen((snapshot) => {
      if (generation !== this.#generation) return;
      this.#apply(snapshot);
    }).then((unlisten) => {
      if (generation !== this.#generation) unlisten();
      else this.#unlisten = unlisten;
    }).catch((error) => this.#fail(error, generation));

    this.#run(generation, () => this.#backend.status(), false);
    this.#firstCheck = this.#clock.setTimeout(() => {
      this.#firstCheck = null;
      this.#scheduledCheck();
      this.#interval = this.#clock.setInterval(() => this.#scheduledCheck(), CHECK_INTERVAL_MS);
    }, FIRST_CHECK_MS);

    return () => this.stop();
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.#generation += 1;
    this.#unlisten?.();
    this.#unlisten = null;
    if (this.#firstCheck !== null) this.#clock.clearTimeout(this.#firstCheck);
    if (this.#interval !== null) this.#clock.clearInterval(this.#interval);
    this.#firstCheck = null;
    this.#interval = null;
    this.#pendingCheck = null;
    this.#downloadRequested = false;
    this.#active = null;
  }

  check(channel: UpdateChannel = this.snapshot.channel): void {
    if (!this.snapshot.supported || this.snapshot.phase === 'installing') return;
    this.#pendingCheck = channel;
    this.#pump(this.#generation);
  }

  download(): void {
    if (!this.snapshot.supported || this.snapshot.phase !== 'available') return;
    this.#downloadRequested = true;
    this.#pump(this.#generation);
  }

  install(): void {
    if (!this.ready || this.#active) return;
    const generation = this.#generation;
    this.snapshot = { ...this.snapshot, phase: 'installing', error: null };
    this.#active = this.#backend.install()
      .catch((error) => this.#fail(error, generation))
      .finally(() => {
        if (generation !== this.#generation) return;
        this.#active = null;
        this.#pump(generation);
      });
  }

  /** Test and integration hook for waiting until the serialized native work drains. */
  async settled(): Promise<void> {
    for (;;) {
      const active = this.#active;
      if (active) await active;
      await Promise.resolve();
      if (!this.#active && this.#pendingCheck === null && !this.#downloadRequested) return;
    }
  }

  #scheduledCheck(): void {
    if (!this.snapshot.supported) return;
    if (['checking', 'downloading', 'ready', 'installing'].includes(this.snapshot.phase)) return;
    this.check(this.snapshot.channel);
  }

  #apply(snapshot: UpdateSnapshot): void {
    this.snapshot = snapshot;
    if (snapshot.phase === 'available') this.#downloadRequested = true;
    if (snapshot.phase === 'ready' || snapshot.phase === 'installing') this.#downloadRequested = false;
    queueMicrotask(() => this.#pump(this.#generation));
  }

  #fail(error: unknown, generation: number): void {
    if (generation !== this.#generation) return;
    this.snapshot = { ...this.snapshot, phase: 'error', error: message(error), supported: this.snapshot.supported || this.#isShell() };
  }

  #pump(generation: number): void {
    if (!this.#started || generation !== this.#generation || this.#active) return;

    if (this.#pendingCheck !== null) {
      const channel = this.#pendingCheck;
      if (this.snapshot.phase === 'installing' || this.snapshot.phase === 'checking') return;
      if (this.snapshot.phase === 'downloading') {
        if (channel === this.snapshot.channel) this.#pendingCheck = null;
        return;
      }
      if (this.snapshot.phase === 'ready' && channel === this.snapshot.channel) {
        this.#pendingCheck = null;
        return;
      }
      this.#pendingCheck = null;
      this.#downloadRequested = false;
      this.#run(generation, () => this.#backend.check(channel), true);
      return;
    }

    if (this.#downloadRequested && this.snapshot.phase === 'available') {
      this.#downloadRequested = false;
      this.#run(generation, () => this.#backend.download(), false);
    }
  }

  #run(generation: number, request: () => Promise<UpdateSnapshot>, checked: boolean): void {
    this.#active = request()
      .then((snapshot) => {
        if (generation !== this.#generation) return;
        if (checked) this.lastCheckedAt = Date.now();
        this.#apply(snapshot);
      })
      .catch((error) => {
        if (checked && generation === this.#generation) this.lastCheckedAt = Date.now();
        this.#fail(error, generation);
      })
      .finally(() => {
        if (generation !== this.#generation) return;
        this.#active = null;
        this.#pump(generation);
      });
  }
}

export const appUpdater = new AppUpdater(
  fixture ? testBackend(fixture) : tauriBackend(),
  systemClock,
  showAppUpdateUi
);

/**
 * The name the app goes by: a nightly build is "boite (de nuit)" wherever it
 * says its own name, like the shell's window title and tray. The update card
 * still names the track Boite Nightly.
 */
export function appName(): string {
  return appUpdater.snapshot.currentChannel === 'nightly' ? strings.app.nightlyName : strings.app.name;
}
