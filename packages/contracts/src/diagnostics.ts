/**
 * Diagnostic logs shared by the core, the shell, the clients and the CLI.
 *
 * The local files keep redacted text: credentials and recognized sensitive
 * fields are removed when a record is written. Anything that leaves the
 * owner's machine or reaches an agent (an export, an issue, an agent read)
 * also goes through `createLogAnonymizer`, which replaces paths, names,
 * addresses and private hosts with stable placeholders. Thread, turn and run
 * ids stay, so one conversation can be followed across the whole timeline.
 */

type ThreadId = string;
type TurnId = string;
type Timestamp = number;

export type CoreLogLevel = 'debug' | 'info' | 'warn' | 'error';
export const LOG_LEVELS: readonly CoreLogLevel[] = ['debug', 'info', 'warn', 'error'];
const LEVEL_RANK: Record<CoreLogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
export function logLevelAtLeast(level: CoreLogLevel, minimum: CoreLogLevel): boolean { return LEVEL_RANK[level] >= LEVEL_RANK[minimum]; }

/** Which process wrote a record. Absent on records written before origins existed: the core. */
export type LogOrigin = 'core' | 'shell' | 'ui';
export const LOG_ORIGINS: readonly LogOrigin[] = ['core', 'shell', 'ui'];

/** Scalar facts beside a message. Never a payload, a transcript, a prompt, a command line or file content. */
export type LogData = Record<string, string | number | boolean | null>;
export const LOG_DATA_KEYS = 16;
export const LOG_DATA_KEY_CHARS = 40;
export const LOG_DATA_VALUE_CHARS = 300;
export const LOG_MESSAGE_CHARS = 4096;
export const LOG_CONTEXT_CHARS = 200;

/** Raw provider output reaches only owner live observers; diagnostic history retains a placeholder. */
export interface CoreLogContext {
  source?: string;
  event?: string;
  threadId?: ThreadId;
  turnId?: TurnId;
  requestId?: string;
  kind?: 'provider-output';
  durationMs?: number;
  data?: LogData;
}

/** A bounded diagnostic, with no transcript, RPC payload or process arguments. */
export interface CoreLogRecord {
  id: string;
  runId: string;
  at: Timestamp;
  level: CoreLogLevel;
  /** Absent means `core`. */
  origin?: LogOrigin;
  source: string;
  event: string;
  message: string;
  threadId?: ThreadId;
  turnId?: TurnId;
  requestId?: string;
  /** The thread's agent when the record was written, so each line says who it is about. */
  providerId?: string;
  model?: string;
  parentThreadId?: ThreadId;
  durationMs?: number;
  data?: LogData;
}

export interface CoreLogsQuery {
  /** Defaults to 100; an integer from 1 to 1000. Results are newest first. */
  limit?: number;
  threadId?: ThreadId;
  turnId?: TurnId;
  /** Exactly this level. */
  level?: CoreLogLevel;
  /** This level and the ones above it. */
  minLevel?: CoreLogLevel;
  origin?: LogOrigin;
  source?: string;
  since?: Timestamp;
  until?: Timestamp;
  /** Case-insensitive text in the message, source, event or data values. */
  search?: string;
  /** Replace paths, names and addresses as an export would. */
  anonymize?: boolean;
}

const QUERY_KEYS = ['limit', 'threadId', 'turnId', 'level', 'minLevel', 'origin', 'source', 'since', 'until', 'search', 'anonymize'] as const;

function plainText(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${field}: expected 1 to ${max} characters without control characters`);
  return value;
}

function timestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${field}: expected a Unix time in milliseconds`);
  return value;
}

function level(value: unknown, field: string): CoreLogLevel {
  if (!LOG_LEVELS.includes(value as CoreLogLevel)) throw new Error(`${field}: expected debug, info, warn or error`);
  return value as CoreLogLevel;
}

