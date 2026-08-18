import { backend } from "$lib/backend";
import { CLAUDE_STORE, CODEX_STORE, PWSH_CMD, TOOLS_DIR, VERSION_FILE } from "./install";
import type { Backend } from "$lib/backend";

/** The file the toolkit's own entry point lives in, and the proof it is installed. */
const ENTRY_FILE = "claude-cc.ps1";

/**
 * What the account switcher looks like on the machine this boite is talking to.
 *
 * Asked by looking at the filesystem rather than by running anything. The
 * switcher installs `claude-cc` as a function in the user's shell profile, not
 * as a binary on the PATH, so `commandExists` answers "no" on a machine where
 * the tools are installed and working: the profile that defines it is only
 * read by an interactive shell. What is on disk is unambiguous, costs one
 * directory listing, and needs no new backend call.
 *
 * Everything here crosses the transport, so on a remote boite this describes
 * the server: its home directory, its tools, its saved logins. That is the
 * machine a thread will run on, and therefore the machine whose account the
 * switcher would be switching.
 */
class AccountsStore {
  /** Null until probed. Tells "no tools on this machine" apart from "not asked yet". */
  installed = $state<boolean | null>(null);
  /** What the installer stamped into `.version`, if it is readable. */
  version = $state<string | null>(null);
  /** Whether PowerShell 7 is there to install with. Null until probed. */
  pwshPresent = $state<boolean | null>(null);
  /** Saved logins per provider, counted from the pool directories. */
  claudeAccounts = $state<number | null>(null);
  codexAccounts = $state<number | null>(null);
  probing = $state(false);

  // The transport that answered, which is the machine these answers describe.
  // The transport itself rather than a name for it, for the reason the fastpick
  // store gives: a workspace grafted onto a boite and a pure remote one share
  // every name that could be rebuilt here while describing two machines.
  #answeredBy: Backend | null = null;

  // Drops what another machine said. A stale "installed, 3 accounts" reads as
  // this machine's while the new probe is in flight, and it is the kind of
  // wrong that gets a user to click Uninstall on the wrong host.
  #adopt(from: Backend): void {
    if (this.#answeredBy === from) return;
    this.#answeredBy = from;
    this.installed = null;
    this.version = null;
    this.pwshPresent = null;
    this.claudeAccounts = null;
    this.codexAccounts = null;
  }

  /**
   * Asks that machine what it has: the tools, their version, PowerShell, and how
   * many logins are saved.
   *
   * Cheap enough to call on every panel open, and called again after every
   * install, update or uninstall: those are the four moments the answer changes.
   */
  async probe(): Promise<void> {
    const from = backend();
    this.#adopt(from);
    this.probing = true;
    try {
      const [home, pwsh] = await Promise.all([
        from.project.homeDir(),
        from.shell.commandExists(PWSH_CMD),
      ]);
      if (this.#answeredBy !== from) return;
      this.pwshPresent = pwsh;

      const entries = await this.#list(from, `${home}/${TOOLS_DIR}`);
      if (this.#answeredBy !== from) return;
      const installed = entries.some((name) => name === ENTRY_FILE);
      this.installed = installed;

      const [version, claude, codex] = await Promise.all([
        installed ? this.#version(from, `${home}/${TOOLS_DIR}/${VERSION_FILE}`) : null,
        this.#count(from, `${home}/${CLAUDE_STORE}`),
        this.#count(from, `${home}/${CODEX_STORE}`),
      ]);
      if (this.#answeredBy !== from) return;
      this.version = version;
      this.claudeAccounts = claude;
      this.codexAccounts = codex;
    } finally {
      // Unguarded, unlike the fields above: nothing else clears this flag, and a
      // switch mid-probe would leave the panel's button disabled for good.
      this.probing = false;
    }
  }

  /**
   * The names in a directory, or nothing at all.
   *
   * A missing directory is the ordinary answer here — it is how "no tools yet"
   * and "no accounts saved yet" both look — so it is not worth an error state
   * anyone has to read.
   */
  async #list(from: Backend, path: string): Promise<string[]> {
    try {
      return (await from.explorer.readDir(path)).map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  /**
   * How many logins are saved for a provider.
   *
   * One snapshot is one `.json` file. The pool's own bookkeeping lives beside
   * them as dotfiles — the trust manifest and the key that signs it — and
   * counting those would report an empty pool as holding two accounts.
   */
  async #count(from: Backend, path: string): Promise<number> {
    const names = await this.#list(from, path);
    return names.filter((name) => !name.startsWith(".") && name.endsWith(".json")).length;
  }

  /** The version marker, trimmed, or null if it is missing or unreadable. */
  async #version(from: Backend, path: string): Promise<string | null> {
    try {
      const file = await from.editor.readTextFile(path);
      return file.content.trim() || null;
    } catch {
      return null;
    }
  }
}

export const accounts = new AccountsStore();
