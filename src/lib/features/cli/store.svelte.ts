import { backend } from "$lib/backend";
import type { Backend, CliDataPath, CliJob, CliRow } from "$lib/backend";
import { logger } from "$lib/shared/services/logger.svelte";
import { cliDetection } from "$lib/features/settings/cliDetection.svelte";
import { makeInstaller, type PluginInstaller } from "$lib/features/plugin/installer.svelte";

/**
 * How often a running job is asked what it is doing.
 *
 * Polled rather than pushed. A download reports its progress from Rust, and a
 * poll is the one path that reaches both hosts: the desktop and a phone talking
 * to a `boite-server` read the same call, nothing is written twice, and a panel
 * opened halfway through an install sees where it got to instead of waiting for
 * the next event that was never buffered.
 */
const POLL_MS = 500;

/** Whether nothing more will happen to this job. Mirrors `jobs::Phase::settled`. */
export function settled(job: CliJob | null | undefined): boolean {
  return job === null || job === undefined
    ? true
    : job.phase === "done" || job.phase === "failed" || job.phase === "cancelled";
}

/**
 * The agent CLIs: what is installed, what is being installed, and what came of it.
 *
 * The rows come from `boite_core::cli_manager` and are not rebuilt here: the
 * install recipes, the platform support and the data directories are Rust's, so
 * this store holds no package name and no path of its own. What it adds is the
 * polling, the per-CLI PTY installer for the agents that ship on a package
 * manager, and one guard: every answer is dropped if the boite it was asked of
 * is no longer the boite on screen.
 */
class CliManager {
  rows = $state<CliRow[]>([]);
  /** The live job per CLI id, settled ones included until they are dismissed. */
  jobs = $state<Record<string, CliJob>>({});
  loading = $state(false);
  error = $state<string | null>(null);

  /**
   * Which transport answered. A CLI list is one machine's, the same way
   * `cliDetection`'s map is: switching boite has to drop the rows rather than
   * show the other machine's.
   */
  #answeredBy: Backend | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #installers = new Map<string, PluginInstaller>();

  /** Whether any job is still running, which is what disables the row's buttons. */
  get busy(): boolean {
    return Object.values(this.jobs).some((job) => !settled(job));
  }

  jobFor(id: string): CliJob | null {
    return this.jobs[id] ?? null;
  }

