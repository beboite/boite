/*
 * `boite browser run`: many browser steps in one call. What makes a page slow
 * to drive is the model's turn between two commands, not the command itself
 * (about 40 ms): a script runs its clicks, waits and reads back to back, with
 * the loops and conditions a chain of commands cannot hold, and prints only
 * what the agent needs next. It runs in this CLI process with the agent's own
 * rights, like any script the agent could write, and reaches the browser
 * through the same calls as each `boite browser` command.
 */
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { browserActionError, type BrowserAction, type BrowserReply } from '@boite/contracts';
import type { CoreClient } from './client.ts';
import type { CliIo } from './cli.ts';
import { browserAction, browserStep } from './browser-cli.ts';

type ScriptBody = (...values: unknown[]) => Promise<unknown>;
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => ScriptBody;
/** What a script has in scope besides the globals. */
const PARAMS = ['page', 'args', 'console', 'sleep'];

/** A step that failed: the script stops there unless it catches it. */
class StepError extends Error {
  constructor(readonly step: number, readonly label: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

/** A script that stopped: `where` is its step or line, `reason` what went wrong there. */
export class BrowserScriptFailure extends Error {
  constructor(readonly where: string, readonly reason: string) {
    super(`browser run stopped at ${where}`);
  }
}

/** A script to run: its text, the name its errors cite, its own words and the tab it starts on. */
export interface BrowserScript { source: string; name: string; args: string[]; tab?: string }

/** The longest text `page.fetch` returns: the reply crosses one RPC frame. */
const FETCH_TEXT_MAX = 2_000_000;
/** The longest `evaluate` expression the contract accepts, which `page.fetch` sends its request in. */
const FETCH_SEND_MAX = 32_000;
/**
 * Runs in the page, so the request carries the page's cookies and passes its
 * CORS rules as the site's own code does. It reads the body no further than
 * `max`: a large download would otherwise sit whole in the page's memory.
 */
const PAGE_FETCH = `async (url, init, max) => {
  const response = await fetch(url, init);
  const out = { status: response.status, ok: response.ok, url: response.url, headers: Object.fromEntries(response.headers) };
  const reader = response.body ? response.body.getReader() : null;
  const decoder = new TextDecoder();
  let text = '';
  while (reader && text.length <= max) {
    const { done, value } = await reader.read();
    text += decoder.decode(value, { stream: !done });
    if (done) break;
  }
  if (text.length > max) { await reader.cancel().catch(() => {}); return { ...out, text: text.slice(0, max), truncated: true }; }
  if (/json/i.test(response.headers.get('content-type') || '') || /^\\s*[[{]/.test(text)) { try { return { ...out, json: JSON.parse(text) }; } catch {} }
  return { ...out, text };
}`;

const hostOf = (url: string) => { try { return new URL(url).hostname.toLowerCase(); } catch { return null; } };

/** Steps whose reply is data the script reads; the others print what they did when it is more than done. */
const READS = new Set<BrowserAction['kind']>(['snapshot', 'get', 'evaluate', 'status', 'profiles', 'diagnostics', 'downloads', 'screenshot', 'activate']);
const SCROLL: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

/** JSON, which an agent reads best; one line for what the script logs, indented for what it returns. */
function json(value: unknown, indent?: number): string {
  try { return JSON.stringify(value, null, indent) ?? String(value); } catch { return Bun.inspect(value); }
}
const shown = (value: unknown) => typeof value === 'string' ? value : json(value);

interface WaitFor { text?: string; url?: string; fn?: string | (() => unknown); load?: 'domcontentloaded' | 'load' | 'networkidle'; timeout?: number }

function waitAction(what: unknown, timeout: number | undefined): BrowserAction {
  const timeoutMs = timeout === undefined ? {} : { timeoutMs: timeout };
  if (typeof what === 'number') return { kind: 'wait', ms: what };
  if (typeof what === 'string') return { kind: 'wait', selector: what, ...timeoutMs };
  if (what && typeof what === 'object') {
    const { text, url, fn, load, timeout: own } = what as WaitFor;
    return {
      kind: 'wait', ...(text !== undefined ? { text } : {}), ...(url !== undefined ? { url } : {}), ...(load !== undefined ? { load } : {}),
      ...(fn !== undefined ? { fn: typeof fn === 'function' ? `(${fn})()` : String(fn) } : {}),
      ...(own !== undefined ? { timeoutMs: own } : timeoutMs),
    };
  }
  throw new Error('page.wait takes a target, a number of milliseconds or { text, url, fn, load, timeout }');
}

/** The script line an error came from: the function's header lines are counted out. */
async function scriptLine(error: unknown, name: string): Promise<number | null> {
  const line = (stack: unknown) => {
    const found = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+):\\d+`).exec(String(stack ?? ''));
    return found ? Number(found[1]) : null;
  };
  const at = line((error as Error | undefined)?.stack);
  if (at === null) return null;
  let header = 0;
  try { await new AsyncFunction(...PARAMS, `throw new Error()\n//# sourceURL=${name}`)(); }
  catch (probe) { header = (line((probe as Error).stack) ?? 1) - 1; }
  return at - header;
}

/**
 * Takes `--tab <id>` before the first word or right after it, as `run` and
 * `recipe run` accept it; the words after that are the script's own.
 */
export function takeScriptTab(rest: string[], command: string, first: string): { word: string | undefined; tab: string | undefined } {
  let tab: string | undefined;
  const take = () => {
    if (rest[0] !== '--tab') return;
    if (tab !== undefined) throw new Error(`browser ${command} accepts one --tab`);
    tab = rest[1];
    if (!tab) throw new Error(`browser ${command} --tab needs a tab id`);
    rest.splice(0, 2);
  };
  take();
  const word = rest.shift();
  if (word === undefined || word === '') throw new Error(`browser ${command} needs ${first}`);
  take();
  return { word, tab };
}

/** A script file, or stdin for `-`, and the name its errors cite. */
export async function readScript(file: string, io: CliIo, command: string): Promise<{ source: string; name: string }> {
  if (file !== '-') return { source: readFileSync(resolve(io.cwd, file), 'utf8'), name: basename(file) };
  if (!io.stdin) throw new Error(`browser ${command} - reads the script from stdin, which this caller does not provide`);
  return { source: await io.stdin(), name: 'stdin.js' };
}

export async function browserRun(args: string[], io: CliIo, client: CoreClient, threadId: string): Promise<{ lines: string[]; value: unknown }> {
  const rest = [...args];
  const { word: file, tab } = takeScriptTab(rest, 'run', 'a script file, or - to read it from stdin; boite browser help shows what a script can call');
  const { source, name } = await readScript(file!, io, 'run');
  const { lines, value } = await runBrowserScript({ source, name, args: rest, ...(tab ? { tab } : {}) }, io, client, threadId);
  return { lines, value };
}

/**
 * Runs a script's steps against the conversation's browser. Prints what each
 * step did as it goes; `sites` are the hosts it opened, fetched or ended on.
 * A step or a line that fails stops it with a `BrowserScriptFailure`, after
 * printing the page it left.
 */
export async function runBrowserScript(script: BrowserScript, io: CliIo, client: CoreClient, threadId: string): Promise<{ lines: string[]; value: unknown; sites: string[] }> {
  const { source, name, args: rest } = script;
  let current = script.tab;
  const sites = new Set<string>();
  const visit = (url: string) => { const host = hostOf(url); if (host) sites.add(host); };
  let body: ScriptBody;
  try { body = new AsyncFunction(...PARAMS, `${source}\n//# sourceURL=${name}`); }
  catch (error) { throw new Error(`${name} does not parse: ${(error as Error).message}`); }

  let steps = 0;
  /** Runs one action; `tab` aims it at another tab than the run's. */
  const step = async (label: string, build: () => BrowserAction, output?: string, tab = current): Promise<unknown> => {
    const number = ++steps;
    try {
      const action = build();
      const problem = browserActionError(action);
      if (problem) throw new Error(problem);
      const { lines, value } = await browserStep(action, tab, output, io, client, threadId);
      // Both the address asked for and the one reached: a redirect can lead to another site.
      if (action.kind === 'open' || action.kind === 'navigate') { visit(action.url); visit(String((value as BrowserReply).url ?? '')); }
      // A tab the run was aimed at stays its own; a new one it opens becomes the run's.
      const opened = (value as BrowserReply).tabId;
      if (action.kind === 'open' && current !== undefined && opened) current = opened;
      if (!READS.has(action.kind) && !(lines.length === 1 && lines[0] === '✓ Done')) io.out(`> ${label}\n${lines.join('\n')}\n`);
      return value;
    } catch (error) { throw new StepError(number, label, error); }
  };
  const valueOf = async (label: string, build: () => BrowserAction) => ((await step(label, build)) as BrowserReply).value;
  const on = (kind: 'hover' | 'focus' | 'check' | 'uncheck' | 'scrollintoview', word: string = kind) => (selector: string) => valueOf(`${word} ${selector}`, () => ({ kind, selector }));
  const page = {
    open: async (url: string, options: { profile?: string } = {}) => {
      const reply = await step(`open ${url}`, () => ({ kind: 'open', url, reuse: true, ...(options.profile ? { profile: options.profile } : {}) })) as BrowserReply;
      return { tabId: reply.tabId, url: reply.url, title: reply.title };
    },
    goto: (url: string) => valueOf(`goto ${url}`, () => ({ kind: 'navigate', url })),
    snapshot: async (options: { interactive?: boolean; compact?: boolean; depth?: number; selector?: string; urls?: boolean } = {}) => {
      const reply = await step('snapshot', () => ({
        kind: 'snapshot', ...(options.interactive ? { interactive: true } : {}), ...(options.compact ? { compact: true } : {}), ...(options.urls ? { urls: true } : {}),
        ...(options.depth !== undefined ? { depth: options.depth } : {}), ...(options.selector !== undefined ? { selector: options.selector } : {}),
      })) as BrowserReply;
      return (reply.value as { text: string }).text;
    },
    click: (selector: string) => valueOf(`click ${selector}`, () => ({ kind: 'click', selector })),
    dblclick: (selector: string) => valueOf(`dblclick ${selector}`, () => ({ kind: 'click', selector, count: 2 })),
    hover: on('hover'), focus: on('focus'), check: on('check'), uncheck: on('uncheck'), scrollIntoView: on('scrollintoview', 'scrollIntoView'),
    // The label leaves the text out: it can be a password.
    fill: (selector: string, text: string | number) => valueOf(`fill ${selector}`, () => ({ kind: 'fill', selector, text: String(text) })),
    type: (selector: string, text: string | number) => valueOf(`type ${selector}`, () => ({ kind: 'type', selector, text: String(text) })),
    select: (selector: string, ...values: Array<string | string[]>) => valueOf(`select ${selector}`, () => ({ kind: 'select', selector, values: values.flat().map(String) })),
    press: (key: string) => valueOf(`press ${key}`, () => ({ kind: 'press', key })),
    scroll: (direction = 'down', px = 300, options: { selector?: string } = {}) => valueOf(`scroll ${direction}`, () => {
      const [x, y] = SCROLL[direction] ?? (() => { throw new Error('page.scroll takes up, down, left or right'); })();
      return { kind: 'scroll', x: x * px, y: y * px, ...(options.selector ? { selector: options.selector } : {}) };
    }),
    wait: (what: string | number | WaitFor, options: { timeout?: number } = {}) =>
      valueOf(`wait ${typeof what === 'object' ? JSON.stringify(what, (_key, value) => typeof value === 'function' ? 'function' : value) : what}`, () => waitAction(what, options.timeout)),
    get: (what: string, selector?: string, name?: string) => valueOf(`get ${what}${selector === undefined ? '' : ` ${selector}`}`,
      () => ({ kind: 'get', what: what as 'text', ...(selector !== undefined ? { selector } : {}), ...(name !== undefined ? { name } : {}) })),
    is: (what: 'visible' | 'enabled' | 'checked', selector: string) => valueOf(`is ${what} ${selector}`, () => ({ kind: 'get', what, selector })),
    eval: (code: string | ((...values: never[]) => unknown), ...values: unknown[]) =>
      valueOf('eval', () => ({ kind: 'evaluate', expression: typeof code === 'function' ? `(${code})(...${JSON.stringify(values)})` : String(code) })),
    back: () => valueOf('back', () => ({ kind: 'history', direction: 'back' })),
    forward: () => valueOf('forward', () => ({ kind: 'history', direction: 'forward' })),
    reload: () => valueOf('reload', () => ({ kind: 'history', direction: 'reload' })),
    screenshot: async (path?: string) => ((await step('screenshot', () => ({ kind: 'screenshot' }), path)) as { path: string }).path,
    dialog: (decision: 'accept' | 'dismiss', text?: string) => valueOf(`dialog ${decision}`, () => ({ kind: 'dialog', decision, ...(text !== undefined ? { text } : {}) })),
    tabs: async () => ((await valueOf('tabs', () => ({ kind: 'status' }))) as { tabs: unknown[] }).tabs,
    tab: async (id: string) => { await step(`tab ${id}`, () => ({ kind: 'activate' }), undefined, id); current = id; },
    /** A request sent from the page; the label leaves the body and the query out: they can hold a password or a token. */
    fetch: async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; credentials?: 'omit' | 'same-origin' | 'include' } = {}) => {
      const method = (init.method ?? 'GET').toUpperCase();
      const label = `fetch ${method} ${String(url).split(/[?#]/)[0]}`;
      const reply = await valueOf(label, () => {
        if (init.body !== undefined && typeof init.body !== 'string') throw new Error('page.fetch takes a string body: JSON.stringify(value) for JSON');
        const expression = `(${PAGE_FETCH})(${JSON.stringify(String(url))}, ${JSON.stringify(init)}, ${FETCH_TEXT_MAX})`;
        // The request travels as one page expression, under the same cap as page.eval.
        if (expression.length > FETCH_SEND_MAX) throw new Error(`page.fetch sends at most ${FETCH_SEND_MAX} characters of address, headers and body, this one ${expression.length}: build a longer body in the page and send it from page.eval`);
        return { kind: 'evaluate', expression };
      }) as { status: number; ok: boolean; url: string; json?: unknown; text?: string };
      if (reply && typeof reply.url === 'string') visit(reply.url);
      if (!reply || reply.status >= 400) {
        const said = reply?.text ?? (reply?.json === undefined ? '' : JSON.stringify(reply.json));
        throw new StepError(steps, label, new Error(`HTTP ${reply?.status ?? '?'}${said ? `: ${said.slice(0, 300)}` : ''}`));
      }
      return reply;
    },
    /** Any other command, in the words of `boite browser`; it returns what that command prints with --json. */
    command: async (...words: Array<string | number>) => {
      const typed = words.map(String);
      // The command and its target: a text typed after them can be a password.
      const label = typed.slice(0, 2).join(' ');
      let parsed: ReturnType<typeof browserAction>;
      try { parsed = browserAction(typed); } catch (error) { throw new StepError(++steps, label, error); }
      return step(label, () => parsed.action, parsed.output, parsed.tabId ?? current);
    },
  };
  const scriptConsole = {
    log: (...values: unknown[]) => io.out(`${values.map(shown).join(' ')}\n`),
    info: (...values: unknown[]) => io.out(`${values.map(shown).join(' ')}\n`),
    warn: (...values: unknown[]) => io.err(`${values.map(shown).join(' ')}\n`),
    error: (...values: unknown[]) => io.err(`${values.map(shown).join(' ')}\n`),
  };
  const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