/** Real and in-memory cores share the same strict diagnostic query boundary. */
export function validateCoreLogsQuery(raw: unknown, maxLimit = 1000): CoreLogsQuery & { limit: number } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('core.logs params: expected an object');
  const query = raw as Record<string, unknown>;
  for (const key of Object.keys(query)) if (!(QUERY_KEYS as readonly string[]).includes(key)) throw new Error(`core.logs ${key}: expected one of ${QUERY_KEYS.join(', ')}`);
  const limit = query.limit === undefined ? 100 : query.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > maxLimit) throw new Error(`core.logs limit: expected an integer from 1 to ${maxLimit}`);
  const result: CoreLogsQuery & { limit: number } = { limit };
  if (query.threadId !== undefined) result.threadId = plainText(query.threadId, 'core.logs threadId');
  if (query.turnId !== undefined) result.turnId = plainText(query.turnId, 'core.logs turnId');
  if (query.level !== undefined) result.level = level(query.level, 'core.logs level');
  if (query.minLevel !== undefined) result.minLevel = level(query.minLevel, 'core.logs minLevel');
  if (query.origin !== undefined) {
    if (!LOG_ORIGINS.includes(query.origin as LogOrigin)) throw new Error('core.logs origin: expected core, shell or ui');
    result.origin = query.origin as LogOrigin;
  }
  if (query.source !== undefined) result.source = plainText(query.source, 'core.logs source');
  if (query.since !== undefined) result.since = timestamp(query.since, 'core.logs since');
  if (query.until !== undefined) result.until = timestamp(query.until, 'core.logs until');
  if (query.search !== undefined) result.search = plainText(query.search, 'core.logs search');
  if (query.anonymize !== undefined) {
    if (typeof query.anonymize !== 'boolean') throw new Error('core.logs anonymize: expected true or false');
    result.anonymize = query.anonymize;
  }
  return result;
}

/** Whether a record answers a query's filters; the limit is the caller's. */
export function logMatches(record: CoreLogRecord, query: Omit<CoreLogsQuery, 'limit' | 'anonymize'>): boolean {
  if (query.threadId !== undefined && record.threadId !== query.threadId) return false;
  if (query.turnId !== undefined && record.turnId !== query.turnId) return false;
  if (query.level !== undefined && record.level !== query.level) return false;
  if (query.minLevel !== undefined && !logLevelAtLeast(record.level, query.minLevel)) return false;
  if (query.origin !== undefined && (record.origin ?? 'core') !== query.origin) return false;
  if (query.source !== undefined && record.source !== query.source) return false;
  if (query.since !== undefined && record.at < query.since) return false;
  if (query.until !== undefined && record.at > query.until) return false;
  if (query.search !== undefined) {
    const needle = query.search.toLowerCase();
    const values = [record.message, record.source, record.event, record.providerId ?? '', record.model ?? '', ...Object.values(record.data ?? {}).map(String)];
    if (!values.some(value => value.toLowerCase().includes(needle))) return false;
  }
  return true;
}

/** Owner-only live provider output keeps sign-in URLs usable. Never persist this text. */
export function normalizeCoreLogOutput(text: string, secrets: readonly string[] = []): string {
  let value = text;
  for (const secret of secrets) if (secret.length > 0) value = value.split(secret).join('[redacted]');
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, LOG_MESSAGE_CHARS);
}

