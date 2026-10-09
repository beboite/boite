/*
 * The companion's reactions to what goes on around it: the gaming headset
 * while a game is in front (`companion://foreground`, from the shell), the
 * morning coffee and the confetti when another thread's answer says the tests
 * pass. The rules are in `reactions.ts`.
 */
import { listenShell } from './shell';
import { COFFEE_MS, coffeeTime, firstSign, readDayStart, testsPassed, writeDayStart, type DayStart } from './reactions';

/** How long the confetti and the cheer last. */
export const CHEER_MS = 2600;

/** What the shell says of the app in front: never a window title. */
export interface FrontApp {
  exe: string;
  game: boolean;
}

export class Reactions {
  /** A game is in front. */
  game = $state(false);
  /** It holds its morning coffee. */
  coffee = $state(false);
  /** Bumped for each burst of confetti; 0 before the first. */
  cheer = $state(0);
  cheering = $state(false);

  private start: DayStart | null = readDayStart();
  private coffeeTimer: ReturnType<typeof setTimeout> | undefined;
  private cheerTimer: ReturnType<typeof setTimeout> | undefined;
  private stop: (() => void) | null = null;
  private disposed = false;

  constructor(private readonly host: { quiet(): boolean } = { quiet: () => false }) {
    this.brew(Date.now());
    void listenShell<FrontApp>('foreground', (app) => (this.game = app.game === true)).then((stop) => (this.disposed ? stop() : (this.stop = stop)));
  }

  /** A sign of the user (`Senses`): the first one of the day starts the coffee. */
  sign(at: number): void {
    const start = firstSign(this.start, at);
    if (start === this.start) return;
    this.start = start;
    writeDayStart(start);
    this.brew(at);
  }

  /** Another thread's final answer, as the notes read it. */
  answered(text: string): void {
    if (this.host.quiet() || !testsPassed(text)) return;
    this.cheer++;
    this.cheering = true;
    clearTimeout(this.cheerTimer);
    this.cheerTimer = setTimeout(() => (this.cheering = false), CHEER_MS);
  }

  /** Holds the coffee now if it is time, and looks again at least once a minute (11:00 ends it too). */
  private brew(now: number) {
    clearTimeout(this.coffeeTimer);
    this.coffee = coffeeTime(this.start, now);
    if (this.coffee && this.start) this.coffeeTimer = setTimeout(() => this.brew(Date.now()), Math.min(60_000, Math.max(1000, this.start.at + COFFEE_MS - now + 50)));
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.coffeeTimer);
    clearTimeout(this.cheerTimer);
    this.stop?.();
  }
}
