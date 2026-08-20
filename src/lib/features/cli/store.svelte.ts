import { backend } from "$lib/backend";
import type { Backend, CliDataPath, CliJob, CliLatest, CliRow } from "$lib/backend";
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

/**
 * How many polls in a row may fail before the running jobs are called off.
 *
 * A boite that stopped answering leaves a row saying "downloading" with nothing
 * behind it, and it says so for as long as the panel is open. Three misses is
 * about a second and a half, which is longer than a reload of the socket and
 * shorter than anybody's patience.
 */
const POLL_MISSES_ALLOWED = 3;

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
  /**
   * What each vendor publishes right now, per CLI id. Absent while nobody has
   * asked and null where asking failed, which the row reads the same way: it
   * does not know of an update, so it does not offer one.
   */
  latest = $state<Record<string, string | null>>({});
  /** Whether the vendors are being asked, for the row that says so. */
  checking = $state(false);
  loading = $state(false);
  error = $state<string | null>(null);

  /**
   * Which transport answered. A CLI list is one machine's, the same way
   * `cliDetection`'s map is: switching boite has to drop the rows rather than
   * show the other machine's.
   */
  #answeredBy: Backend | null = null;
  /** Which transport answered `checkLatest`, so switching boite asks again. */
  #checkedBy: Backend | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #installers = new Map<string, PluginInstaller>();
  #misses = 0;

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

  latestFor(id: string): string | null | undefined {
    return this.latest[id];
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
   * Asks every vendor what it publishes, so a row can say it is current.
   *
   * Not awaited by `refresh`: the rows are this machine's answer and arrive in
   * milliseconds, this is six web servers and does not. Asked once per boite
   * unless the caller says otherwise, because the answer does not change while a
   * settings panel is open — the button that reruns it is `cli.recheck`.
   */
  async checkLatest(force = false): Promise<void> {
    const from = backend();
    if (!force && this.#checkedBy === from) return;
    this.#checkedBy = from;
    this.checking = true;
    try {
      const answers = await from.cli.latest();
      if (this.#checkedBy !== from) return;
      this.latest = Object.fromEntries(
        answers.map((answer: CliLatest) => [answer.id, answer.version]),
      );
      for (const answer of answers) {
        // Reported rather than swallowed, and only to the log: a vendor that is
        // unreachable changes nothing the user has to act on, and the row simply
        // stops claiming to know what is current.
        if (answer.error) {
          logger.warn("cli", "a vendor would not say what it publishes", {
            id: answer.id,
            error: answer.error,
          });
        }
      }
    } catch (err) {
      if (this.#checkedBy !== from) return;
      // Forgotten so the next open asks again rather than trusting a check that
      // never happened.
      this.#checkedBy = null;
      logger.warn("cli", "the published versions could not be read", { error: String(err) });
    } finally {
      if (this.#checkedBy === from || this.#checkedBy === null) this.checking = false;
    }
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
      // The job runs on the other machine, so a refusal here means it is still
      // running: calling it failed would be this panel inventing an outcome. The
      // card says the ask did not land, and the poll keeps reporting the truth.
      this.error = String(err);
      logger.warn("cli", "the job would not stop", { id, error: String(err) });
      return;
    }
    await this.#pollOnce();
  }

  /**
   * Forgets a failed install and starts it again.
   *
   * Both halves, in that order: a settled job still holds the slot Rust checks
   * before starting another, so retrying without dismissing is refused as
   * "already running" by the job that just failed.
   *
   * Installs only. A removal that failed is not retried behind the user's back:
   * what it was asked to do included an answer about their data, and repeating it
   * from a button labelled "try again" would repeat a decision rather than an
   * action. The row offers Dismiss, and Uninstall asks again.
   */
  async retry(id: string): Promise<void> {
    if (this.jobFor(id)?.kind === "uninstall") {
      await this.dismiss(id);
      return;
    }
    await this.dismiss(id);
    await this.install(id);
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
    const previous = this.jobs[id] ?? null;
    this.jobs = {
      ...this.jobs,
      [id]: {
        id,
        kind,
        phase: "failed",
        // What it had got to is kept: "it stopped at 40 MB of 60" and "it stopped"
        // are different things to read.
        received: previous?.received ?? 0,
        total: previous?.total ?? null,
        version: previous?.version ?? null,
        message: String(err),
        startedAt: previous?.startedAt ?? now,
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
      this.#misses = 0;
    } catch (err) {
      logger.warn("cli", "a job could not be read back", { error: String(err) });
      this.#misses += 1;
      if (this.#misses >= POLL_MISSES_ALLOWED && this.#answeredBy === from) {
        // Nothing here can tell a boite that went away from one that is merely
        // slow, and a row that stays "downloading" for good is the worse of the
        // two answers. What the machine is doing is unchanged; what is being
        // reported is that this panel no longer knows.
        for (const job of Object.values(this.jobs)) {
          if (!settled(job)) this.#failLocally(job.id, job.kind, err);
        }
      }
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