/** Redact before bounding: cutting an Authorization value first could leave a secret prefix. */
export function normalizeCoreLogText(text: string, secrets: readonly string[] = []): string {
  const REDACTED = '[redacted]';
  let value = text;
  for (const secret of secrets) if (secret.length > 0) value = value.split(secret).join(REDACTED);
  value = value
    .replace(/((?:^|[^\w-])["']?[\w-]*(?:token|grant|secret|password|api[_-]?key|prompts?|attachments?|commandLine|arguments|params|content|messages|text|input|output)["']?\s*[:=]\s*)[\[{](?!redacted\])[\s\S]*/gi, `$1${REDACTED}`)
    .replace(/\b(?:Authorization\s*[:=]\s*)?(?:Bearer|Basic)\s+[^\s,;"'<>]+/gi, REDACTED)
    .replace(/\bAuthorization\s*[:=]\s*[^\r\n]+/gi, `Authorization: ${REDACTED}`)
    .replace(/((?:^|[^\w-])["']?[\w-]*(?:token|grant|secret|password|api[_-]?key|prompt|attachments?|commandLine|arguments|params|content|messages|text|input|output)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}]+)/gi, `$1${REDACTED}`)
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{8,}|(?:ghp|gho|ghu|ghs|github_pat)_[a-zA-Z0-9_]{8,}|xox[abprs]-[a-zA-Z0-9-]{8,}|AKIA[0-9A-Z]{16}|eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})/g, REDACTED)
    .replace(/(^|[^a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s<>"']+)/gi, (_match, prefix: string, raw: string) => prefix + raw
      .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, `$1${REDACTED}@`)
      // All query values and fragments are untrusted, including unfamiliar keys.
      .replace(/[?#].*$/, `?${REDACTED}`));
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, LOG_MESSAGE_CHARS);
}

/**
 * Bounds and redacts `data`: scalar values only, at most 16 keys of
 * `[A-Za-z0-9_.-]`, strings redacted and cut to 300 characters. Returns
 * undefined when nothing remains.
 */
export function normalizeLogData(raw: unknown, secrets: readonly string[] = []): LogData | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const data: LogData = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= LOG_DATA_KEYS) break;
    if (key.length < 1 || key.length > LOG_DATA_KEY_CHARS || !/^[A-Za-z0-9_.-]+$/.test(key)) continue;
    if (/token|secret|password|api[_-]?key|authorization|cookie|prompt|content|commandline|arguments|env/i.test(key)) continue;
    if (typeof value === 'string') data[key] = normalizeCoreLogText(value, secrets).replace(/[\r\n\t]/g, ' ').slice(0, LOG_DATA_VALUE_CHARS);
    else if (typeof value === 'number') { if (!Number.isFinite(value)) continue; data[key] = value; }
    else if (typeof value === 'boolean' || value === null) data[key] = value;
    else continue;
    count += 1;
  }
  return count === 0 ? undefined : data;
}

/**
 * `data` keys holding an agent's own output, such as the end of its stderr
 * when it failed. That text can echo a prompt, so it stays in the owner's
 * local files and every anonymized view (export, issue, agent read) drops it.
 */
export const PROVIDER_OUTPUT_KEYS: ReadonlySet<string> = new Set(['stderrTail', 'providerOutput']);
export const PROVIDER_OUTPUT_KEPT = '[agent output kept on this machine]';

/** What makes the text of one machine personal. Every field is optional. */
export interface LogAnonymizeContext {
  /** Per-installation random value: the same path gets the same placeholder in every export of this machine. */
  salt: string;
  home?: string | null;
  user?: string | null;
  hostname?: string | null;
  dataDir?: string | null;
  projects?: readonly { path: string; name: string }[];
  /** Other personal strings, such as account labels. */
  extra?: readonly string[];
}

/** Hosts whose names and paths say which service failed and nothing about the user. */
const PUBLIC_HOSTS = [
  'anthropic.com', 'claude.ai', 'claude.com', 'openai.com', 'chatgpt.com', 'x.ai', 'grok.com', 'googleapis.com', 'google.com', 'gstatic.com',
  'github.com', 'githubusercontent.com', 'githubassets.com', 'npmjs.org', 'npmjs.com', 'bun.sh', 'nodejs.org', 'posthog.com', 'cloudflare.com',
  'microsoft.com', 'microsoftonline.com', 'windows.net', 'windowsupdate.com', 'apple.com', 'mozilla.org', 'opencode.ai', 'deepseek.com', 'mistral.ai',
  'openrouter.ai', 'tauri.app', 'rust-lang.org', 'crates.io', 'pypi.org', 'python.org', 'sentry.io', 'tailscale.com', 'astral.sh', 'docker.com', 'docker.io',
];
/** Words a project, account or machine name may share with Boite's own vocabulary. */
const COMMON_WORDS = new Set(['boite', 'brain', 'app', 'apps', 'web', 'test', 'tests', 'core', 'server', 'client', 'shell', 'main', 'demo', 'docs', 'home', 'user', 'users', 'root', 'admin', 'dev', 'src', 'data', 'code', 'work', 'project', 'projects', 'default', 'public', 'local', 'localhost', 'claude', 'codex', 'agent', 'agents', 'thread', 'threads', 'turn', 'turns', 'window', 'windows', 'linux']);

/** FNV-1a, 32 bits: sync, the same in the core and the browser, short enough to read. */
function shortHash(salt: string, value: string): string {
  let hash = 0x811c9dc5;
  const text = `${salt}\u0000${value}`;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** A path's separators, any run of `/` or `\\` (JSON escapes included), and no trailing one. */
function pathKey(path: string): string { return withoutTrailing(path.replace(/[\\/]+/g, '/'), '/').toLowerCase(); }

/**
 * `value` without its trailing run of these characters. A loop, not `/x+$/`:
 * an end-anchored repetition retries from every position of a long run.
 */
function withoutTrailing(value: string, characters: string): string {
  let end = value.length;
  while (end > 0 && characters.includes(value[end - 1]!)) end -= 1;
  return value.slice(0, end);
}

/** The body of a path pattern, either separator between segments; null for a path too short to be personal. */
function pathBody(path: string): string | null {
  const parts = withoutTrailing(path, '\\/').split(/[\\/]+/).filter((part, index) => part.length > 0 || index === 0);
  if (parts.join('').length < 3) return null;
  return parts.map(escapeRegExp).join('[\\\\/]+');
}

/**
 * One regex for many alternatives, longest first so the most specific wins,
 * and the placeholder looked up from what matched: hundreds of projects and
 * worktrees cost one pass over a record, not hundreds.
 */
function combined(entries: readonly { body: string; key: string; value: string }[], tail: string, key: (match: string) => string, head = '()'): ((text: string) => string) | null {
  if (entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => b.body.length - a.body.length);
  const values = new Map<string, string>();
  for (const entry of sorted) if (!values.has(entry.key)) values.set(entry.key, entry.value);
  // `head` is one capturing group put back as it was: the clients' Safari floor has no lookbehind.
  const pattern = new RegExp(`${head}(${sorted.map(entry => entry.body).join('|')})${tail}`, 'gi');
  return text => text.replace(pattern, (match, before: string, body: string) => { const value = values.get(key(body)); return value === undefined ? match : before + value; });
}

const PATH_END = '(?=$|[\\\\/\\s"\'`:;,)\\]}>]|\\.(?![\\w-]))';

/** Anything shaped like an absolute path; a drive letter only when no letter precedes it (`file:///` is not drive `e:`). */
// Separator runs are bounded: an unbounded `[\\/]+` inside the repetition retries from every slash of a long run.
const PATH_TOKEN = /([A-Za-z]:)?((?:[\\/]{1,4}[^\\/\s"'`;,()[\]{}<>|*?]+)+[\\/]{0,4})/g;

/**
 * Paths without spaces, replaced by their longest known prefix: each path in
 * a record is split at its separators and looked up in a map, so a thousand
 * projects cost a few lookups per path instead of a thousand-way regex.
 */
function prefixReplacer(prefixes: ReadonlyMap<string, string>): ((text: string) => string) | null {
  if (prefixes.size === 0) return null;
  // No known path has more separators than this, so a deeper prefix cannot match.
  let depth = 0;
  for (const key of prefixes.keys()) depth = Math.max(depth, key.split('/').length);
  return text => text.replace(PATH_TOKEN, (match: string, drive: string | undefined, rest: string, offset: number, whole: string) => {
    // A drive letter right after another letter is a scheme's end (`file:///`), not a drive.
    const scheme = drive !== undefined && offset > 0 && /[A-Za-z]/.test(whole[offset - 1]!);
    // After a scheme, the extra slashes of `///` stay: the placeholder stands for the path's own first one.
    const lead = scheme ? (/^[\\/]+/.exec(rest)?.[0] ?? '').slice(1) : '';
    const kept = scheme ? drive + lead : '';
    const token = scheme ? rest.slice(lead.length) : match;
    const path = withoutTrailing(token, '.');
    const trailing = token.slice(path.length);
    const ends: number[] = [];
    const separators = /[\\/]+/g;
    let found: RegExpExecArray | null;
    while ((found = separators.exec(path)) !== null) if (found.index > 0) ends.push(found.index);
    ends.push(path.length);
    for (let index = Math.min(ends.length - 1, depth); index >= 0; index -= 1) {
      const value = prefixes.get(pathKey(path.slice(0, ends[index]!)));
      if (value !== undefined) return kept + value + path.slice(ends[index]!) + trailing;
    }
    return match;
  });
}

function wordUsable(word: string): boolean { return word.length >= 3 && !COMMON_WORDS.has(word.toLowerCase()); }

function publicHost(host: string): boolean {
  const name = host.toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '0.0.0.0' || name.startsWith('127.')) return true;
  return PUBLIC_HOSTS.some(suffix => name === suffix || name.endsWith(`.${suffix}`));
}

function privateIpv4(ip: string): boolean {
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet > 255)) return false;
  if (octets[0] === 127 || ip === '0.0.0.0' || ip === '255.255.255.255') return false;
  return true;
}

export type LogAnonymizer = {
  text(value: string): string;
  record(record: CoreLogRecord): CoreLogRecord;
  /** The placeholder a project gets, for summaries that name projects. */
  project(path: string | null | undefined): string;
};

/**
 * Builds the replacements once per export or read. The most specific path
 * wins, so a project inside the home becomes a project placeholder rather
 * than `~/...`; names come after paths, addresses after names.
 */
export function createLogAnonymizer(context: LogAnonymizeContext): LogAnonymizer {
  const projectNames = new Map<string, string>();
  const projects = (context.projects ?? []).filter(project => project.path.length > 0);
  const projectLabel = (path: string): string => `<project:${shortHash(context.salt, pathKey(path))}>`;
  // A path with a space cannot be told apart from the words around it by shape: those few go through one regex.
  const paths: { body: string; key: string; value: string }[] = [];
  const prefixes = new Map<string, string>();
  const addPath = (path: string, value: string): void => {
    const body = pathBody(path);
    if (body === null) return;
    const key = pathKey(path);
    if (/\s/.test(path)) paths.push({ body, key, value });
    else if (!prefixes.has(key)) prefixes.set(key, value);
  };
  for (const project of projects) { addPath(project.path, projectLabel(project.path)); projectNames.set(project.path, projectLabel(project.path)); }
  if (context.dataDir) addPath(context.dataDir, '<data>');
  if (context.home) addPath(context.home, '~');
  // A name only after every path: `C:\Users\meetsu\x` is a path first.
  const words: { body: string; key: string; value: string }[] = [];
  const addWord = (word: string, value: string): void => { if (wordUsable(word)) words.push({ body: escapeRegExp(word), key: word.toLowerCase(), value }); };
  for (const project of projects) addWord(project.name, projectLabel(project.path));
  if (context.user) addWord(context.user, '<user>');
  if (context.hostname) for (const name of new Set([context.hostname, context.hostname.split('.')[0] ?? context.hostname])) addWord(name, '<host>');
  const extras: { body: string; key: string; value: string }[] = [];
  for (const extra of context.extra ?? []) if (wordUsable(extra)) extras.push({ body: escapeRegExp(extra), key: extra.toLowerCase(), value: `<private:${shortHash(context.salt, extra.toLowerCase())}>` });
  const replaceSpaced = combined(paths, PATH_END, pathKey);
  const replacePrefixes = prefixReplacer(prefixes);
  const replacePaths = (raw: string): string => {
    const spaced = replaceSpaced ? replaceSpaced(raw) : raw;
    return replacePrefixes && /[\\/]/.test(spaced) ? replacePrefixes(spaced) : spaced;
  };
  const replaceWords = combined(words, '(?![\\w-])', match => match.toLowerCase(), '(^|[^\\w.-])');
  const replaceExtras = combined(extras, '', match => match.toLowerCase());

  const text = (raw: string): string => {
    let value = replacePaths(raw);
    // Other accounts' homes and profiles.
    value = value
      .replace(/([a-z]:[\\/]+Users[\\/]+)(?!Public\b|Default\b|<)[^\\/\s"'<>:]+/gi, '$1<user>')
      .replace(/(\/(?:home|Users)\/)(?!<)[^/\s"'<>:]+/g, '$1<user>');
    value = value.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '<email>');
    value = value.replace(/\b([a-z][a-z0-9+.-]*:\/\/)(\[[0-9a-f:]+\]|[^\s/?#<>"':]+)(:\d+)?(\/[^\s<>"']*)?/gi, (match, scheme: string, host: string, port: string | undefined, path: string | undefined) => {
      if (publicHost(host)) {
        if (!/github(?:usercontent)?\.com$/i.test(host) || !path) return match;
        // A repository path names its owner; Boite's own stays readable.
        const segments = path.split('/');
        return scheme + host + (port ?? '') + segments.map((segment, index) => (index === 1 || index === 2) && segment.length > 0 && !/^(?:beboite|boite|\[redacted\])$/i.test(segment) && !/^(?:repos|orgs|users|api|v\d)$/i.test(segment) ? `<${index === 1 ? 'owner' : 'repo'}:${shortHash(context.salt, segment.toLowerCase())}>` : segment).join('/');
      }
      return `${scheme}<host:${shortHash(context.salt, host.toLowerCase())}>${port ?? ''}${path && path !== '/' ? '/<path>' : (path ?? '')}`;
    });
    value = value.replace(/(^|[^\w.])(\d{1,3}(?:\.\d{1,3}){3})(?![\w.])/g, (match, before: string, ip: string) => privateIpv4(ip) ? `${before}<ip>` : match);
    value = value.replace(/\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi, '<mac>');
    // An IPv6 address has `::` or seven colons; a time such as 14:03:22 has neither.
    value = value.replace(/(^|[^\w:.<])([0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7})(?![\w:])/gi, (match, before: string, address: string) => {
      const groups = address.split(':');
      if (address === '::1' || address === '::' || groups.some(group => group.length > 4)) return match;
      return (address.includes('::') && /[0-9a-f]/i.test(address)) || groups.length === 8 ? `${before}<ip6>` : match;
    });
    if (replaceWords) value = replaceWords(value);
    if (replaceExtras) value = replaceExtras(value);
    return value;
  };

  return {
    text,
    project: path => (path ? projectNames.get(path) ?? projectLabel(path) : '<none>'),
    record: record => {
      const copy: CoreLogRecord = { ...record, message: text(record.message) };
      if (record.data) copy.data = Object.fromEntries(Object.entries(record.data).map(([key, value]) => [key, PROVIDER_OUTPUT_KEYS.has(key) ? PROVIDER_OUTPUT_KEPT : typeof value === 'string' ? text(value) : value]));
      if (record.model) copy.model = text(record.model);
      return copy;
    },
  };
}

function pad(value: number, width = 2): string { return String(value).padStart(width, '0'); }

/** `2026-10-10 14:03:22.120Z`: sortable, one width, UTC so two machines' logs line up. */
export function formatLogTime(at: number): string {
  const date = new Date(at);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}Z`;
}

export function formatLogDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/**
 * One record on one line, readable without a viewer:
 * `2026-10-10 14:03:22.120Z ERROR shell  watchdog/shell.main-thread.blocked [thr_x claude/opus <thr_parent] (6.2 s) The main thread ... {command=notify}`
 */
export function formatLogLine(record: CoreLogRecord): string {
  const who = record.threadId === undefined ? '' : ` [${record.threadId}${record.providerId ? ` ${record.providerId}${record.model ? `/${record.model}` : ''}` : ''}${record.parentThreadId ? ` <${record.parentThreadId}` : ''}${record.turnId ? ` turn=${record.turnId}` : ''}]`;
  const request = record.requestId === undefined ? '' : ` request=${record.requestId}`;
  const duration = record.durationMs === undefined ? '' : ` (${formatLogDuration(record.durationMs)})`;
  const data = record.data && Object.keys(record.data).length > 0 ? ` {${Object.entries(record.data).map(([key, value]) => `${key}=${typeof value === 'string' && /[\s,{}=]/.test(value) ? JSON.stringify(value) : String(value)}`).join(', ')}}` : '';
  return `${formatLogTime(record.at)} ${record.level.toUpperCase().padEnd(5)} ${(record.origin ?? 'core').padEnd(5)} ${record.source}/${record.event}${who}${request}${duration} ${record.message.replace(/[\r\n]+/g, ' ')}${data}`;
}

/** Validates one stored line written by any origin, or returns null. */
export function parseLogRecord(line: string, fallbackOrigin: LogOrigin = 'core'): CoreLogRecord | null {
  if (line.length === 0) return null;
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.runId !== 'string' || typeof raw.at !== 'number' || !Number.isFinite(raw.at)
    || !LOG_LEVELS.includes(raw.level as CoreLogLevel) || typeof raw.message !== 'string' || typeof raw.source !== 'string' || typeof raw.event !== 'string') return null;
  const bounded = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, LOG_CONTEXT_CHARS) : undefined;
  const record: CoreLogRecord = {
    id: raw.id.slice(0, LOG_CONTEXT_CHARS), runId: raw.runId.slice(0, LOG_CONTEXT_CHARS), at: raw.at, level: raw.level as CoreLogLevel,
    origin: LOG_ORIGINS.includes(raw.origin as LogOrigin) ? raw.origin as LogOrigin : fallbackOrigin,
    source: bounded(raw.source) ?? 'core', event: bounded(raw.event) ?? 'core.log', message: raw.message.slice(0, LOG_MESSAGE_CHARS),
  };
  for (const key of ['threadId', 'turnId', 'requestId', 'providerId', 'model', 'parentThreadId'] as const) { const value = bounded(raw[key]); if (value !== undefined) record[key] = value; }
  if (typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs) && raw.durationMs >= 0) record.durationMs = raw.durationMs;
  const data = normalizeLogData(raw.data);
  if (data) record.data = data;
  return record;
}

/** What a read covers. An agent never reaches another conversation's records, whatever it asks. */
export interface DiagnosticsLogsQuery {
  /** An agent names its own thread; the owner may name any thread or none. */
  threadId?: ThreadId;
  /**
   * `app` (default): the records about no thread plus, for an agent, its own
   * thread and the threads it started, for the owner every thread. `thread`:
   * only the thread and its delegated children.
   */
  scope?: 'thread' | 'app';
  /** 1 to 500, default 100. */
  limit?: number;
  minLevel?: CoreLogLevel;
  origin?: LogOrigin;
  since?: Timestamp;
  search?: string;
}

export function validateDiagnosticsLogsQuery(raw: unknown): DiagnosticsLogsQuery & { limit: number; scope: 'thread' | 'app' } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('diagnostics.logs params: expected an object');
  const query = raw as Record<string, unknown>;
  const keys = ['threadId', 'scope', 'limit', 'minLevel', 'origin', 'since', 'search'];
  for (const key of Object.keys(query)) if (!keys.includes(key)) throw new Error(`diagnostics.logs ${key}: expected one of ${keys.join(', ')}`);
  const limit = query.limit === undefined ? 100 : query.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('diagnostics.logs limit: expected an integer from 1 to 500');
  const scope = query.scope === undefined ? 'app' : query.scope;
  if (scope !== 'thread' && scope !== 'app') throw new Error('diagnostics.logs scope: expected thread or app');
  const result: DiagnosticsLogsQuery & { limit: number; scope: 'thread' | 'app' } = { limit, scope };
  if (query.threadId !== undefined) result.threadId = plainText(query.threadId, 'diagnostics.logs threadId');
  if (scope === 'thread' && result.threadId === undefined) throw new Error('diagnostics.logs scope thread: expected a threadId');
  if (query.minLevel !== undefined) result.minLevel = level(query.minLevel, 'diagnostics.logs minLevel');
  if (query.origin !== undefined) {
    if (!LOG_ORIGINS.includes(query.origin as LogOrigin)) throw new Error('diagnostics.logs origin: expected core, shell or ui');
    result.origin = query.origin as LogOrigin;
  }
  if (query.since !== undefined) result.since = timestamp(query.since, 'diagnostics.logs since');
  if (query.search !== undefined) result.search = plainText(query.search, 'diagnostics.logs search');
  return result;
}

/** One kind of problem seen lately, grouped by event so a flood reads as one line. */
export interface DiagnosticProblem {
  origin: LogOrigin;
  source: string;
  event: string;
  level: 'warn' | 'error';
  count: number;
  firstAt: Timestamp;
  lastAt: Timestamp;
  /** The latest occurrence's message, anonymized. */
  message: string;
  /** Up to five threads it touched. */
  threadIds: ThreadId[];
}

/** One conversation as an export lists it, so each id in the timeline has a face. */
export interface DiagnosticThread {
  threadId: ThreadId;
  providerId: string;
  model: string | null;
  effort: string | null;
  status: string;
  parentThreadId: ThreadId | null;
  project: string;
  archived: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** Records at warn and error in the exported window. */
  warnings: number;
  errors: number;
  lastError: string | null;
}

export interface DiagnosticEnvironment {
  version: string;
  channel: string;
  bundleHash: string | null;
  platform: string;
  osRelease: string;
  osVersion: string | null;
  arch: string;
  cpus: number;
  memoryMb: number;
  freeMemoryMb: number;
  runtime: string;
  pid: number;
  startedAt: Timestamp;
  uptimeMs: number;
  /** Whether processes are traced exactly (Windows) or as direct children. */
  trace: string;
  providers: { id: string; version: string | null; state: string }[];
  /** The settings that change behaviour, without any address, path or credential. */
  settings: LogData;
}

export interface DiagnosticSummary {
  generatedAt: Timestamp;
  environment: DiagnosticEnvironment;
  problems: DiagnosticProblem[];
  threads: DiagnosticThread[];
  logFiles: { name: string; bytes: number }[];
  /** Records counted in the summarized window, by level. */
  counts: Record<CoreLogLevel, number>;
  since: Timestamp;
}

export interface DiagnosticsExportParams {
  /** An agent names its own thread; the owner may omit it. */
  threadId?: ThreadId;
  /** Default: the last 24 hours. */
  since?: Timestamp;
  /** Only this thread and its children, plus app records. */
  focusThreadId?: ThreadId;
  /** At most 20000, default 20000. */
  limit?: number;
}

export interface DiagnosticsExport {
  /** `boite-diagnostics-<yyyymmdd-hhmmss>.txt`. */
  name: string;
  /** Where the core saved it, or null when it could not. */
  path: string | null;
  bytes: number;
  records: number;
  text: string;
  summary: DiagnosticSummary;
}

export const ISSUE_REPOSITORY = 'beboite/boite';

export interface DiagnosticsIssueParams {
  threadId?: ThreadId;
  /** 4 to 200 characters. */
  title: string;
  /** What the user saw and did, 1 to 20000 characters. */
  description: string;
  /** Default true: environment, problems and a log excerpt go in the body. */
  includeLogs?: boolean;
  /** Default false: return the draft only. True creates it with the user's `gh` login. */
  submit?: boolean;
}

export interface DiagnosticsIssue {
  repository: string;
  title: string;
  body: string;
  /** The issue `gh` created, when `submit` was true and it worked. */
  url: string | null;
  /** A `github.com/.../issues/new` link with a shorter body, for a browser where the user is signed in. */
  prefillUrl: string;
  /** `ready` when `gh` is installed and signed in. */
  gh: 'ready' | 'missing' | 'unauthenticated';
  /** Why `gh` could not create it, when it tried. */
  error: string | null;
  /** The full anonymized export to drag into the issue, when one was saved. */
  exportPath: string | null;
}

/** What a client sends about itself: rendering errors, failed calls, reconnections. */
export interface DiagnosticReportRecord {
  level: CoreLogLevel;
  at: Timestamp;
  source: string;
  event: string;
  message: string;
  threadId?: ThreadId;
  durationMs?: number;
  data?: LogData;
}

export function validateDiagnosticReport(raw: unknown): DiagnosticReportRecord[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('diagnostics.report params: expected an object');
  const records = (raw as { records?: unknown }).records;
  if (!Array.isArray(records) || records.length < 1 || records.length > 50) throw new Error('diagnostics.report records: expected 1 to 50 records');
  return records.map((entry, index) => {
    const field = `diagnostics.report records[${index}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${field}: expected an object`);
    const value = entry as Record<string, unknown>;
    const record: DiagnosticReportRecord = {
      level: level(value.level, `${field}.level`), at: timestamp(value.at, `${field}.at`),
      source: plainText(value.source, `${field}.source`, 60), event: plainText(value.event, `${field}.event`, 100),
      message: typeof value.message === 'string' && value.message.length > 0 ? value.message.slice(0, LOG_MESSAGE_CHARS) : (() => { throw new Error(`${field}.message: expected text`); })(),
    };
    if (value.threadId !== undefined) record.threadId = plainText(value.threadId, `${field}.threadId`);
    if (value.durationMs !== undefined) {
      if (typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0) throw new Error(`${field}.durationMs: expected milliseconds`);
      record.durationMs = value.durationMs;
    }
    const data = normalizeLogData(value.data);
    if (data) record.data = data;
    return record;
  });
}

export interface DiagnosticsRpcMethods {
  /** Agent and owner. Anonymized; an agent reads only while `agentLogAccess` is on. */
  'diagnostics.logs': { params: DiagnosticsLogsQuery; result: CoreLogRecord[] };
  /** Agent and owner. The environment and the problems grouped, anonymized. */
  'diagnostics.summary': { params: { threadId?: ThreadId; since?: Timestamp }; result: DiagnosticSummary };
  /** Agent and owner. A readable anonymized file a developer can solve from. */
  'diagnostics.export': { params: DiagnosticsExportParams; result: DiagnosticsExport };
  /** Agent and owner. A draft GitHub issue for Boite, created through `gh` only when `submit` is true. */
  'diagnostics.issue': { params: DiagnosticsIssueParams; result: DiagnosticsIssue };
  /** Owner and paired devices: a client's own errors, stored as `origin: "ui"`. */
  'diagnostics.report': { params: { records: DiagnosticReportRecord[] }; result: { accepted: number } };
}
