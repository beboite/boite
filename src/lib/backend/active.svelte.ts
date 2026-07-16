import type { Backend } from "./types";
import type { WorkspaceOrigin } from "$lib/types";
import { TauriBackend } from "./tauri";
import { RemoteBackend } from "./remote";
import type { ConnState } from "./remote/socket";

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
  info = $state<{ name: string | null; color: string | null }>({
    name: null,
    color: null,
  });
  // PWA boot: no Tauri runtime and no saved/working token, so the app gates on
  // a remote login screen instead of initializing a dead local workspace.
  needsLogin = $state(false);
  // Bumping this remounts the terminal tree ({#key}), so every Terminal
  // releases its PTY before the transport swaps under it.
  epoch = $state(0);

  // Installed by the app layer (it owns the project list): maps a filesystem
  // path to the origin of the project that contains it. Lets path-scoped
  // façades (git/explorer/editor/session) route without signature changes.
  pathOriginResolver: ((path: string) => WorkspaceOrigin) | null = null;

  #local: Backend = new TauriBackend();
  #remote: RemoteBackend | null = null;

  // The workspace-global transport: settings, logs, shell lists. In dynamic
  // mode the local device stays authoritative for those.
  current(): Backend {
    return this.mode === "remote" && this.#remote ? this.#remote : this.#local;
  }

  // Route by an entity's origin tag. Outside dynamic mode this is current(),
  // so untagged entities (the classic single-backend world) behave as before.
  backendFor(origin: WorkspaceOrigin | undefined): Backend {
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
  async createRemote(url: string, token: string): Promise<RemoteBackend> {
    this.#disposeRemote();
    const remote = new RemoteBackend(url, token, (s) => {
      this.connection = s;
    });
    try {
      await remote.connect();
    } catch (e) {
      // Stop the orphaned socket's reconnect loop; otherwise its state callback
      // keeps forcing connection back to "connecting" forever and the picker
      // button stays stuck (and a re-add stacks another ghost socket).
      remote.dispose();
      this.connection = "connected";
      throw e;
    }
    this.#remote = remote;
    this.remoteUrl = url;
    this.connection = remote.connectionState;
    return remote;
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
    this.mode = "local";
    this.connection = "connected";
    this.activeBoiteId = null;
    this.info = { name: null, color: null };
    this.#disposeRemote();
  }

  bumpEpoch(): void {
    this.epoch++;
  }

  #disposeRemote(): void {
    this.#remote?.dispose();
    this.#remote = null;
    this.remoteUrl = null;
  }
}

export const workspace = new Workspace();

export function backend(): Backend {
  return workspace.current();
}

export function backendFor(origin: WorkspaceOrigin | undefined): Backend {
  return workspace.backendFor(origin);
}

export function backendForPath(path: string): Backend {
  return workspace.backendForPath(path);
}
