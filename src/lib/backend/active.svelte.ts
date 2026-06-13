import type { Backend } from "./types";
import { TauriBackend } from "./tauri";
import { RemoteBackend } from "./remote";
import type { ConnState } from "./remote/socket";

// The active workspace. backend() returns the current transport; mode/epoch/
// connection are reactive so the titlebar toggle and outline track them. The
// switch orchestration (reset stores, remount terminals, re-init) lives in the
// app layer (lib/app/workspace) to keep this module free of app-store imports.
class Workspace {
  mode = $state<"local" | "remote">("local");
  connection = $state<ConnState>("connected");
  remoteUrl = $state<string | null>(null);
  // PWA boot: no Tauri runtime and no saved/working token, so the app gates on
  // a remote login screen instead of initializing a dead local workspace.
  needsLogin = $state(false);
  // Bumping this remounts the terminal tree ({#key}), so every Terminal
  // releases its PTY before the transport swaps under it.
  epoch = $state(0);

  #local: Backend = new TauriBackend();
  #remote: RemoteBackend | null = null;

  current(): Backend {
    return this.mode === "remote" && this.#remote ? this.#remote : this.#local;
  }

  get isRemote(): boolean {
    return this.mode === "remote";
  }

  // Build and connect a remote backend. Throws on connect/auth failure (the
  // caller stays local). Does not flip mode: the orchestrator switches only
  // after stores are reset.
  async createRemote(url: string, token: string): Promise<RemoteBackend> {
    this.#disposeRemote();
    const remote = new RemoteBackend(url, token, (s) => {
      this.connection = s;
    });
    await remote.connect();
    this.#remote = remote;
    this.remoteUrl = url;
    this.connection = remote.connectionState;
    return remote;
  }

  activateRemote(): void {
    if (this.#remote) this.mode = "remote";
  }

  activateLocal(): void {
    this.mode = "local";
    this.connection = "connected";
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
