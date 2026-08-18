import { app } from "$lib/app/store.svelte";
import { launchPlan } from "$lib/features/terminal/launch";
import { notifications } from "$lib/features/notifications/store.svelte";
import { settings } from "$lib/features/settings/store.svelte";
import { logger } from "$lib/shared/services/logger.svelte";
import { ptyKill, ptyOpen, ptyWrite } from "$lib/storage/pty";
import { t } from "$lib/i18n/index.svelte";
import { installCommand, uninstallCommand, updateCommand } from "./install";
import { InstallOutput, TerminalQueries } from "$lib/features/fastpick/install-output";
import { codexSwitcher } from "./store.svelte";
import type { PtyEvent } from "$lib/backend/types";
import type { Project } from "$lib/types";

/**
 * Installing `codex-account-switcher` without leaving the settings panel.
 *
 * It used to open a thread. That was defensible while the only place a build's
 * output could go was a terminal, and it cost more than it bought: a pane, a
 * sidebar row and a detached worktree, all for a command that installs a binary
 * and belongs to no repository, and the user was left to work out on their own
 * whether the thing they came to install was now installed. The answer to that
 * question lives in the panel that asked it.
 *
 * Still a real PTY underneath, because the thing being watched may be a
 * compiler: it wants a terminal to size its output to, its failures are its own
 * error text and nothing else, and it has to be killable. What changes is only
 * where the bytes are drawn.
 *
 * Only the first install is a compiler now. `update` hands the job to fastpick,
 * which fetches a signed release, so it is seconds and needs no toolchain.
 */

/**
 * One id for every run, rather than a fresh one per launch.
 *
 * `pty.open` is attach-or-spawn keyed on it, so a panel closed mid-build and
 * reopened lands back on the same process with its scrollback replayed instead
 * of starting a second `cargo install` beside the first.
 */
const INSTALL_THREAD_ID = "codex-switcher-install";

/**
 * Wide enough that cargo's own line wrapping is not what a reader has to fight,
 * and tall enough that its progress block has room to be itself. Nothing
 * measures a log panel, so these are the size the build believes it has.
 */
const COLS = 120;
const ROWS = 30;

/**
 * How often the lines on screen are replaced during a build. A cargo build
 * emits its progress line several times a second, and each publish reassigns a
 * `$state` array that a keyed `{#each}` re-renders.
 */
const REPAINT_MS = 120;

export type InstallAction = "install" | "update" | "uninstall";

const COMMANDS: Record<InstallAction, () => { cmd: string; args: string[] }> = {
  install: installCommand,
  update: updateCommand,
  uninstall: uninstallCommand,
};
export type InstallStatus = "idle" | "running" | "done" | "failed" | "cancelled";

/**
 * Where to run it. Any project will do: this installs a binary, not something
 * belonging to a repository, and the current one keeps it on the machine the
 * user was looking at.
 *
 * The project's own directory rather than a worktree. A worktree reserved for a
 * `cargo install` is a branch, a checkout and a directory to clean up, for a
 * command that never reads the repository it is standing in.
 */
function target(): Project | null {
  return app.projects.find((p) => p.id === app.currentProjectId) ?? app.projects[0] ?? null;
}

class CodexSwitcherInstaller {
  /** Which of the two is running, or the one that last ran. */
  action = $state<InstallAction | null>(null);
  status = $state<InstallStatus>("idle");
  /** The build log, tail only. Replaced wholesale, never pushed into. */
  lines = $state<string[]>([]);
  /** What the process exited with, once it has. */
  exitCode = $state<number | null>(null);
  /** A failure that is not an exit code: the spawn itself, or the transport. */
  failure = $state<string | null>(null);

