/*
 * What the companion reacts to around it, as pure rules: an answer saying the
 * tests pass (confetti), and the first minutes of the user's day before 11:00
 * (a cup of coffee). The game in front comes from the shell, classified there
 * (`platform/games.rs`).
 */

/** How long the coffee lasts after the day's first sign of the user. */
export const COFFEE_MS = 10 * 60_000;
/** The day turns at 5:00: a sign after midnight belongs to the night before. */
const DAY_TURNS_AT = 5;
const COFFEE_UNTIL = 11;
const DAY_KEY = 'boite.companion.day';

/** The day's first sign of the user. */
export interface DayStart {
  /** The day, as `dayOf` names it. */
  day: string;
  /** When the sign came, epoch milliseconds. */
  at: number;
}

/** The day `time` belongs to, turning at 5:00, as `year-month-date`. */
export function dayOf(time: number): string {
  const date = new Date(time - DAY_TURNS_AT * 3_600_000);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** The day's first sign, given the one kept and a sign at `now`. */
export function firstSign(kept: DayStart | null, now: number): DayStart {
  const day = dayOf(now);
  return kept?.day === day && kept.at <= now ? kept : { day, at: now };
}

/** Whether the companion holds its coffee at `now`: the day's first ten minutes, before 11:00. */
export function coffeeTime(start: DayStart | null, now: number): boolean {
  if (!start || start.day !== dayOf(now) || now < start.at || now - start.at >= COFFEE_MS) return false;
  const hour = new Date(now).getHours();
  return hour >= DAY_TURNS_AT && hour < COFFEE_UNTIL;
}

export function readDayStart(): DayStart | null {
  try {
    const value = JSON.parse(localStorage.getItem(DAY_KEY) ?? 'null') as Partial<DayStart> | null;
    return typeof value?.day === 'string' && typeof value.at === 'number' && Number.isFinite(value.at) ? { day: value.day, at: value.at } : null;
  } catch {
    return null;
  }
}

export function writeDayStart(start: DayStart): void {
  try {
    localStorage.setItem(DAY_KEY, JSON.stringify(start));
  } catch {
    /* private mode: the coffee comes back on a reload */
  }
}

// "tests pass", "all 42 tests passed", "the test suite is green", "specs: 12 passed", "tests OK".
const PASSED_EN =
  /\b(?:test suites?|tests?|specs?|suites?|checks?)\b:?(?:\s+(?:\(\d+\)|\d+(?:\/\d+)?|all|now|is|are|was|were|have|has|still|again|both|locally|successfully|cleanly|fully|also))*\s+(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?|ok)\b/i;
// "42 passed", "42/42 tests pass", bun's "42 pass".
const PASSED_COUNT = /\b\d+(?:\/\d+)?\s+(?:tests?\s+|specs?\s+)?pass(?:es|ed|ing)?\b/i;
// "les tests passent", "tous les tests sont au vert", "42 tests réussis", "tests OK".
const PASSED_FR =
  /\btests?\b:?(?:\s+(?:\(\d+\)|\d+(?:\/\d+)?|passent|sont|est|tous|toujours|bien|maintenant|encore|de nouveau|à nouveau|au complet))*\s+(?:passent|passe|r[ée]ussi(?:s|ssent)?|verts?|au vert|ok)(?![\p{L}\d])/iu;
/** Words that turn a clause around: a failure, a negation. */
const CONTRARY = /\bfail|\bbroken\b|\bnot\b|n['’]t\b|[ée]chou|[ée]checs?\b|\bcass[ée]|\bne\s+\S+\s+pas\b|\bn['’]\S+\s+pas\b|\bpas\s+(?:tous|encore)\b|\bau rouge\b/i;
/** A failure reported anywhere in the answer. */
const FAILURE =
  /\b[1-9]\d*\s+(?:tests?\s+|specs?\s+)?fail(?:s|ed|ing|ures?)?\b|\btests?\s+(?:still\s+|are\s+|were\s+)*fail(?:s|ed|ing)?\b|\b[1-9]\d*\s+(?:tests?\s+)?(?:en\s+)?[ée]checs?\b|\btests?\s+(?:\S+\s+){0,2}?[ée]chou|\bne\s+passent\s+pas\b/i;
/** "0 failed", "no failures", "aucun échec": not a failure. */
const NO_FAILURE =
  /\b(?:0|zero|no)\s+(?:tests?\s+)?(?:fail(?:s|ed|ing|ures?)?|errors?)\b|\bwithout\s+(?:any\s+)?(?:failures?|errors?)\b|\baucun(?:e)?\s+(?:test\s+)?(?:[ée]checs?|[ée]chou[ée]s?|erreurs?)\b|\bsans\s+(?:aucun\s+)?(?:[ée]checs?|erreurs?)\b|\b0\s+[ée]checs?\b/gi;

/**
 * Whether an answer says the tests pass, in English or French: a clause says
 * so without a failure or a negation in it, and no failure is reported
 * elsewhere. In doubt it says no: confetti for failing tests would be worse
 * than none for passing ones.
 */
export function testsPassed(text: string): boolean {
  const plain = text.replace(NO_FAILURE, ' ');
  if (FAILURE.test(plain)) return false;
  return plain.split(/[.!?;\n]+/).some((clause) => (PASSED_EN.test(clause) || PASSED_COUNT.test(clause) || PASSED_FR.test(clause)) && !CONTRARY.test(clause));
}
