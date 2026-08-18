import { backend } from "$lib/backend";
import type { Backend, CodexSwitcherAccount } from "$lib/backend/types";
import { app } from "$lib/app/store.svelte";
import { ptyKill } from "$lib/storage/pty";
import { CODEX_SWITCHER_CMD } from "./install";
import { shouldReloadCodexThread } from "./restart";

class CodexSwitcherStore {
  installed = $state<boolean | null>(null);
  version = $state<string | null>(null);
  cargoPresent = $state<boolean | null>(null);
  accounts = $state<CodexSwitcherAccount[]>([]);
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
    this.accounts = [];
    this.error = null;
    this.loading = false;
    this.switching = false;
    this.probing = false;
  }

  async probe(): Promise<void> {
    const from = backend();
    this.#adopt(from);
    this.probing = true;
    this.error = null;
    try {
      const [installed, cargoPresent] = await Promise.all([
        from.shell.commandExists(CODEX_SWITCHER_CMD),
        from.shell.commandExists("cargo"),
      ]);
      if (this.#answeredBy !== from) return;
      this.installed = installed;
      this.cargoPresent = cargoPresent;
      if (!installed) {
        this.version = null;
        this.accounts = [];
        return;
      }
      const [version, list] = await Promise.all([
        from.codexSwitcher.version(),
        from.codexSwitcher.list().then(
          (doc) => ({ ok: true as const, doc }),
          (err: unknown) => ({ ok: false as const, err: String(err) }),
        ),
      ]);
      if (this.#answeredBy !== from) return;
      this.version = version;
      if (list.ok) {
        this.accounts = list.doc.accounts ?? [];
      } else {
        this.accounts = [];
        this.error = list.err;
      }
    } catch (err) {
      if (this.#answeredBy === from) this.error = String(err);
    } finally {
      if (this.#answeredBy === from) this.probing = false;
    }
  }

  async saveCurrent(): Promise<void> {
    const from = backend();
    this.#adopt(from);
    this.switching = true;
    this.error = null;
    try {
      await from.codexSwitcher.save();
      await this.probe();
    } catch (err) {
      if (this.#answeredBy === from) this.error = String(err);
    } finally {
      if (this.#answeredBy === from) this.switching = false;
    }
  }

  async activate(accountId: string): Promise<number> {
    const from = backend();
    this.#adopt(from);
    this.switching = true;
    this.error = null;
    const threads = app.threads.filter(shouldReloadCodexThread);
    try {
      for (const thread of threads) {
        if (thread.ptyId) {
          await ptyKill(thread.ptyId, true).catch(() => {});
          thread.ptyId = null;
          thread.status = "idle";
        }
      }
      await from.codexSwitcher.activate(accountId);
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
}

export const codexSwitcher = new CodexSwitcherStore();
