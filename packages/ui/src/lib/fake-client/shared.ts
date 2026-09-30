import {
  RpcErrorCode,
  TODO_TEXT_MAX,
  type AgentCommand,
  type Thread,
  type ThreadSummary,
  type Usage,
  type WorktreeStorage,
} from '@boite/contracts';
import { RpcFailure } from '../client';

/** The device boundary, the core's own sets: `packages/contracts/src/access.ts`. */
export { DEVICE_METHODS } from '@boite/contracts';

export const T0 = Date.UTC(2026, 8, 5, 9, 0, 0);

export const DATA_DIR = 'C:\\Users\\you\\AppData\\Local\\boite2';

/** What the echo driver reports as its `/name` list, the same two commands. */
export const ECHO_COMMANDS: AgentCommand[] = [
  { name: 'shout', description: 'The prompt back in capitals', hint: '<text>' },
  { name: 'whisper', description: 'The prompt back as it came', hint: null }
];

/** The one the fake acts on: `/shout <text>` comes back in capitals. */
export const SHOUT = 'shout';

/** A refusal worded like the core's, so a screen tested here shows what the real one would. */
export function refusal(message: string, data?: Record<string, unknown>): RpcFailure {
  return new RpcFailure({ code: RpcErrorCode.Refused, message, ...(data === undefined ? {} : { data }) });
}

/** The core's `checkText` in `todos.ts`: a card needs text, and a line of it. */
export function todoText(text: unknown): string {
  if (typeof text !== 'string' || text.trim().length === 0) throw refusal('a todo needs text');
  const trimmed = text.trim();
  if (trimmed.length > TODO_TEXT_MAX) {
    throw refusal(`a todo is at most ${TODO_TEXT_MAX} characters, this one is ${trimmed.length}`);
  }
  return trimmed;
}

/** The drafts folder the fake's core would find in Documents. */
export const FAKE_DRAFTS_PATH = 'C:\\Users\\you\\Documents\\Boite';

/** The core's `2026-09-23 First words` folder, `name 2` when a thread already holds it. */
export function fakeDraftFolder(root: string, title: string, at: Date, taken: ReadonlySet<string>): string {
  const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
  const words = title.replace(/[<>:"/\\|?*]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 6).join(' ').slice(0, 60).replace(/[. ]+$/, '');
  const name = words ? `${day} ${words}` : day;
  let path = `${root}\\${name}`;
  for (let index = 2; taken.has(path); index += 1) path = `${root}\\${name} ${index}`;
  return path;
}

/** Mirrors the core's per-project and shared storage for newly created worktrees. */
export function fakeWorktree(projectPath: string, _title: string, branch?: string, storage?: WorktreeStorage, projectId?: string): { branch: string; path: string; namingPending: boolean } {
  const slug = `wt-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const root = storage?.mode === 'shared' ? storage.directory : projectPath;
  const separator = root.includes('\\') ? '\\' : '/';
  const repo = projectPath.split(/[\\/]/).filter(Boolean).pop() ?? 'repo';
  const repoSlug = repo.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'thread';
  const folder = storage?.mode === 'shared'
    ? `${repoSlug}-${(projectId ?? '').replace(/[^a-z0-9_-]/gi, '-')}`
    : `.boite${separator}worktrees`;
  const dir = branch === undefined ? slug : branch.replace(/^boite\//, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return {
    branch: branch ?? `boite/${slug}`,
    namingPending: branch === undefined,
    path: [root.replace(/[\\/]+$/, ''), folder, dir].join(separator)
  };
}

export function toSummary(thread: Thread): ThreadSummary {
  const { memoryEvents: _memoryEvents, messages: _messages, turns: _turns, background: _background, ...rest } = thread;
  const busy = thread.status === 'running' || thread.status === 'waiting';
  const started = thread.turns.filter(turn => turn.status === 'running' && turn.startedAt !== null).map(turn => turn.startedAt as number);
  const tasks = thread.background ?? [];
  return {
    ...rest,
    lastUserMessageAt: thread.messages.filter(m => m.role === 'user').at(-1)?.createdAt ?? null,
    runningSince: busy && started.length > 0 ? Math.min(...started) : null,
    backgroundWork: tasks.length === 0 ? null : { kinds: tasks.map(task => task.kind), since: Math.min(...tasks.map(task => task.startedAt)) }
  };
}

export function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsdEquivalent: 0
  };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsdEquivalent: (a.costUsdEquivalent ?? 0) + (b.costUsdEquivalent ?? 0)
  };
}

/** `pieces` parts, or parts of `size` characters when one is given (the echo driver's rate). */
export function chunkText(text: string, pieces: number, chunkSize?: number): string[] {
  if (text.length === 0) return [''];
  const size = chunkSize ?? Math.max(1, Math.ceil(text.length / pieces));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
