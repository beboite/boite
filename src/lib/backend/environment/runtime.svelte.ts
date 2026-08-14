import type { ControlEvent } from "../types";
import type { Project, Thread } from "$lib/types";
import { RemoteBackend } from "../remote";
import { workspace } from "../active.svelte";
import { logger } from "$lib/shared/services/logger.svelte";
import {
  EnvironmentSupervisor,
  type BlockReason,
  type ConnectionPhase,
  type Effect,
  type SyncStatus,
} from "./supervisor";
import { forgetProjection, readProjection, writeProjection } from "./cache";

export interface EnvironmentCredentials {
  url: string;
  token: string;
}

export interface EnvironmentIdentity {
  name: string | null;
  color: string | null;
  version: string | null;
}

/**
 * One connected environment: the socket, the supervisor that decides when to
 * dial it, and the projection of what is on it.
 *
 * Everything reactive here is written key by key. Several of these are live at
 * once, so a projection reassigned wholesale would invalidate every consumer of
 * every environment each time any one of them answered.
 */
export class EnvironmentRuntime {
  readonly id: string;
  readonly supervisor: EnvironmentSupervisor;

  url = $state("");
  phase = $state<ConnectionPhase>("idle");
  sync = $state<SyncStatus>("empty");
  blocked = $state<BlockReason | null>(null);
  info = $state<EnvironmentIdentity>({ name: null, color: null, version: null });
  lastError = $state<string | null>(null);
  threads = $state<Thread[]>([]);
  projects = $state<Project[]>([]);

  #token: string;
  #backend: RemoteBackend | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #unsubscribe: (() => void) | null = null;
  #onControl: (envId: string, ev: ControlEvent) => void;
  // Which dial an async landing belongs to. A `connect()` can take the twelve
  // seconds of the connect timeout, and by then the supervisor may have dialled
  // twice more; a late resolve must not install itself over the live one.
  #dialGeneration = 0;
  #disposed = false;

  constructor(
    id: string,
    creds: EnvironmentCredentials,
    onControl: (envId: string, ev: ControlEvent) => void,
  ) {
    this.id = id;
    this.url = creds.url;
    this.#token = creds.token;
    this.#onControl = onControl;
    this.supervisor = new EnvironmentSupervisor(id);
    this.#restoreCache();
  }

  get backend(): RemoteBackend | null {
    return this.#backend;
  }

  get connected(): boolean {
    return this.phase === "connected";
  }

  /** Connected and holding data read off the live socket. */
  get queryable(): boolean {
    return this.phase === "connected" && this.#backend !== null;
  }

  start(): void {
    this.#run(this.supervisor.start());
  }

  stop(): void {
    this.#run(this.supervisor.stop());
  }

  wake(): void {
    this.#run(this.supervisor.wake());
  }

  networkOffline(): void {
    this.#run(this.supervisor.networkOffline());
  }

  networkOnline(): void {
    this.#run(this.supervisor.networkOnline());
  }

  foregrounded(suspendedForMs: number): void {
    this.#run(this.supervisor.foregrounded(suspendedForMs));
  }

  /**
   * A new credential for this environment.
   *
   * The seam a per-environment pairing slots into: the pairing flow mints the
   * credential, hands it here, and the supervisor stops being blocked without
   * anything else in the app knowing a credential model changed.
   */
  setCredentials(creds: EnvironmentCredentials): void {
    const same = creds.url === this.url && creds.token === this.#token;
    this.url = creds.url;
    this.#token = creds.token;
    if (same) return;
    this.#release();
    this.#run(this.supervisor.credentialsChanged());
  }

  /** Forget the environment: session, timers, projection and its cache. */
  dispose(): void {
    this.#disposed = true;
    this.#cancel();
    this.#release();
    this.threads = [];
    this.projects = [];
    forgetProjection(this.id);
  }