  rowFor(id: string): CliRow | null {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  /** Loads the list unless this boite's is already on screen. */
  async ensure(): Promise<void> {
    if (this.#answeredBy === backend() && this.rows.length > 0) {
      await this.#pollOnce();
      return;
    }
    await this.refresh(true);
  }

  /**
   * Re-reads the list. `probeVersions` costs a process spawn per installed CLI on
   * the machine that runs them, so it is asked for when the tab opens and left
   * off when only presence changed.
   */
  async refresh(probeVersions = true): Promise<void> {
    const from = backend();
    this.#answeredBy = from;
    this.loading = true;
    try {
      const [rows, jobs] = await Promise.all([from.cli.catalog(probeVersions), from.cli.jobs()]);
      if (this.#answeredBy !== from) return;
      this.rows = rows;
      this.jobs = Object.fromEntries(jobs.map((job) => [job.id, job]));
      this.error = null;
      this.#schedule();
    } catch (err) {
      if (this.#answeredBy !== from) return;
      this.error = String(err);
      logger.warn("cli", "the CLI list could not be read", { error: String(err) });
    } finally {
      if (this.#answeredBy === from) this.loading = false;
    }
  }

  async install(id: string): Promise<void> {
    const from = backend();
    try {
      const job = await from.cli.install(id);
      if (this.#answeredBy !== from) return;
      this.jobs = { ...this.jobs, [id]: job };
      this.#schedule();
    } catch (err) {
      this.#failLocally(id, "install", err);
    }
  }

  async uninstall(id: string, purgeData: boolean): Promise<void> {
    const from = backend();
    try {
      const job = await from.cli.uninstall(id, purgeData);
      if (this.#answeredBy !== from) return;
      this.jobs = { ...this.jobs, [id]: job };
      this.#schedule();
    } catch (err) {
      this.#failLocally(id, "uninstall", err);
    }
  }

  async cancel(id: string): Promise<void> {
    try {
      await backend().cli.cancel(id);
    } catch (err) {
      logger.warn("cli", "the job would not stop", { id, error: String(err) });
    }
    await this.#pollOnce();
  }

  async dismiss(id: string): Promise<void> {
    const remaining = { ...this.jobs };
    delete remaining[id];
    this.jobs = remaining;
    try {
      await backend().cli.dismiss(id);
    } catch (err) {
      logger.warn("cli", "a settled job would not be forgotten", { id, error: String(err) });
    }
  }

  dataPaths(id: string): Promise<CliDataPath[]> {
    return backend().cli.dataPaths(id);
  }

  /**
   * The PTY installer for a CLI that ships on a package manager.
   *
   * One per CLI and kept: it holds a thread id, and a second instance would
   * attach to the first one's process and draw its log twice. The command lines
   * are read off the row at launch rather than captured now, so a catalogue that
   * changed under a reopened panel is the one that runs.
   */
  installerFor(row: CliRow): PluginInstaller | null {
    if (row.source !== "managed") return null;
    const existing = this.#installers.get(row.id);
    if (existing) return existing;
    const line = (argv: string[] | null) => {
      const [cmd, ...args] = argv ?? [];
      return { cmd: cmd ?? "", args };
    };
    const made = makeInstaller(
      `cli-${row.id}`,
      {
        install: () => line(this.rowFor(row.id)?.installCommand ?? row.installCommand),
        update: () => line(this.rowFor(row.id)?.updateCommand ?? row.updateCommand),
        uninstall: () => line(this.rowFor(row.id)?.uninstallCommand ?? row.uninstallCommand),
      },
      () => {
        void this.refresh(true);
        void cliDetection.refreshOne(row.exe);
      },
    );
    this.#installers.set(row.id, made);
    return made;
  }

  /**
   * A call that never reached Rust has no job to poll, so it writes one here.
   *
   * Without it a refusal the bus produced — a CLI with no build for this
   * platform, a job already running — would leave the row looking untouched, and
   * the only way to see why would be the log.
   */
  #failLocally(id: string, kind: CliJob["kind"], err: unknown): void {
    const now = Date.now();
    this.jobs = {
      ...this.jobs,
      [id]: {
        id,
        kind,
        phase: "failed",
        received: 0,
        total: null,
        version: null,
        message: String(err),
        startedAt: now,
        updatedAt: now,
      },
    };
  }

  /** Keeps one timer, and only while something is running. */
  #schedule(): void {
    if (this.#timer !== null) return;
    if (!this.busy) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#pollOnce().then(() => this.#schedule());
    }, POLL_MS);
  }

  async #pollOnce(): Promise<void> {
    const from = backend();
    if (this.#answeredBy !== from) return;
    let jobs: CliJob[];
    try {
      jobs = await from.cli.jobs();
    } catch (err) {
      logger.warn("cli", "a job could not be read back", { error: String(err) });
      return;
    }
    if (this.#answeredBy !== from) return;
    const wasBusy = this.busy;
    // Merged rather than replaced: a job Rust has already aged out of its table
    // is a job whose verdict is the only thing left of it, and the panel is
    // usually the reason it is still on screen.
    const merged = { ...this.jobs };
    for (const job of jobs) merged[job.id] = job;
    this.jobs = merged;
    if (wasBusy && !this.busy) {
      // A finished install changed what is on the PATH, and the shortcut rows
      // read that from `cliDetection` rather than from here.
      await this.refresh(true);
      const changed = jobs.filter((job) => settled(job)).map((job) => this.rowFor(job.id)?.exe);
      for (const exe of changed) {
        if (exe) void cliDetection.refreshOne(exe);
      }
    }
  }
}

export const cliManager = new CliManager();
