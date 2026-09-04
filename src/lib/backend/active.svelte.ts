import type { Backend } from "./types";
import type { WorkspaceOrigin } from "$lib/types";
import { TauriBackend } from "./tauri";
import { RemoteBackend } from "./remote";
import { ConnectError, connectFailReason, type ConnState } from "./remote/socket";
import { hasTauri } from "./env";
import { attach } from "$lib/shared/log";

// The active workspace. backend() returns the current transport; mode/epoch/
// connection are reactive so the titlebar toggle and outline track them. The
// switch orchestration (reset stores, remount terminals, re-init) lives in the
// app layer (lib/app/workspace) to keep this module free of app-store imports.
//
// Modes:
//   local   — the desktop backend alone (classic).
//   remote  — the connected boite alone (classic).
//   dynamic — BOTH live at once: projects/threads from the two sources are
//             merged and every call routes by the entity's origin tag.
class Workspace {
  mode = $state<"local" | "remote" | "dynamic">("local");
  connection = $state<ConnState>("connected");
  remoteUrl = $state<string | null>(null);
  // Which saved boite (device registry id) the active remote points at; null
  // when local. Drives the picker's active row and where rename/color writes.
  activeBoiteId = $state<string | null>(null);
  // Server-synced cosmetic identity of the active remote: name replaces the
  // "Remote" label, color tints the connection outline. Null fields fall back
  // to the host and the default success color.
  // `version` rides along because it comes back from the same read: what the
  // boite answering is running, so the picker can say which saved one is behind.
  info = $state<{ name: string | null; color: string | null; version: string | null }>({
    name: null,
    color: null,
    version: null,
  });
  // PWA boot: no Tauri runtime and no saved/working token, so the app gates on
  // a remote login screen instead of initializing a dead local workspace.
  needsLogin = $state(false);
  // Bumping this remounts the terminal tree ({#key}), so every Terminal
  // releases its PTY before the transport swaps under it.
  epoch = $state(0);
  /**
   * The same guarantee, per environment.
   *
   * `epoch` was written when one transport served everything, so the only safe
   * thing to do before swapping it was to remount every Terminal in the window.
   * With several transports live that is both too much and not enough: too
   * much, because a boite going down would tear down the local terminals it has
   * nothing to do with, and not enough, because it says nothing about *which*
   * transport moved.
   *
   * What actually has to hold is narrower. A PTY handle is only ever valid
   * against the backend instance that issued it — `RemoteBackend` keys its
   * `ptyId` map per instance and `Socket` keys its attachments per socket — so
   * the terminals that must release before a disposal are exactly the ones
   * whose handles came from the instance being disposed. That is one
   * environment's terminals, and keying each Terminal on its own environment's
   * counter is therefore both necessary and sufficient.
   */
  environmentEpochs = $state<Record<string, number>>({});

  // Installed by the app layer (it owns the project list): maps a filesystem
  // path to the origin of the project that contains it. Lets path-scoped
  // façades (git/explorer/editor/session) route without signature changes.
  pathOriginResolver: ((path: string) => WorkspaceOrigin) | null = null;

  // Installed by the environment registry, which owns every connection that is
  // not the active workspace. Kept as a hook rather than an import so this
  // module stays free of the registry and its device-settings dependencies.
  environmentResolver: ((envId: string) => Backend | null) | null = null;

  // Whether this boite ever answered on the current socket. Tells "lost the
  // connection" apart from "never reached it", which are different sentences and
  // used to be the same silence.
  linkEstablished = $state(false);

  #local: Backend = new TauriBackend();
  #remote: RemoteBackend | null = null;
  #connWatchers = new Set<(s: ConnState) => void>();
  // Bumped by every dial and every return to local. A dial can take the twelve
  // seconds of the connect timeout, and the workspace can move twice in that
  // time; the generation is what tells the socket that lands late that it is
  // landing on a workspace nobody is on any more. Without it a boot dial could
  // install itself over the boite the user picked while it was still ringing.
  #gen = 0;

  // Lets the app layer act on the link coming back (finish a boot that started
  // offline) without owning a rune effect: lib/app/workspace is a plain module
  // and cannot run one.
  onConnection(cb: (s: ConnState) => void): () => void {
    this.#connWatchers.add(cb);
    return () => this.#connWatchers.delete(cb);
  }

  #publishConnection(s: ConnState): void {
    this.connection = s;
    if (s === "connected") this.linkEstablished = true;
    // Iterating the Set directly is safe against a watcher that unsubscribes
    // itself mid-callback, which is the normal case here.
    for (const cb of this.#connWatchers) cb(s);
  }

  // The workspace-global transport: settings, shell lists, anything that
  // describes the machine the threads run on. In dynamic mode the local device
  // stays authoritative for those.
  //
  // This is not the transport for anything describing the machine the user is
  // sitting at. Those ask `local()`, whatever the mode.
  current(): Backend {
    return this.mode === "remote" && this.#remote ? this.#remote : this.#local;
  }

  // This device, always. App logs are the reason it exists: they are written
  // by this window about this window, and routing them through `current()`
  // handed every line to a remote stub that dropped it, so the desktop's own
  // log file stopped recording for as long as a boite was connected.
  local(): Backend {
    return this.#local;
  }