  #restoreCache(): void {
    const token = this.supervisor.beginLoad("cache");
    const cached = readProjection(this.id);
    if (!cached || !this.supervisor.acceptLoad(token)) {
      this.supervisor.failLoad(token);
      this.#publish();
      return;
    }
    this.threads = cached.threads;
    this.projects = cached.projects;
    this.#publish();
  }

  #run(effects: Effect[]): void {
    if (this.#disposed) return;
    for (const e of effects) {
      switch (e.kind) {
        case "dial":
          void this.#dial();
          break;
        case "release":
          this.#release();
          break;
        case "probe":
          void this.#probe();
          break;
        case "schedule":
          this.#schedule(e.delayMs);
          break;
        case "cancel":
          this.#cancel();
          break;
      }
    }
    this.#publish();
  }

  #publish(): void {
    this.phase = this.supervisor.phase;
    this.sync = this.supervisor.sync;
    this.blocked = this.supervisor.blockedReason;
  }

  #schedule(delayMs: number): void {
    this.#cancel();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#run(this.supervisor.timerFired());
    }, delayMs);
  }

  #cancel(): void {
    if (!this.#timer) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  #release(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    // Null before dispose: dispose() closes the socket, whose state callback
    // fires synchronously, and its `#backend !== backend` guard must already
    // see null or a deliberate release re-enters `connectionLost()` and leaves
    // a stray retry timer that later dials over a live connection.
    const backend = this.#backend;
    this.#backend = null;
    backend?.dispose();
    // The handles every Terminal of this environment is holding were issued by
    // the instance just disposed. Bumping this environment's key is what makes
    // them release before anything reattaches; no other environment's terminals
    // are touched, because no other environment's handles came from here.
    workspace.bumpEpochOf(this.id);
  }

  async #dial(): Promise<void> {
    const generation = this.supervisor.generation;
    this.#dialGeneration = generation;
    const backend = new RemoteBackend(
      this.url,
      this.#token,
      (state) => {
        if (this.#backend !== backend) return;
        if (state === "disconnected") this.#run(this.supervisor.connectionLost());
      },
      () => {
        if (this.#backend === backend) this.#run(this.supervisor.authRejected());
      },
      { autoReconnect: false },
    );
    this.#backend = backend;
    try {
      await backend.connect();
    } catch (err) {
      if (this.#stale(generation, backend)) return;
      this.lastError = err instanceof Error ? err.message : String(err);
      // `authRejected` already ran through the callback above; anything else is
      // a boite that was never reached, which is the retryable kind.
      if (this.supervisor.blockedReason !== "auth") {
        this.#run(this.supervisor.connectionLost());
      }
      return;
    }
    if (this.#stale(generation, backend)) return;
    this.#run(this.supervisor.socketOpened());
    let identity: EnvironmentIdentity;
    try {
      identity = await backend.meta.get();
    } catch (err) {
      if (this.#stale(generation, backend)) return;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.#run(this.supervisor.configFailed());
      return;
    }
    if (this.#stale(generation, backend)) return;
    this.info = identity;
    this.lastError = null;
    this.#unsubscribe = backend.subscribe((ev) => this.#control(ev));
    this.#run(this.supervisor.configSucceeded());
    void this.refresh();
  }

  #stale(generation: number, backend: RemoteBackend): boolean {
    return (
      this.#disposed || this.#dialGeneration !== generation || this.#backend !== backend
    );
  }

  async #probe(): Promise<void> {
    const backend = this.#backend;
    if (!backend) {
      this.#run(this.supervisor.probeFailed());
      return;
    }
    try {
      await backend.probe();
    } catch {
      if (this.#backend !== backend) return;
      this.#run(this.supervisor.probeFailed());
      return;
    }
    this.#run(this.supervisor.probeSucceeded());
  }

  /** Read the environment's rows off the live socket. */
  async refresh(): Promise<void> {
    const backend = this.#backend;
    if (!backend || !this.supervisor.isConnected) return;
    const token = this.supervisor.beginLoad("live");
    this.#publish();
    try {
      const [threads, projects] = await Promise.all([
        backend.db.loadThreads(),
        backend.db.loadProjects(),
      ]);
      if (!this.supervisor.acceptLoad(token)) return;
      this.threads = threads;
      this.projects = projects;
      writeProjection(this.id, { threads, projects });
    } catch (err) {
      this.supervisor.failLoad(token);
      logger.warn("environment", `refresh failed for ${this.id}`, String(err));
    } finally {
      this.#publish();
    }
  }

  /**
   * Patch the projection from a pushed event, then hand the event on with the
   * environment it came from.
   *
   * The attribution is the whole point: with several boites pushing at once a
   * bare `thread.status` names a row id that exists on more than one of them.
   */
  #control(ev: ControlEvent): void {
    const data = ev.data as Record<string, unknown> | null;
    switch (ev.event) {
      case "thread.status": {
        const t = this.threads.find((x) => x.id === data?.threadId);
        if (t && typeof data?.status === "string") t.status = data.status as Thread["status"];
        break;
      }
      case "thread.title": {
        const t = this.threads.find((x) => x.id === data?.threadId);
        if (t && typeof data?.title === "string") t.title = data.title;
        break;
      }
      case "thread.created": {
        const incoming = (ev.data as { thread?: Thread })?.thread;
        if (incoming?.id && !this.threads.some((x) => x.id === incoming.id)) {
          this.threads.push(incoming);
        }
        break;
      }
      case "thread.deleted": {
        const id = data?.threadId as string | undefined;
        if (id) this.threads = this.threads.filter((x) => x.id !== id);
        break;
      }
      case "project.changed":
        void this.refresh();
        break;
      case "workspace.info":
        this.info = {
          name: typeof data?.name === "string" ? data.name : null,
          color: typeof data?.color === "string" ? data.color : null,
          version: this.info.version,
        };
        break;
    }
    this.#onControl(this.id, ev);
  }
}
