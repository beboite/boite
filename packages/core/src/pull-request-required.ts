/**
 * The checks a pull request's base branch requires before it merges. A
 * check's own `isRequired` only exists once the check does: a required
 * context that has not reported yet (CI required, created once every other
 * job ended) is invisible there, and "every required check passed" would go
 * out before it ran. The base branch's rules name it in advance.
 */

import { rateLimited, type WatchCheck, type WatchDetail } from './pull-request-watch-read.ts';

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const name = (value: unknown): string => typeof value === 'string' ? value.slice(0, 200) : '';

/** How long the rules of one repository and base are trusted before they are read again. */
export const RULES_TTL_MS = 10 * 60_000;
/** How long a failed read waits before the next one, with what was known before. */
export const RULES_RETRY_MS = 2 * 60_000;

/** The two REST reads: the rulesets that apply to the branch, and its classic protection, readable without admin rights. */
export function requiredPaths(repository: string, base: string): { rules: string; branch: string } {
  const branch = encodeURIComponent(base);
  return { rules: `repos/${repository}/rules/branches/${branch}?per_page=100`, branch: `repos/${repository}/branches/${branch}` };
}

function parse(raw: string): unknown {
  if (raw.length > 4 * 1024 * 1024) throw new Error('GitHub answer exceeds 4 MB');
  return JSON.parse(raw);
}

/** The contexts every `required_status_checks` rule names, across rulesets. */
export function parseRules(raw: string): string[] {
  const rules = parse(raw);
  if (!Array.isArray(rules)) throw new Error('GitHub branch rules must be an array');
  return rules.map(row).filter(rule => rule.type === 'required_status_checks')
    .flatMap(rule => list(row(rule.parameters).required_status_checks).map(check => name(row(check).context)));
}

/** The contexts a classic branch protection requires; none when it is off. */
export function parseProtection(raw: string): string[] {
  const checks = row(row(row(parse(raw)).protection).required_status_checks);
  if (checks.enforcement_level === 'off') return [];
  return [...list(checks.contexts).map(name), ...list(checks.checks).map(check => name(row(check).context))];
}

/** gh's words for a branch or a repository GitHub does not show: nothing is required there. */
const missing = (message: string) => /HTTP 404|Not Found|Branch not found/i.test(message);

/**
 * Marks the checks the base branch requires, and adds each required context
 * that has no check on the head yet as a pending one, as GitHub shows it
 * ("Expected"), except on a draft: it cannot merge, and a repository may keep
 * a required name for its ready run alone, as a draft run that names its
 * planning job apart does. A check run matches by its own name, without its workflow.
 * Once the rules answered they alone decide, so a context they dropped stops
 * counting even on checks read before; until then (`null`) each check's own
 * `isRequired` stands.
 */
export function withRequired(detail: WatchDetail, contexts: string[] | null): WatchDetail {
  if (contexts === null) return detail;
  const wanted = new Set(contexts);
  const checks = detail.checks.map(check => wanted.has(check.job) === check.required ? check : { ...check, required: wanted.has(check.job) });
  const reported = new Set(checks.map(check => check.job));
  const expected = detail.draft ? [] : [...wanted].filter(context => !reported.has(context)).map((context): WatchCheck => ({
    name: context, job: context, status: 'pending', conclusion: 'EXPECTED', required: true, url: '', context: false, workflow: '', started: '', finished: '',
  }));
  return { ...detail, checks: [...checks, ...expected] };
}

type Load = (path: string) => Promise<string>;
type Log = (message: string) => void;

/**
 * The required contexts per repository and base, read again after
 * `RULES_TTL_MS`. A failed read keeps what was known before (null when it
 * never answered), waits `RULES_RETRY_MS` and is logged: the watch goes on
 * with what the checks say of themselves. A rate limit is thrown instead, so
 * the watch pauses every read until it passes.
 */
export class RequiredContexts {
  readonly #held = new Map<string, { contexts: string[] | null; until: number; read: number; reading: Promise<string[] | null> | null }>();
  #reads = 0;

  constructor(private readonly ttlMs = RULES_TTL_MS, private readonly retryMs = RULES_RETRY_MS) {}

  /** Which read answers for `key` while it holds; null once it expired, which asks for another. */
  stamp(key: string): number | null {
    const held = this.#held.get(key);
    return held && Date.now() < held.until ? held.read : null;
  }

  async of(key: string, repository: string, base: string, load: Load, log: Log): Promise<string[] | null> {
    const held = this.#held.get(key) ?? { contexts: null, until: 0, read: 0, reading: null };
    this.#held.set(key, held);
    if (Date.now() < held.until) return held.contexts;
    held.reading ??= this.#read(repository, base, load).then((contexts): string[] | null => {
      held.contexts = contexts;
      held.until = Date.now() + this.ttlMs;
      held.read = ++this.#reads;
      return contexts;
    }, (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (rateLimited(message)) throw error;
      held.until = Date.now() + this.retryMs;
      held.read = ++this.#reads;
      log(`reading the checks ${base} requires: ${message}`);
      return held.contexts;
    }).finally(() => { held.reading = null; });
    return held.reading;
  }

  async #read(repository: string, base: string, load: Load): Promise<string[]> {
    const paths = requiredPaths(repository, base);
    const read = (path: string, parse: (raw: string) => string[]) => load(path).then(parse, (error: unknown) => {
      if (missing(error instanceof Error ? error.message : String(error))) return [];
      throw error;
    });
    const [rules, protection] = await Promise.all([read(paths.rules, parseRules), read(paths.branch, parseProtection)]);
    return [...new Set([...rules, ...protection].filter(Boolean))];
  }
}