  // Route by an entity's origin tag. Outside dynamic mode this is current(),
  // so untagged entities (the classic single-backend world) behave as before.
  // An environment id is accepted here as well as the two origin words: rows
  // that know which boite they came from route to it, rows that only know they
  // are not local keep the classic behaviour of following the active one.
  backendFor(origin: WorkspaceOrigin | string | undefined): Backend {
    if (origin && origin !== "local" && origin !== "remote") {
      if (origin === this.activeBoiteId && this.#remote) return this.#remote;
      const env = this.environmentResolver?.(origin);
      if (env) return env;
    }
    if (this.mode !== "dynamic") return this.current();
    return origin === "remote" && this.#remote ? this.#remote : this.#local;
  }

  backendForPath(path: string): Backend {
    if (this.mode !== "dynamic") return this.current();
    return this.backendFor(this.pathOriginResolver?.(path) ?? "local");
  }

  get remoteBackend(): RemoteBackend | null {
    return this.#remote;
  }

  get isRemote(): boolean {
    return this.mode === "remote";
  }

  get isDynamic(): boolean {
    return this.mode === "dynamic";
  }

  // A boite connection is in play (pure remote or dynamic).
  get hasRemote(): boolean {
    return this.mode !== "local" && this.#remote !== null;
  }

  // Build and connect a remote backend. Throws on connect/auth failure (the
  // caller stays local). Does not flip mode: the orchestrator switches only
  // after stores are reset.
  //
  // `keepUnreachable` decides what a failure costs the socket. A dial the user is
  // watching (typing a URL, picking a boite) discards it: its reconnect loop
  // would keep forcing connection back to "connecting" forever, the picker
  // button would stay stuck, and a re-add would stack another ghost socket. A
  // boot against a boite that already worked keeps it, because the backoff loop
  // is the only thing that can bring the workspace back and a login form cannot.
  async createRemote(
    url: string,
    token: string,
    keepUnreachable = false,
  ): Promise<RemoteBackend> {
    const gen = ++this.#gen;
    const current = () => this.#gen === gen;
    this.#disposeRemote();
    const remote = new RemoteBackend(
      url,
      token,
      // A superseded socket publishes nothing: its state is about a workspace
      // that has been left.
      (s) => {
        if (current()) this.#publishConnection(s);
      },
      () => {
        // A refused token is the one failure a login form fixes. On the desktop
        // there is a local workspace to fall back to, so the gate stays down and
        // the connection banner carries it instead.
        if (!hasTauri() && current()) this.needsLogin = true;
      },
    );
    try {
      await remote.connect();
    } catch (e) {
      if (keepUnreachable && current() && connectFailReason(e) !== "auth") {
        this.#remote = remote;
        this.remoteUrl = url;
        this.connection = remote.connectionState;
        throw e;
      }
      remote.dispose();
      if (current()) this.connection = "connected";
      throw e;
    }
    if (!current()) {
      remote.dispose();
      throw new ConnectError("unreachable", "superseded by a newer connection");
    }
    this.#remote = remote;
    this.remoteUrl = url;
    this.connection = remote.connectionState;
    return remote;
  }

  // Dial again now instead of waiting out the backoff, which can be half a
  // minute. False when no socket is left to retry, and the caller has to dial
  // from scratch.
  retryRemote(): boolean {
    if (!this.#remote) return false;
    this.#remote.retryNow();
    return true;
  }

  activateRemote(): void {
    if (this.#remote) this.mode = "remote";
  }

  activateDynamic(): void {
    if (this.#remote) this.mode = "dynamic";
  }

  setActiveBoite(id: string | null): void {
    this.activeBoiteId = id;
  }

  activateLocal(): void {
    // Any dial still ringing was for the workspace being left.
    this.#gen++;
    this.mode = "local";
    this.connection = "connected";
    this.activeBoiteId = null;
    this.info = { name: null, color: null, version: null };
    this.#disposeRemote();
  }

  bumpEpoch(): void {
    this.epoch++;
  }

  bumpEpochOf(envId: string): void {
    // Written key by key: a spread would invalidate every environment's
    // terminals each time any one of them moved. See rules/performance.md.
    this.environmentEpochs[envId] = (this.environmentEpochs[envId] ?? 0) + 1;
  }

  /**
   * The remount key for a terminal of `origin`. The workspace-wide epoch is
   * summed in because a full workspace switch resets the stores under every
   * terminal, whichever environment it belongs to.
   */
  epochOf(origin: WorkspaceOrigin | string | undefined): number {
    if (!origin || origin === "local" || origin === "remote") return this.epoch;
    return this.epoch + (this.environmentEpochs[origin] ?? 0);
  }

  /** The connection behind an environment id, if the registry holds one. */
  environmentBackend(envId: string): Backend | null {
    return this.environmentResolver?.(envId) ?? null;
  }

  #disposeRemote(): void {
    this.#remote?.dispose();
    this.#remote = null;
    this.remoteUrl = null;
    this.linkEstablished = false;
  }
}

export const workspace = new Workspace();

export function backend(): Backend {
  return workspace.current();
}

// The webview log writes through whatever `backend()` points at, and it is told
// so here rather than importing this module: `$lib/shared/log` is imported by
// the transports above, and one of them runs under bun in the remote smoke
// with nothing of this file behind it.
attach((batch) => backend().logs.write(batch));

/** The transport for this device, never the boite. See `Workspace.local`. */
export function localBackend(): Backend {
  return workspace.local();
}

export function backendFor(origin: WorkspaceOrigin | string | undefined): Backend {
  return workspace.backendFor(origin);
}

export function backendForPath(path: string): Backend {
  return workspace.backendForPath(path);
}