  #output = new InstallOutput();
  #queries = new TerminalQueries();
  #decoder = new TextDecoder();
  #encoder = new TextEncoder();
  #key: string | null = null;
  /**
   * Answers the child is waiting on that cannot be sent yet.
   *
   * ConPTY asks its question the moment the process starts, which is before
   * `pty.open` has come back with the key that writing needs. Dropping the
   * answer because the key was a few milliseconds late leaves the build
   * suspended exactly as if nothing had answered at all.
   */
  #owed = "";
  #repaint: ReturnType<typeof setTimeout> | null = null;
  /**
   * Which run the events belong to.
   *
   * A cancel followed straight away by a retry has two PTYs alive at once for
   * as long as the kill takes, and the dying one still emits. Without this its
   * exit lands on the new run and reports the retry as finished before it has
   * compiled anything.
   */
  #run = 0;
  /**
   * A kill that has not landed yet.
   *
   * `pty.open` is attach-or-spawn on the thread id, so a launch that beats the
   * kill attaches to the process being killed rather than starting a new one:
   * the panel would show a corpse's last words and call them a retry. The
   * status flips to cancelled straight away regardless, because a Stop that
   * leaves the button saying "running" reads as a Stop that did nothing.
   */
  #closing: Promise<void> | null = null;

  get busy(): boolean {
    return this.status === "running";
  }

  /** Whether there is anything worth showing a log box for. */
  get hasOutput(): boolean {
    return this.lines.length > 0 || this.failure !== null;
  }

  install(): Promise<void> {
    return this.#launch("install");
  }

  update(): Promise<void> {
    return this.#launch("update");
  }

  uninstall(): Promise<void> {
    return this.#launch("uninstall");
  }

  /** The same thing again, which after a failure is the whole point. */
  retry(): Promise<void> {
    return this.#launch(this.action ?? "install");
  }

  /** Puts the panel back the way it was before any of this. */
  dismiss(): void {
    if (this.busy) return;
    this.#output.clear();
    this.lines = [];
    this.status = "idle";
    this.exitCode = null;
    this.failure = null;
  }

