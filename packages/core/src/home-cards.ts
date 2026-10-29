/*
 * Home cards (`docs/home-cards.md`): `<dataDir>/home-cards/<id>/card.json`,
 * read-only status cards the new-thread screen shows under the composer, and
 * the optional `refresh.json` beside it that names the owner's script writing
 * that file. The core reads the files, runs the one command on the card's
 * button and on its schedule, and never shows a client the script's output.
 *
 * Reads are a few `stat`s every half minute: no watcher, nothing at startup
 * but one directory listing, and a script that runs long after the core
 * started only when its card has grown older than its interval.
 */

import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  HOME_CARD_FILE,
  HOME_CARD_MAX_BYTES,
  HOME_CARD_REFRESH_FILE,
  HOME_CARDS_DIR,
  isHomeCardId,
  readHomeCard,
  readHomeCardRefresh,
  type HomeCard,
  type HomeCardCommand,
  type HomeCardRun,
} from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams, refused } from './errors.ts';
import { runCommand } from './run-command.ts';

/** How often the files are looked at and the schedules checked. */
export const HOME_CARD_TICK_MS = 30_000;
/** A refresh that has not ended by then is stopped with everything it started. */
export const HOME_CARD_RUN_TIMEOUT_MS = 120_000;

interface Entry {
  card: HomeCard;
  command: HomeCardCommand | null;
  /** Size and change time of both files: a card is read again only when one moved. */
  signature: string;
  /** When the last run started, so a script that fails waits a whole interval before the next. */
  attemptedAt: number;
  lastRun: HomeCardRun | null;
}

function fileStamp(path: string): { stamp: string; mtime: number } | null {
  try {
    const stat = statSync(path);
    return stat.isFile() ? { stamp: `${stat.size}:${stat.mtimeMs}`, mtime: stat.mtimeMs } : null;
  } catch {
    return null;
  }
}

function readSmall(path: string, name: string): { text: string } | { error: string } | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return { error: `${name}: not a regular file` };
    if (stat.size > HOME_CARD_MAX_BYTES) return { error: `${name}: larger than ${HOME_CARD_MAX_BYTES / 1024} KB` };
    return { text: readFileSync(path, 'utf8') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { error: `${name}: could not be read (${error instanceof Error ? error.message : String(error)})` };
  }
}

export class HomeCardStore {
  readonly dir: string;
  #entries = new Map<string, Entry>();
  #runs = new Map<string, Promise<HomeCard>>();
  #tick: ReturnType<typeof setInterval> | null = null;
  #closed = false;
  #last = '[]';

  constructor(private readonly core: Core) {
    this.dir = join(core.dataDir, HOME_CARDS_DIR);
  }

  start(): void {
    this.#scan();
    this.#tick = setInterval(() => this.#onTick(), HOME_CARD_TICK_MS);
    this.#tick.unref?.();
  }

