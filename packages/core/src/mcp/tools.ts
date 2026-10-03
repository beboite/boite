import { z } from 'zod';
import type { RpcMethodName, RpcParams, RpcResult } from '@boite/contracts';
import type { CoreClient } from '../client.ts';

export const MCP_MAX_RESULT_BYTES = 256 * 1024;
const id = z.string().min(1).max(200);
const requestId = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/);
const text = z.string().min(1).max(32_000);
const address = z.strictObject({ coreId: id, threadId: id });
const page = { offset: z.number().int().min(0).max(100_000).default(0), limit: z.number().int().min(1).max(100).default(20) };

/** Fixed inventory: caller input never selects an RPC name or the authenticated source thread. */
export const MCP_TOOLS = {
  boite_where: { method: 'agent.where', description: 'Read this authenticated thread, project and working directory.', schema: z.strictObject({}), readOnly: true },
  boite_projects: { method: 'agent.projects', description: 'List registered projects, with bounded offset/limit paging.', schema: z.strictObject(page), readOnly: true },
  boite_capabilities: { method: 'threads.capabilities', description: 'Read implemented and currently available controls for this thread.', schema: z.strictObject({}), readOnly: true },
  boite_contacts: { method: 'collaboration.directory', description: 'List only contacts this thread is authorized to reach; offset/limit page the contacts.', schema: z.strictObject(page), readOnly: true },
  boite_contact_search: { method: 'collaboration.search', description: 'Search authorized contacts; offset/limit page the matches.', schema: z.strictObject({ query: z.string().min(1).max(500), ...page }), readOnly: true },
  boite_contact_read: { method: 'collaboration.read', description: 'Read an authorized contact transcript. Use its oldest entry at as before when more is true.', schema: z.strictObject({ target: address, limit: z.number().int().min(1).max(100).default(20), before: z.number().finite().optional() }), readOnly: true },
  boite_contact_send: { method: 'collaboration.send', description: 'Send as this thread to an authorized contact. Supply a stable requestId for retries.', schema: z.strictObject({ to: address, text, replyTo: id.optional(), requestId }), readOnly: false },
  boite_delegation: { method: 'delegation.get', description: 'Read this thread\'s team and owner-approved delegation profiles.', schema: z.strictObject({}), readOnly: true },
  boite_delegate_spawn: { method: 'delegation.spawn', description: 'Start one child on an owner-approved profile. Supply a stable requestId for retries.', schema: z.strictObject({ profileId: id, task: text, title: z.string().min(1).max(200).optional(), requestId }), readOnly: false },
  boite_delegate_send: { method: 'delegation.send', description: 'Send to a related child thread. Supply a stable requestId for retries.', schema: z.strictObject({ toThreadId: id, text, requestId }), readOnly: false },
  boite_delegate_wait: { method: 'delegation.wait', description: 'Wait for direct children without polling or stopping them. Default 10 minutes, maximum 1 hour; cancellation releases only this wait.', schema: z.strictObject({ agentId: id.optional(), timeoutMs: z.number().int().min(0).max(3_600_000).optional() }), readOnly: true },
  boite_delegate_result: { method: 'delegation.result', description: 'Read bounded pages of the exact completed child result using resultRef agentId/turnId. Offsets count Unicode code points; follow nextOffset.', schema: z.strictObject({ agentId: id, turnId: id, offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(16_000).optional() }), readOnly: true },
  boite_merge_back: { method: 'threads.mergeBack', description: 'Send an explicit summary from this fork back to its recorded source under existing coordination policy. It does not merge files or invent a summary.', schema: z.strictObject({ summary: z.string().min(1).max(4000), requestId }), readOnly: false },
  boite_delegate_stop: { method: 'delegation.stop', description: 'Stop only a child or this thread, under existing delegation permissions. Cancellation of an MCP call never invokes this tool.', schema: z.strictObject({ agentId: id.optional() }), readOnly: false },
  boite_plan_get: { method: 'threads.tasks.get', description: 'Read this thread\'s plan tasks.', schema: z.strictObject({}), readOnly: true },
  boite_plan_set: { method: 'threads.tasks.set', description: 'Replace this thread\'s bounded plan task list.', schema: z.strictObject({ tasks: z.array(z.strictObject({ id, text: z.string().min(1).max(2000), status: z.enum(['pending', 'in_progress', 'completed']) })).max(100) }), readOnly: false },
  boite_question: { method: 'questions.ask', description: 'Ask an asynchronous question in this thread; the answer arrives later as a message.', schema: z.strictObject({ text, options: z.array(z.string().min(1).max(500)).max(20).optional(), multiple: z.boolean().optional() }), readOnly: false },
} satisfies Record<string, { method: RpcMethodName; description: string; schema: z.ZodType; readOnly: boolean }>;

