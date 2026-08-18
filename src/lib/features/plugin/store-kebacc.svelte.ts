import { backend } from "$lib/backend";
import type { Backend, KebaccSwitcherAccount, KebaccSwitcherProvider } from "$lib/backend/types";
import { app } from "$lib/app/store.svelte";
import { ptyKill } from "$lib/storage/pty";
import { shouldReloadKebaccThread } from "./restart";

export type KebaccProvider = "claude" | "codex";

export type KebaccSwitch = { provider: KebaccProvider; email: string };

export type KebaccAutoResult = {
  reloaded: number;
  switches: KebaccSwitch[];
};

class KebaccSwitcherStore {
  installed = $state<boolean | null>(null);
  version = $state<string | null>(null);
  cargoPresent = $state<boolean | null>(null);
  providers = $state<KebaccSwitcherProvider[]>([]);
  error = $state<string | null>(null);
  loading = $state(false);
  switching = $state(false);
  probing = $state(false);

  #answeredBy: Backend | null = null;

  #adopt(from: Backend): void {
    if (this.#answeredBy === from) return;
    this.#answeredBy = from;
    this.installed = null;
    this.version = null;
    this.cargoPresent = null;
    this.providers = [];
    this.error = null;
    this.loading = false;
    this.switching = false;
    this.probing = false;
  }

  accountsOf(provider: KebaccProvider): KebaccSwitcherAccount[] {
    return this.providers.find((row) => row.provider === provider)?.accounts ?? [];
  }

  async probe(): Promise<void> {
    const from = backend();
    this.#adopt(from);
    this.probing = true;
    this.error = null;
    try {
      const [version, cargoPresent] = await Promise.all([
        from.kebaccSwitcher.version(),
        from.shell.commandExists("cargo"),
      ]);
      if (this.#answeredBy !== from) return;
      this.version = version;
      this.installed = version !== null;
      this.cargoPresent = cargoPresent;
      if (!version) {
        this.providers = [];
        return;
      }
      const list = await from.kebaccSwitcher.list("all").then(
        (doc) => ({ ok: true as const, doc }),
        (err: unknown) => ({ ok: false as const, err: String(err) }),
      );
      if (this.#answeredBy !== from) return;
      if (list.ok) {
        this.providers = list.doc.providers ?? [];
      } else {
        this.providers = [];
        this.error = list.err;
      }
    } catch (err) {
      if (this.#answeredBy === from) this.error = String(err);
    } finally {
      if (this.#answeredBy === from) this.probing = false;
    }
  }

  async saveCurrent(provider: KebaccProvider): Promise<void> {
    const from = backend();
    this.#adopt(from);
    this.switching = true;
    this.error = null;
    try {
      await from.kebaccSwitcher.add(provider);
      await this.probe();
    } catch (err) {
      if (this.#answeredBy === from) this.error = String(err);
    } finally {
      if (this.#answeredBy === from) this.switching = false;
    }
  }

  async switchTo(provider: KebaccProvider, email: string): Promise<number> {
    const from = backend();
    this.#adopt(from);
    this.switching = true;
    this.error = null;
    const threads = app.threads.filter((thread) => shouldReloadKebaccThread(thread, provider));
    try {
      for (const thread of threads) {
        if (thread.ptyId) {
          await ptyKill(thread.ptyId, true).catch(() => {});
          thread.ptyId = null;
          thread.status = "idle";
        }
      }
      await from.kebaccSwitcher.switchTo(provider, email);
      if (this.#answeredBy !== from) return 0;
      for (const thread of threads) {
        app.bumpRespawn(thread.id);
      }
      await this.probe();
      return threads.length;
    } catch (err) {
      if (this.#answeredBy === from) this.error = String(err);
      return 0;
    } finally {
      if (this.#answeredBy === from) this.switching = false;
    }
  }

  /**
   * Switch only if the live login is out of quota. Reloads the other threads
   * of that provider; the caller (a launch) keeps going on the new login.
   */
  async auto(
    provider: KebaccProvider | "all",
    exceptThreadId?: string,
  ): Promise<KebaccAutoResult> {
    const empty: KebaccAutoResult = { reloaded: 0, switches: [] };
    const from = backend();
    this.#adopt(from);
    if (this.installed === false) return empty;
    try {
      const doc = await from.kebaccSwitcher.auto(provider === "all" ? "all" : provider);
      const switched = (doc.providers ?? []).filter((row) => row.switched);
      if (switched.length === 0) return empty;
      const switches: KebaccSwitch[] = [];
      let n = 0;
      for (const row of switched) {
        const kind: KebaccProvider | null =
          row.provider === "claude" || row.provider === "codex" ? row.provider : null;
        if (!kind) continue;
        if (typeof row.email === "string" && row.email) {
          switches.push({ provider: kind, email: row.email });
        }
        const threads = app.threads.filter(
          (thread) =>
            thread.id !== exceptThreadId && shouldReloadKebaccThread(thread, kind),
        );
        for (const thread of threads) {
          if (thread.ptyId) {
            await ptyKill(thread.ptyId, true).catch(() => {});
            thread.ptyId = null;
            thread.status = "idle";
          }
          app.bumpRespawn(thread.id);
          n += 1;
        }
      }
      return { reloaded: n, switches };
    } catch {
      return empty;
    }
  }
}

export const kebaccSwitcher = new KebaccSwitcherStore();