  /**
   * Stops the build. The run token moves first, so whatever the dying PTY still
   * has to say arrives for a run nobody is watching.
   */
  async cancel(): Promise<void> {
    const key = this.#key;
    if (!key) return;
    this.#run++;
    this.#key = null;
    this.#settle();
    this.status = "cancelled";
    const closing = ptyKill(key).catch((err: unknown) => {
      logger.warn("plugin", "the install would not be killed", { error: String(err) });
    });
    this.#closing = closing;
    await closing;
    if (this.#closing === closing) this.#closing = null;
    void codexSwitcher.probe();
    void this.#forgetRow();
  }

  async #launch(action: InstallAction): Promise<void> {
    if (this.busy) return;
    const project = target();
    if (!project) {
      notifications.error(t("fastpick.addProjectFirst"));
      return;
    }
    const command = COMMANDS[action]();
    // The same plan a thread launch builds, so the decision about whether this
    // needs a shell is the one the runner already makes everywhere else. It
    // only ever offers the shell: the machine owning the PTY decides.
    const plan = launchPlan({
      cmd: command.cmd,
      userArgs: command.args,
      iconKey: null,
      defaultShellId: settings.state.defaultShellId,
      powershellNoProfile: settings.state.powershellNoProfile,
    });

    const run = ++this.#run;
    this.action = action;
    this.status = "running";
    this.exitCode = null;
    this.failure = null;
    this.#output.clear();
    this.#queries.clear();
    this.#decoder = new TextDecoder();
    this.#owed = "";
    this.lines = [];

    try {
      // The previous process has to be gone before this one asks for the id.
      if (this.#closing) await this.#closing;
      const key = await ptyOpen(
        {
          threadId: INSTALL_THREAD_ID,
          spec: {
            cwd: project.cwd,
            cmd: plan.cmd,
            args: plan.args,
            cols: COLS,
            rows: ROWS,
            wrap: plan.wrap,
          },
          meta: { projectId: project.id, label: `codex-account-switcher ${action}`, iconKey: null },
        },
        (event) => this.#absorb(run, event),
        project.origin,
      );
      // A cancel while the open was in flight owns the outcome: the key it
      // could not have had yet is killed here rather than left running with
      // nothing holding it.
      if (run !== this.#run) {
        void ptyKill(key).catch(() => {});
        return;
      }
      this.#key = key;
      // The first question almost always beat this line here.
      this.#reply();
    } catch (err) {
      if (run !== this.#run) return;
      this.#fail(String(err));
    }
  }

  #absorb(run: number, event: PtyEvent): void {
    if (run !== this.#run) return;
    switch (event.type) {
      case "output": {
        const text = this.#decoder.decode(event.bytes, { stream: true });
        // Before anything is drawn: what the child is waiting on is more
        // urgent than what it has already said.
        this.#owed += this.#queries.answer(text);
        this.#reply();
        this.#output.push(text);
        this.#schedule();
        break;
      }
      // The server rolled the delta out of its ring and a full repaint follows.
      case "reset":
        this.#output.clear();
        this.lines = [];
        break;
      // The PTY behind it was replaced, so the key held here names nothing.
      case "key":
        this.#key = event.key;
        this.#reply();
        break;
      case "exit":
        this.#finish(event.code);
        break;
      case "error":
        this.#fail(event.message);
        break;
      case "title":
        break;
    }
  }

  /** Sends what the child is owed, once there is something to send it down. */
  #reply(): void {
    if (!this.#key || !this.#owed) return;
    const data = this.#owed;
    this.#owed = "";
    void ptyWrite(this.#key, this.#encoder.encode(data)).catch((err: unknown) => {
      logger.warn("plugin", "the build asked something we could not answer", {
        error: String(err),
      });
    });
  }

  #schedule(): void {
    if (this.#repaint) return;
    this.#repaint = setTimeout(() => {
      this.#repaint = null;
      this.lines = this.#output.snapshot();
    }, REPAINT_MS);
  }

  /** Everything the process printed, on screen, with no repaint still owed. */
  #settle(): void {
    if (this.#repaint) {
      clearTimeout(this.#repaint);
      this.#repaint = null;
    }
    this.#output.end();
    this.lines = this.#output.snapshot();
  }

  #finish(code: number | null): void {
    this.#settle();
    this.#key = null;
    this.exitCode = code;
    this.status = code === 0 ? "done" : "failed";
    if (code !== 0) {
      logger.warn("plugin", `${this.action ?? "install"} exited ${code}`, {
        tail: this.lines.slice(-5).join("\n"),
      });
    }
    // Asked after either outcome. An install that failed may still have put a
    // binary down, and an uninstall that failed because there was nothing to
    // remove has moved the panel's answer just as much as one that worked.
    void codexSwitcher.probe();
    void this.#forgetRow();
  }

  #fail(message: string): void {
    this.#settle();
    this.#key = null;
    this.status = "failed";
    this.failure = message;
    logger.warn("plugin", `${this.action ?? "install"} never ran`, { message });
    void this.#forgetRow();
  }

  /**
   * Drops the thread row a remote spawn had to create.
   *
   * The remote transport has no PTY that is not a thread: `thread.spawn` is the
   * only way to start a process on a boite, and it writes a row the sidebar
   * then lists. Locally `pty_open` needs no row and there is nothing here to
   * remove, which is why this asks rather than branching on the origin.
   *
   * So a remote install still shows a thread for as long as it runs. That half
   * is the transport's, not this panel's, and leaving the row behind afterwards
   * would be this panel's.
   */
  async #forgetRow(): Promise<void> {
    if (!app.hasThread(INSTALL_THREAD_ID)) return;
    try {
      await app.removeThread(INSTALL_THREAD_ID);
    } catch (err) {
      logger.warn("plugin", "the install thread row stayed behind", { error: String(err) });
    }
  }
}

export const installer = new CodexSwitcherInstaller();
