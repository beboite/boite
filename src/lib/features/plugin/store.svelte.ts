import { backend } from "$lib/backend";
import type { Backend, PluginKind, PluginStatus } from "$lib/backend/types";
import { app } from "$lib/app/store.svelte";
import { reloadThread } from "$lib/features/thread/api";
import { shouldReloadAfterSwitch } from "./restart";

/**
 * One switcher CLI, probed the way fastpick is: the answers describe the
 * machine the agents run on, so a workspace switch drops them.
 */
class SwitcherStore {
  installed = $state<boolean | null>(null);
  version = $state<string | null>(null);
  status = $state<PluginStatus | null>(null);
  error = $state<string | null>(null);
  loading = $state(false);
  switching = $state(false);

  #kind: PluginKind;
  #answeredBy: Backend | null = null;

  constructor(kind: PluginKind) {
    this.#kind = kind;
  }

  #adopt(from: Backend): void {
    if (this.#answeredBy === from) return;
    this.#answeredBy = from;
    this.installed = null;
    this.version = null;
    this.status = null;
    this.error = null;
    this.loading = false;
    this.switching = false;
  }

  async probe(): Promise<void> {
    const from = backend();
    this.#adopt(from);
    this.loading = true;
    this.error = null;
    try {
      const [version, status] = await Promise.all([
        from.plugin.version(this.#kind),
        from.plugin.status(this.#kind).then(
          (doc) => ({ ok: true as const, doc }),
          (err: unknown) => ({ ok: false as const, err: String(err) }),
        ),
      ]);
      if (this.#answeredBy !== from) return;
      this.version = version;
      if (status.ok) {
        this.installed = true;
        this.status = status.doc;
        return;
      }
      if (status.err.includes("is not on this machine")) {
        this.installed = false;
        this.status = null;
        return;
      }
      this.installed = true;
      this.status = null;
      this.error = status.err;
    } finally {
      if (this.#answeredBy === from) this.loading = false;
    }
  }

  async switchTo(who = "next"): Promise<number> {
    const from = backend();
    this.#adopt(from);
    this.switching = true;
    this.error = null;
    try {
      await from.plugin.switchTo(this.#kind, who);
      if (this.#answeredBy !== from) return 0;
      const ids = app.threads
        .filter((thread) => shouldReloadAfterSwitch(thread, this.#kind))
        .map((thread) => thread.id);
      for (const id of ids) {
        await reloadThread(id, { silent: true });
      }
      await this.probe();
      return ids.length;
    } catch (err) {
      if (this.#answeredBy === from) this.error = String(err);
      return 0;
    } finally {
      if (this.#answeredBy === from) this.switching = false;
    }
  }
}

export const claudeSwitcher = new SwitcherStore("claude");
export const codexSwitcher = new SwitcherStore("codex");

export function switcherFor(kind: PluginKind): SwitcherStore {
  return kind === "claude" ? claudeSwitcher : codexSwitcher;
}
