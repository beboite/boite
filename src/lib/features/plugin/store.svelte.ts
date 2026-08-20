import { backend } from "$lib/backend";
import type {
  Backend,
  CodexSwitcherAccount,
  KebaccSwitcherAccount,
  KebaccSwitcherProvider,
} from "$lib/backend/types";
import { app } from "$lib/app/store.svelte";
import { ptyKill } from "$lib/storage/pty";
import { CODEX_SWITCHER_CMD } from "./install";
import { FAST_MCP_SSH_CMD } from "./fast-mcp-ssh";
import { shouldReloadCodexThread, shouldReloadProviderThread } from "./restart";
import type { Thread } from "$lib/types";

async function killThreads(threads: Thread[]): Promise<void> {
  for (const thread of threads) {
    if (thread.ptyId) {
      await ptyKill(thread.ptyId, true).catch(() => {});
      thread.ptyId = null;
      thread.status = "idle";
    }
  }
}

function respawnThreads(threads: Thread[]): number {
  for (const thread of threads) {
    app.bumpRespawn(thread.id);
  }
  return threads.length;
}

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
      await killThreads(threads);
      await from.codexSwitcher.activate(accountId);
      if (this.#answeredBy !== from) return 0;
      const n = respawnThreads(threads);
      await this.probe();
      return n;
    } catch (err) {
      if (this.#answeredBy === from) this.error = String(err);
      return 0;
    } finally {
      if (this.#answeredBy === from) this.switching = false;
    }
  }
}

export const codexSwitcher = new CodexSwitcherStore();

/**
 * Whether `fast-mcp-ssh` is on the machine the agents run on, and which version.
 *
 * Smaller than the Codex store on purpose: boite installs this one and stops
 * there. The server is started by whichever agent has it in its MCP config, its
 * hosts file is that agent's business, and a panel that read either would be
 * claiming an ownership boite does not have.
 */
class FastMcpSshStore {
  installed = $state<boolean | null>(null);
  version = $state<string | null>(null);
  cargoPresent = $state<boolean | null>(null);
  error = $state<string | null>(null);
  probing = $state(false);

  /** Which backend the current answers came from, so a swap discards them. */
  #answeredBy: Backend | null = null;

  #adopt(from: Backend): void {
    if (this.#answeredBy === from) return;
    this.#answeredBy = from;
    this.installed = null;
    this.version = null;
    this.cargoPresent = null;
    this.error = null;
    this.probing = false;
  }

  async probe(): Promise<void> {
    const from = backend();
    this.#adopt(from);
    this.probing = true;
    this.error = null;
    try {
      const [installed, cargoPresent] = await Promise.all([
        from.shell.commandExists(FAST_MCP_SSH_CMD),
        from.shell.commandExists("cargo"),
      ]);
      if (this.#answeredBy !== from) return;
      this.installed = installed;
      this.cargoPresent = cargoPresent;
      // Asked only of a binary that is there: `--version` on a missing command
      // is a spawn failure, and absence is already the answer above.
      const version = installed ? await from.fastMcpSsh.version() : null;
      if (this.#answeredBy !== from) return;
      this.version = version;
    } catch (err) {
      if (this.#answeredBy === from) this.error = String(err);
    } finally {
      if (this.#answeredBy === from) this.probing = false;
    }
  }
}

export const fastMcpSsh = new FastMcpSshStore();

class KebaccSwitcherStore {
  installed = $state<boolean | null>(null);
  version = $state<string | null>(null);
  cargoPresent = $state<boolean | null>(null);
  providers = $state<KebaccSwitcherProvider[]>([]);
  error = $state<string | null>(null);
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
    this.switching = false;
    this.probing = false;
  }

  accountsOf(provider: string): KebaccSwitcherAccount[] {
    return this.providers.find((row) => row.provider === provider)?.accounts ?? [];
  }

  labelOf(provider: string): string | null {
    return this.providers.find((row) => row.provider === provider)?.label ?? null;
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

  async saveCurrent(provider: string): Promise<void> {
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

  async switchTo(provider: string, email: string): Promise<number> {
    const from = backend();
    this.#adopt(from);
    this.switching = true;
    this.error = null;
    const threads = app.threads.filter((thread) => shouldReloadProviderThread(thread, provider));
    try {
      await killThreads(threads);
      await from.kebaccSwitcher.switchTo(provider, email);
      if (this.#answeredBy !== from) return 0;
      const n = respawnThreads(threads);
      await this.probe();
      return n;
    } catch (err) {
      if (this.#answeredBy === from) this.error = String(err);
      return 0;
    } finally {
      if (this.#answeredBy === from) this.switching = false;
    }
  }
}

export const kebaccSwitcher = new KebaccSwitcherStore();
