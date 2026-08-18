import { app } from "$lib/app/store.svelte";
import { launchPlan } from "$lib/features/terminal/launch";
import { notifications } from "$lib/features/notifications/store.svelte";
import { settings } from "$lib/features/settings/store.svelte";
import { logger } from "$lib/shared/services/logger.svelte";
import { ptyKill, ptyOpen, ptyWrite } from "$lib/storage/pty";
import { t } from "$lib/i18n/index.svelte";
import { doctorCommand, installCommand, uninstallCommand, updateCommand } from "./install";
import type { InstallScript } from "./install";
import { InstallOutput, TerminalQueries } from "$lib/features/fastpick/install-output";
import { accounts } from "./store.svelte";
import type { PtyEvent } from "$lib/backend/types";
import type { Project } from "$lib/types";

/**
 * Installing the account switcher without leaving the settings panel, the way
 * fastpick is installed one card away.
 *
 * A real PTY rather than a plain command, and here it is load-bearing twice
 * over: the toolkit is delivered down it. Install and uninstall spawn an
 * interactive `pwsh` and type the vendored files into it, because nothing else
 * reaches the home directory of the machine the threads run on. Beyond that,
 * failures are the script's own error text, and a run that hangs has to be
 * killable. What is drawn is only the tail of what it printed.
 *
 * Unlike fastpick's, one of these commands is destructive: uninstall removes the
 * tools, the slash commands and the profile function. It leaves the saved logins
 * alone, which is what the card says under the button.
 */

/**
 * One id for every run, rather than a fresh one per launch.
 *
 * `pty.open` is attach-or-spawn keyed on it, so a panel closed mid-install and
 * reopened lands back on the same process with its scrollback replayed instead
 * of starting a second installer beside the first.
 */
const INSTALL_THREAD_ID = "accounts-install";

/**
 * The size the installer believes it has. Nothing measures the log panel, and
 * its progress lines want room not to wrap into noise.
 */
const COLS = 120;
const ROWS = 30;

/** How often the lines on screen are replaced while something is running. */
const REPAINT_MS = 120;

export type InstallAction = "install" | "update" | "uninstall" | "doctor";

const COMMANDS: Record<InstallAction, () => InstallScript> = {
  install: installCommand,
  update: updateCommand,
  uninstall: uninstallCommand,
  doctor: doctorCommand,
};

export type InstallStatus = "idle" | "running" | "done" | "failed" | "cancelled";

/**
 * Where to run it. Any project will do: this installs a toolkit into the home
 * directory, not something belonging to a repository, and the current one keeps
 * it on the machine the user was looking at.
 */
function target(): Project | null {
  return app.projects.find((p) => p.id === app.currentProjectId) ?? app.projects[0] ?? null;
}

class AccountsInstaller {
  /** Which command is running, or the one that last ran. */
  action = $state<InstallAction | null>(null);
  status = $state<InstallStatus>("idle");
  /** The log, tail only. Replaced wholesale, never pushed into. */
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
   * answer because the key was late leaves the installer suspended exactly as
   * if nothing had answered at all.
   */
  #owed = "";
  #repaint: ReturnType<typeof setTimeout> | null = null;
  /**
   * Which run the events belong to. A cancel followed straight away by a retry
   * has two PTYs alive at once, and the dying one still emits.
   */
  #run = 0;
  /**
   * A kill that has not landed yet. `pty.open` is attach-or-spawn on the thread
   * id, so a launch that beats the kill attaches to the process being killed
   * rather than starting a new one.
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

  /** The switcher's own self-check, in the panel that installed it. */
  doctor(): Promise<void> {
    return this.#launch("doctor");
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
   * Stops the run. The run token moves first, so whatever the dying PTY still
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
      logger.warn("accounts", "the installer would not be killed", { error: String(err) });
    });
    this.#closing = closing;
    await closing;
    if (this.#closing === closing) this.#closing = null;
    // A half-finished install has still moved what is on disk.
    void accounts.probe();
    void this.#forgetRow();
  }

  async #launch(action: InstallAction): Promise<void> {
    if (this.busy) return;
    const project = target();
    if (!project) {
      notifications.error(t("accounts.addProjectFirst"));
      return;
    }
    const command = COMMANDS[action]();
    // The same plan a thread launch builds, so the decision about whether this
    // needs a shell is the one the runner already makes everywhere else.
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
          meta: { projectId: project.id, label: `account switcher ${action}`, iconKey: null },
        },
        (event) => this.#absorb(run, event),
        project.origin,
      );
      // A cancel while the open was in flight owns the outcome: the key it could
      // not have had yet is killed here rather than left running.
      if (run !== this.#run) {
        void ptyKill(key).catch(() => {});
        return;
      }
      this.#key = key;
      // The first question almost always beat this line here.
      this.#reply();
      if (command.stdin) await this.#feed(run, command.stdin);
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
        // Before anything is drawn: what the child is waiting on is more urgent
        // than what it has already said.
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

  /**
   * Types a script into the shell it was opened for, in batches.
   *
   * One write of the whole thing hands a console input buffer more than it
   * takes at once, and the tail would be dropped silently — as a half-written
   * file rather than as an error.
   */
  async #feed(run: number, lines: string[]): Promise<void> {
    const BATCH = 8192;
    let pending = "";
    for (const line of lines) {
      // Escaped, not a real carriage return in the source: a bare CR inside a
      // template literal is invisible and does not survive line-ending
      // normalisation, and losing it sends the whole script as one line.
      pending += `${line}`;
      if (pending.length < BATCH) continue;
      if (!(await this.#type(run, pending))) return;
      pending = "";
    }
    if (pending) await this.#type(run, pending);
  }

  /** One write, or false when the run is over and the rest is pointless. */
  async #type(run: number, text: string): Promise<boolean> {
    const key = this.#key;
    if (!key || run !== this.#run) return false;
    try {
      await ptyWrite(key, this.#encoder.encode(text));
      return true;
    } catch (err) {
      if (run === this.#run) this.#fail(String(err));
      return false;
    }
  }

  /** Sends what the child is owed, once there is something to send it down. */
  #reply(): void {
    if (!this.#key || !this.#owed) return;
    const data = this.#owed;
    this.#owed = "";
    void ptyWrite(this.#key, this.#encoder.encode(data)).catch((err: unknown) => {
      logger.warn("accounts", "the installer asked something we could not answer", {
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
      logger.warn("accounts", `${this.action ?? "install"} exited ${code}`, {
        tail: this.lines.slice(-5).join("\n"),
      });
    }
    // Asked after either outcome. An install that failed may still have written
    // half the toolkit, and an uninstall that failed because there was nothing
    // to remove has moved the panel's answer just as much as one that worked.
    void accounts.probe();
    void this.#forgetRow();
  }

  #fail(message: string): void {
    this.#settle();
    this.#key = null;
    this.status = "failed";
    this.failure = message;
    logger.warn("accounts", `${this.action ?? "install"} never ran`, { message });
    void this.#forgetRow();
  }

  /**
   * Drops the thread row a remote spawn had to create.
   *
   * The remote transport has no PTY that is not a thread, so a run on a boite
   * writes a row the sidebar then lists. Locally there is nothing to remove,
   * which is why this asks rather than branching on the origin.
   */
  async #forgetRow(): Promise<void> {
    if (!app.hasThread(INSTALL_THREAD_ID)) return;
    try {
      await app.removeThread(INSTALL_THREAD_ID);
    } catch (err) {
      logger.warn("accounts", "the install thread row stayed behind", { error: String(err) });
    }
  }
}

export const installer = new AccountsInstaller();