  list(): HomeCard[] {
    return [...this.#entries.values()].map(entry => structuredClone(entry.card));
  }

  /** Runs the card's command now, or joins the run already going. */
  refresh(id: string): Promise<HomeCard> {
    if (typeof id !== 'string' || !isHomeCardId(id)) throw invalidParams(`id: expected a home card id (lowercase letters, digits and inner hyphens), found ${JSON.stringify(id)}`);
    const running = this.#runs.get(id);
    if (running) return running;
    this.#scan();
    const entry = this.#entries.get(id);
    if (!entry) throw invalidParams(`id: no home card "${id}" in ${this.dir}`);
    if (!entry.command) throw refused(`${id} has no usable ${HOME_CARD_REFRESH_FILE} in ${join(this.dir, id)}`);
    return this.#run(id, entry.command);
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#tick !== null) clearInterval(this.#tick);
    this.#tick = null;
    await Promise.allSettled([...this.#runs.values()]);
  }

  #onTick(): void {
    if (this.#closed) return;
    this.#scan();
    const now = Date.now();
    for (const [id, entry] of this.#entries) {
      const every = entry.command?.everyMinutes;
      if (!entry.command || !every || this.#runs.has(id)) continue;
      const since = Math.max(entry.attemptedAt, entry.card.changedAt ?? 0);
      if (now - since >= every * 60_000) {
        void this.#run(id, entry.command).catch(error => this.core.log('warn', `home card ${id}: ${String(error)}`));
      }
    }
  }

  #run(id: string, command: HomeCardCommand): Promise<HomeCard> {
    if (this.#closed) throw refused('Boite is shutting down.');
    const entry = this.#entries.get(id)!;
    entry.attemptedAt = Date.now();
    const cwd = join(this.dir, id);
    // Read back by the run itself, to clear its own slot and never a later run's.
    let run!: Promise<HomeCard>;
    run = (async () => {
      const [executable, ...args] = command.command;
      const result = await runCommand(this.core.procs, `home-card:${id}`, executable!, args, HOME_CARD_RUN_TIMEOUT_MS, {
        cwd,
        env: { BOITE_HOME_CARD: join(cwd, HOME_CARD_FILE) },
      });
      // Never the script's own output: whatever it printed stays here.
      const message = result.timedOut
        ? `did not finish within ${HOME_CARD_RUN_TIMEOUT_MS / 60_000} minutes and was stopped`
        : result.code === null
          ? `could not start ${executable}: ${result.stderr.slice(0, 200)}`
          : result.code !== 0 ? `exited with code ${result.code}` : null;
      if (message) this.core.log('warn', `home card ${id}: ${command.command[0]} ${message}`);
      const current = this.#entries.get(id);
      if (current) current.lastRun = { at: Date.now(), ok: message === null, message };
      if (this.#runs.get(id) === run) this.#runs.delete(id);
      this.#scan(true);
      const card = this.#entries.get(id)?.card;
      if (!card) throw refused(`home card ${id} was removed during its refresh`);
      return structuredClone(card);
    })();
    run.catch(() => {}).finally(() => { if (this.#runs.get(id) === run) this.#runs.delete(id); });
    this.#runs.set(id, run);
    this.#publish();
    return run;
  }

  /** Reads what moved on disk and announces the list when anything a client sees changed. */
  #scan(force = false): void {
    let names: string[] = [];
    try {
      names = readdirSync(this.dir).filter(name => isHomeCardId(name)).sort();
    } catch {
      // No directory yet: no card.
    }
    const seen = new Set<string>();
    for (const id of names) {
      const directory = join(this.dir, id);
      try {
        // A link could point the reads and the command's cwd anywhere.
        if (!lstatSync(directory).isDirectory()) continue;
      } catch {
        continue;
      }
      seen.add(id);
      const cardFile = join(directory, HOME_CARD_FILE);
      const refreshFile = join(directory, HOME_CARD_REFRESH_FILE);
      const card = fileStamp(cardFile);
      const signature = `${card?.stamp ?? '-'}|${fileStamp(refreshFile)?.stamp ?? '-'}`;
      const previous = this.#entries.get(id);
      if (previous && previous.signature === signature && !force) continue;
      const errors: string[] = [];
      let content: HomeCard['content'] = null;
      const cardText = readSmall(cardFile, HOME_CARD_FILE);
      if (cardText === null) errors.push(`${HOME_CARD_FILE}: missing; the refresh script writes it`);
      else if ('error' in cardText) errors.push(cardText.error);
      else {
        const read = readHomeCard(cardText.text);
        if (read.ok) content = read.value;
        else errors.push(read.error);
      }
      let command: HomeCardCommand | null = null;
      const refreshText = readSmall(refreshFile, HOME_CARD_REFRESH_FILE);
      if (refreshText !== null) {
        if ('error' in refreshText) errors.push(refreshText.error);
        else {
          const read = readHomeCardRefresh(refreshText.text);
          if (read.ok) command = read.value;
          else errors.push(read.error);
        }
      }
      for (const error of errors) if (!previous?.card.error?.includes(error)) this.core.log('warn', `home card ${id}: ${error}`);
      this.#entries.set(id, {
        card: { id, content, changedAt: card ? Math.round(card.mtime) : null, error: errors.length ? errors.join('\n') : null, refresh: null },
        command,
        signature,
        attemptedAt: previous?.attemptedAt ?? 0,
        lastRun: previous?.lastRun ?? null,
      });
    }
    for (const id of [...this.#entries.keys()]) if (!seen.has(id)) this.#entries.delete(id);
    this.#publish();
  }

  /** Puts each card's run state on it, then emits the list if it differs from the last one sent. */
  #publish(): void {
    for (const [id, entry] of this.#entries) {
      entry.card.refresh = entry.command
        ? { everyMinutes: entry.command.everyMinutes, running: this.#runs.has(id), lastRun: entry.lastRun }
        : null;
    }
    const cards = this.list();
    const next = JSON.stringify(cards);
    if (next === this.#last) return;
    this.#last = next;
    this.core.bus.emit('homeCards.updated', cards);
  }
}

export function registerHomeCardMethods(core: Core): void {
  core.router.register('homeCards.list', () => core.homeCards.list());
  core.router.register('homeCards.refresh', ({ id }) => core.homeCards.refresh(id));
}