export type McpToolName = keyof typeof MCP_TOOLS;
export interface McpResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

export function requireMcpIdentity(client: CoreClient, threadId: string): void {
  if (client.principal !== 'agent' || client.threadId !== threadId || !threadId) {
    throw new Error('boite mcp requires an authenticated thread-bound agent identity');
  }
}

/** Extension point for future waits: cancellation releases this request, never a delegated child. */
export function requestWithCancellation<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return request;
  if (signal.aborted) return Promise.reject(new Error('MCP request cancelled; submitted work may continue'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('MCP request cancelled; submitted work may continue')); };
    signal.addEventListener('abort', abort, { once: true });
    request.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function boundedMcpResult(value: unknown, isError = false): McpResult {
  let structuredContent: Record<string, unknown> = { result: value, truncated: false };
  let result: McpResult = { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent, ...(isError ? { isError: true } : {}) };
  const bytes = Buffer.byteLength(JSON.stringify(result));
  if (bytes > MCP_MAX_RESULT_BYTES) {
    structuredContent = { truncated: true, bytes, maxBytes: MCP_MAX_RESULT_BYTES,
      preview: JSON.stringify(value).slice(0, 4000), next: 'Use a smaller limit and offset/before when supported. This preview is not a complete result; do not repeat mutations to recover output.' };
    result = { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent, ...(isError ? { isError: true } : {}) };
  }
  return result;
}

export type McpWaitClientFactory = () => Promise<CoreClient>;

async function dedicatedWait(factory: McpWaitClientFactory, threadId: string, params: RpcParams<'delegation.wait'>, signal?: AbortSignal): Promise<RpcResult<'delegation.wait'>> {
  let connection: CoreClient | null = null;
  const close = () => { const current = connection; connection = null; current?.close(); };
  signal?.addEventListener('abort', close, { once: true });
  try {
    return await requestWithCancellation((async () => {
      connection = await factory();
      try {
        if (signal?.aborted) throw new Error('MCP wait cancelled before submission');
        requireMcpIdentity(connection, threadId);
        return await connection.call('delegation.wait', params);
      } finally { close(); }
    })(), signal);
  } finally { signal?.removeEventListener('abort', close); close(); }
}

export async function dispatchMcpTool(client: CoreClient, threadId: string, name: string, input: unknown, signal?: AbortSignal, waitClientFactory?: McpWaitClientFactory): Promise<McpResult> {
  requireMcpIdentity(client, threadId);
  if (!Object.hasOwn(MCP_TOOLS, name)) throw new Error(`unknown Boite MCP tool ${name}`);
  if (signal?.aborted) throw new Error('MCP request cancelled before submission');
  const tool = MCP_TOOLS[name as McpToolName];
  const params = tool.schema.parse(input ?? {}) as Record<string, unknown>;
  const listing = name === 'boite_projects' || name === 'boite_contacts' || name === 'boite_contact_search';
  const offset = listing ? params.offset : undefined;
  const rpcInput = { ...params };
  if (listing) delete rpcInput.offset;
  if (name === 'boite_projects' || name === 'boite_contacts' || name === 'boite_contact_search') delete rpcInput.limit;
  const sourceParams = { ...rpcInput, threadId } as RpcParams<typeof tool.method>;
  const result = name === 'boite_delegate_wait'
    ? await dedicatedWait(waitClientFactory ?? (() => { throw new Error('dedicated MCP wait connection is unavailable'); }), threadId, sourceParams as RpcParams<'delegation.wait'>, signal)
    : await requestWithCancellation(client.call(tool.method, sourceParams), signal);
  let value: unknown = result;
  if (typeof offset === 'number') {
    const limit = Number(params.limit);
    const items = Array.isArray(result) ? result : name === 'boite_contacts'
      ? (result as RpcResult<'collaboration.directory'>).agents : (result as RpcResult<'collaboration.search'>).matches;
    value = { items: items.slice(offset, offset + limit), unavailable: Array.isArray(result) ? [] : (result as RpcResult<'collaboration.directory'>).unavailable,
      page: { offset, limit, total: items.length, nextOffset: offset + limit < items.length ? offset + limit : null } };
  }
  return boundedMcpResult(value);
}