  let result: unknown;
  try { result = await body(page, rest, scriptConsole, sleep); }
  catch (error) {
    const line = error instanceof StepError ? null : await scriptLine(error, name);
    const where = error instanceof StepError ? `step ${error.step}, ${error.label}` : line === null ? name : `${name} line ${line}`;
    const reason = error instanceof Error ? error.message : String(error);
    io.out(`✗ ${where}: ${reason}\n`);
    // Where the page stopped, so the next call starts from it rather than from another snapshot.
    const now = await client.call('browser.command', { threadId, ...(current ? { tabId: current } : {}), action: { kind: 'snapshot', interactive: true } }).catch(() => null);
    const shot = now?.value as { text?: string; url?: string; title?: string } | undefined;
    if (shot?.text !== undefined) io.out(`page now: ${shot.title || '(untitled)'}  ${shot.url ?? ''}\n${shot.text}\n`);
    throw new BrowserScriptFailure(where, reason);
  }
  if (result !== undefined) return { lines: [typeof result === 'string' ? result : json(result, 2)], value: { steps, result }, sites: [...sites] };
  const status = await client.call('browser.command', { threadId, action: { kind: 'status' } }).catch(() => null);
  const tabs = (status?.value as { tabs?: Array<{ tabId: string; url: string; title: string; active: boolean }> } | undefined)?.tabs ?? [];
  const tab = tabs.find(one => current ? one.tabId === current : one.active);
  return { lines: [`✓ ${steps} ${steps === 1 ? 'step' : 'steps'}${tab ? `; the page is ${tab.title || '(untitled)'}  ${tab.url}` : ''}`], value: { steps }, sites: [...sites] };
}
