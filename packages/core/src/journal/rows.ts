import type { Account, Message, MessagePart, MessageRole, Project, ProcessRecord, ThreadSummary, Turn, Usage } from '@boite/contracts';

// The rows of the projection tables and what each becomes on the wire.

export interface ProjectRow {
  id: string;
  name: string;
  path: string;
  created_at: number;
}

export interface ThreadRow {
  parent_thread_id: string | null;
  last_user_message_at?: number | null;
  id: string;
  project_id: string | null;
  agent_session_id?: string | null;
  title: string;
  title_source: string;
  provider_id: string;
  account_id: string;
  model: string | null;
  effort: string | null;
  speed: string | null;
  cwd: string;
  branch: string | null;
  permission_mode: string;
  status: string;
  unread: number;
  archived: number;
  pinned: number;
  session_id: string | null;
  session_generation: number;
  selection_version: number;
  context: string | null;
  prompt_cache: string | null;
  created_at: number;
  updated_at: number;
}

export interface TurnRow {
  id: string;
  thread_id: string;
  status: string;
  queued_at: number;
  started_at: number | null;
  finished_at: number | null;
  usage: string | null;
  error: string | null;
  execution: string | null;
}

export interface MessageRow {
  id: string;
  thread_id: string;
  turn_id: string;
  role: string;
  parts: string;
  state: string;
  created_at: number;
}

export interface ProcessRow {
  pid: number;
  thread_id: string;
  parent_pid: number | null;
  exe: string;
  command_line: string | null;
  started_at: number;
  exited_at: number | null;
  exit_code: number | null;
  cpu_ms: number | null;
  peak_memory_bytes: number | null;
  io_bytes: number | null;
}

export interface AccountRow {
  id: string;
  provider_id: string;
  label: string;
  isolation_dir: string | null;
  status: string;
  identity: string | null;
  created_at: number;
}

export function parseJson<T>(text: string, location: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`invalid JSON in ${location}`);
  }
}

export function toProject(row: ProjectRow): Project {
  return { id: row.id, name: row.name, path: row.path, createdAt: row.created_at };
}

export function toThread(row: ThreadRow): ThreadSummary {
  return {
    ...(row.parent_thread_id ? { parentThreadId: row.parent_thread_id } : {}),
    lastUserMessageAt: row.last_user_message_at ?? null,
    id: row.id,
    projectId: row.project_id,
    ...(row.agent_session_id ? { agentSessionId: row.agent_session_id } : {}),
    title: row.title,
    titleSource: row.title_source as ThreadSummary['titleSource'],
    providerId: row.provider_id,
    accountId: row.account_id,
    model: row.model,
    effort: row.effort,
    speed: row.speed,
    cwd: row.cwd,
    branch: row.branch,
    permissionMode: row.permission_mode as ThreadSummary['permissionMode'],
    status: row.status as ThreadSummary['status'],
    unread: row.unread !== 0,
    archived: row.archived !== 0,
    pinned: row.pinned !== 0,
    sessionId: row.session_id,
    sessionGeneration: row.session_generation,
    selectionVersion: row.selection_version,
    load: null,
    context: row.context === null ? null : parseJson<ThreadSummary['context']>(row.context, `threads.context of ${row.id}`),
    promptCache: row.prompt_cache === null ? null : parseJson<ThreadSummary['promptCache']>(row.prompt_cache, `threads.prompt_cache of ${row.id}`),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toTurn(row: TurnRow): Turn {
  return {
    id: row.id,
    threadId: row.thread_id,
    status: row.status as Turn['status'],
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    usage: row.usage === null ? null : parseJson<Usage>(row.usage, `turns.usage row ${row.id}`),
    error: row.error,
    ...(row.execution === null ? {} : { execution: parseJson<NonNullable<Turn['execution']>>(row.execution, `turns.execution of ${row.id}`) }),
  };
}

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    role: row.role as MessageRole,
    parts: parseJson<MessagePart[]>(row.parts, `messages.parts row ${row.id}`),
    state: row.state as Message['state'],
    createdAt: row.created_at,
  };
}

export function toProcess(row: ProcessRow): ProcessRecord {
  return {
    pid: row.pid,
    parentPid: row.parent_pid,
    threadId: row.thread_id,
    exe: row.exe,
    commandLine: row.command_line,
    startedAt: row.started_at,
    exitedAt: row.exited_at,
    exitCode: row.exit_code,
    cpuMs: row.cpu_ms,
    peakMemoryBytes: row.peak_memory_bytes,
    ioBytes: row.io_bytes,
  };
}

export function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    providerId: row.provider_id,
    label: row.label,
    isolationDir: row.isolation_dir,
    status: row.status as Account['status'],
    identity: row.identity,
    createdAt: row.created_at,
  };
}
