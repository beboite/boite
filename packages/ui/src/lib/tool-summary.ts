import { fill, strings } from './strings';

/**
 * What a tool call is about, read the same way on the tool card and on the
 * permission card. Each agent names its tools its own way (Claude's `Edit`,
 * Codex's `ApplyPatch`, an ACP agent's title), so the family comes from the name
 * when it is a known one and from the shape of the input otherwise.
 */

export type ToolFamily = 'command' | 'edit' | 'write' | 'read' | 'search' | 'fetch' | 'web' | 'agent' | 'other';

export interface ToolDescription {
  family: ToolFamily;
  /** The path, command, pattern, address or query the call is about; empty when it has none. */
  subject: string;
  /** An edit whose before and after are both in the input: what the diff view draws. */
  change: { path: string; oldText: string; newText: string } | null;
}

const SUMMARY_KEYS = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'notebook_path', 'prompt', 'description'];

/** The first `"key": "value` of a half-typed JSON object, so the line reads before it closes. */
const PARTIAL_VALUE = /"[^"]*"\s*:\s*"((?:[^"\\]|\\.)*)/;

/** Tool names, lowered and stripped of `_`, `-` and spaces, and the family each one is. */
const BY_NAME: Record<string, ToolFamily> = {
  bash: 'command', shell: 'command', exec: 'command', execute: 'command', runshellcommand: 'command', command: 'command', powershell: 'command',
  edit: 'edit', multiedit: 'edit', strreplace: 'edit', strreplacebasededittool: 'edit', applypatch: 'edit', patch: 'edit', notebookedit: 'edit', replace: 'edit',
  write: 'write', writefile: 'write', create: 'write', createfile: 'write',
  read: 'read', readfile: 'read', view: 'read', cat: 'read', notebookread: 'read',
  grep: 'search', glob: 'search', search: 'search', find: 'search', ls: 'search', listdirectory: 'search', searchfiles: 'search',
  webfetch: 'fetch', fetch: 'fetch', readurl: 'fetch',
  websearch: 'web', googlesearch: 'web',
  task: 'agent', agent: 'agent'
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The one value a reader wants on a closed line: the path, the command, the pattern. */
export function summaryOf(value: unknown): string {
  if (typeof value === 'string') return value;
  const fields = record(value);
  if (!fields) return '';
  for (const key of SUMMARY_KEYS) {
    const found = fields[key];
    if (typeof found === 'string' && found.length > 0) return found.split('\n')[0] ?? '';
  }
  const first = Object.values(fields).find((entry) => typeof entry === 'string');
  return typeof first === 'string' ? (first.split('\n')[0] ?? '') : '';
}

/** While the JSON is still arriving the summary comes from it, else nothing. */
export function partialSummaryOf(raw: string): string {
  const found = PARTIAL_VALUE.exec(raw);
  const value = found?.[1] ?? '';
  return value.length > 0 ? (value.split('\\n')[0] ?? '') : '';
}

function familyOfShape(fields: Record<string, unknown>): ToolFamily {
  if (typeof fields['command'] === 'string' || Array.isArray(fields['command'])) return 'command';
  if ('old_string' in fields || 'new_string' in fields || Array.isArray(fields['edits'])) return 'edit';
  if (bodyOf(fields) !== null && (typeof fields['file_path'] === 'string' || typeof fields['path'] === 'string')) return 'write';
  if (typeof fields['url'] === 'string') return 'fetch';
  if (typeof fields['query'] === 'string') return 'web';
  if (typeof fields['pattern'] === 'string') return 'search';
  if ('grantRoot' in fields) return 'edit';
  return 'other';
}

/** A written file's body: Claude says `content`, some ACP agents `contents`. */
function bodyOf(fields: Record<string, unknown>): string | null {
  if (typeof fields['content'] === 'string') return fields['content'];
  return typeof fields['contents'] === 'string' ? fields['contents'] : null;
}

/** A command given as an argv array, the way Codex and some ACP agents send it, reads as one line. */
function commandOf(value: unknown): string {
  if (Array.isArray(value)) return value.filter((part) => typeof part === 'string').join(' ');
  return text(value);
}

export function describeTool(name: string, input: unknown): ToolDescription {
  const fields = record(input) ?? {};
  const key = name.toLowerCase().replace(/[\s_-]/g, '');
  const family = BY_NAME[key] ?? familyOfShape(fields);
  const path = text(fields['file_path']) || text(fields['path']) || text(fields['notebook_path']) || text(fields['grantRoot']);
  let subject: string;
  switch (family) {
    case 'command': subject = commandOf(fields['command']) || summaryOf(input); break;
    case 'fetch': subject = text(fields['url']) || summaryOf(input); break;
    case 'web': subject = text(fields['query']) || summaryOf(input); break;
    case 'search': subject = text(fields['pattern']) || text(fields['query']) || path || summaryOf(input); break;
    case 'agent': subject = text(fields['description']) || text(fields['prompt']).split('\n')[0] || ''; break;
    case 'edit': case 'write': case 'read': subject = path || summaryOf(input); break;
    default: subject = summaryOf(input);
  }
  let change: ToolDescription['change'] = null;
  if (family === 'edit' && path && (typeof fields['old_string'] === 'string' || typeof fields['new_string'] === 'string')) {
    change = { path, oldText: text(fields['old_string']), newText: text(fields['new_string']) };
  } else if (family === 'write' && path && bodyOf(fields) !== null) {
    change = { path, oldText: '', newText: bodyOf(fields) ?? '' };
  }
  return { family, subject, change };
}

/** The last segment of a path, for a sentence; the whole path rides in the title. */
export function fileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * The permission card's sentence: what the agent asks to do, in words a person
 * who never read the tool's name can answer. An unknown tool says so plainly
 * rather than guessing at what it does.
 */
export function permissionSentence(name: string, input: unknown): string {
  const { family, subject } = describeTool(name, input);
  const asks = strings.chat.permissionAsk;
  const fields = record(input) ?? {};
  switch (family) {
    case 'command': return asks.command;
    case 'edit':
      // Codex asks for a file change with no file, or for a root to write under.
      if ('grantRoot' in fields) return typeof fields['grantRoot'] === 'string' && fields['grantRoot'].length > 0 ? fill(asks.editFolder, { folder: fields['grantRoot'] }) : asks.editFiles;
      return subject ? fill(asks.edit, { file: fileName(subject) }) : asks.editFiles;
    case 'write': return subject ? fill(asks.write, { file: fileName(subject) }) : asks.editFiles;
    case 'read': return subject ? fill(asks.read, { file: fileName(subject) }) : fill(asks.other, { tool: name });
    case 'search': return subject ? fill(asks.search, { subject }) : fill(asks.other, { tool: name });
    case 'fetch': return subject ? fill(asks.fetch, { subject: hostOf(subject) }) : fill(asks.other, { tool: name });
    case 'web': return subject ? fill(asks.web, { subject }) : fill(asks.other, { tool: name });
    case 'agent': return asks.agent;
    default: return fill(asks.other, { tool: name });
  }
}

function hostOf(url: string): string {
  try { return new URL(url).host || url; } catch { return url; }
}
