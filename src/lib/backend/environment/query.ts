import type { Backend } from "../types";
import { workspace } from "../active.svelte";
import { hasTauri } from "../env";
import { environments } from "./registry.svelte";
import { environmentLabel } from "./merge";
import type { SyncStatus } from "./supervisor";

/**
 * One place to ask a question of every environment that is up.
 *
 * The active workspace is in here beside the registry's environments, because
 * the whole point is that a caller stops caring which one is on screen: the
 * palette, the usage view and the thread list ask the same question of all of
 * them and label the answers.
 */
export interface ConnectedEnvironment {
  /** `local` for this device, otherwise the boite's registration id. */
  id: string;
  label: string;
  color: string | null;
  backend: Backend;
  sync: SyncStatus;
  /** Whether this is the workspace currently on screen. */
  active: boolean;
}

export function connectedEnvironments(): ConnectedEnvironment[] {
  const out: ConnectedEnvironment[] = [];
  if (hasTauri()) {
    out.push({
      id: "local",
      label: "Local",
      color: null,
      backend: workspace.local(),
      // This device's rows are read straight off SQLite, so there is no
      // projection to be behind: it is either loaded or the app is not up.
      sync: "live",
      active: !workspace.isRemote,
    });
  }
  const activeRemote = workspace.remoteBackend;
  if (activeRemote && workspace.connection === "connected") {
    out.push({
      id: workspace.activeBoiteId ?? "remote",
      label: environmentLabel(workspace.info.name, workspace.remoteUrl ?? ""),
      color: workspace.info.color,
      backend: activeRemote,
      sync: "live",
      active: true,
    });
  }
  for (const runtime of environments.queryable) {
    const backend = runtime.backend;
    if (!backend) continue;
    out.push({
      id: runtime.id,
      label: environmentLabel(runtime.info.name, runtime.url),
      color: runtime.info.color,
      backend,
      sync: runtime.sync,
      active: false,
    });
  }
  return out;
}
