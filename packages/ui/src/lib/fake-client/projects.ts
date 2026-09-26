/** Projects, their files and the Claude Code sessions they can import. */
import { RpcErrorCode, type Project, type Thread, type ThreadId, type Turn } from '@boite/contracts';
import { RpcFailure } from '../client';
import { missingFolder, pathKey } from './checks';
import { FAKE_FILES, scoreFakeFile } from './files';
import { IMPORT_LIST_MS } from './providers';
import { FAKE_DRAFTS_PATH, toSummary } from './shared';
import { putAway } from './threads';
import type { FakeContext, FakeMethods } from './context';

export function projectMethods(ctx: FakeContext) {
  return {
    'projects.list': async (params) => {
      return structuredClone(ctx.projects);
    },
    'projects.browse': async (params) => {
      const { path = '/workspace' } = params;
      return {
        path, parent: path === '/' ? null : '/', directories: path === '/workspace' ? [
          { name: 'boite', path: '/workspace/boite' }, { name: 'notes', path: '/workspace/notes' }
        ] : []
      };
    },
    'projects.add': async (params) => {
      if (missingFolder(params.path)) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'a project path must be an existing directory', data: { path: params.path } });
      }
      // As the core on Windows: the same folder in another case is the project already there.
      const existing = ctx.projects.find((p) => pathKey(p.path) === pathKey(params.path));
      if (existing) return structuredClone(existing);
      const project: Project = {
        id: `p-${++ctx.seq}`,
        name: params.name ?? params.path.split(/[\\/]/).filter(Boolean).pop() ?? params.path,
        path: params.path,
        createdAt: ctx.now(),
        // No disk here: a folder the fake is handed counts as a repository.
        repository: true
      };
      ctx.projects.push(project);
      ctx.emit('project.added', structuredClone(project));
      return structuredClone(project);
    },
    'projects.drafts': async () => {
      const existing = ctx.projects.find((p) => p.kind === 'drafts');
      if (existing) return structuredClone(existing);
      const project: Project = {
        id: `p-${++ctx.seq}`,
        name: 'Drafts',
        path: FAKE_DRAFTS_PATH,
        createdAt: ctx.now(),
        repository: false,
        kind: 'drafts'
      };
      ctx.projects.push(project);
      ctx.emit('project.added', structuredClone(project));
      return structuredClone(project);
    },
    'projects.remove': async (params) => {
      if (!ctx.projects.some((p) => p.id === params.projectId)) throw ctx.notFound('project', params.projectId);
      if (ctx.agents.referencesProject(params.projectId)) {
        throw new RpcFailure({
          code: RpcErrorCode.Refused,
          message: 'this project is referenced by persistent agents; keep it registered to preserve their workspaces and shared context',
          data: { projectId: params.projectId }
        });
      }
      ctx.projects = ctx.projects.filter((p) => p.id !== params.projectId);
      const threads = [...ctx.threads.values()].filter((thread) => thread.projectId === params.projectId);
      // As the core: each thread is archived, and says so, before the records go.
      for (const thread of threads) {
        thread.archived = true;
        ctx.touch(thread);
      }
      await Promise.all(threads.map((thread) => putAway(ctx, thread)));
      for (const thread of threads) {
        ctx.threads.delete(thread.id);
        ctx.emit('thread.removed', { threadId: thread.id });
      }
      ctx.emit('project.removed', { projectId: params.projectId });
      return { ok: true };
    },
    'projects.files': async (params) => {
      if (!ctx.projects.some((p) => p.id === params.projectId)) {
        throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `unknown project ${params.projectId}` });
      }
      const limit = Math.max(1, Math.min(200, params.limit ?? 50));
      const scored = FAKE_FILES.map((path) => ({ path, score: scoreFakeFile(params.query, path) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
      return { files: scored.slice(0, limit).map((entry) => entry.path), total: scored.length, capped: false };
    },
    'imports.list': async (params) => {
      if (!ctx.projects.some((p) => p.id === params.projectId)) throw ctx.notFound('project', params.projectId);
      await new Promise((resolve) => setTimeout(resolve, IMPORT_LIST_MS));
      // Newest first, the core's order.
      return structuredClone(
        ctx.importable
          .filter((session) => session.projectId === params.projectId)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map(({ projectId: _p, ...session }) => session)
      );
    },
    'imports.run': async (params) => {
      const project = ctx.projects.find((p) => p.id === params.projectId);
      if (!project) throw ctx.notFound('project', params.projectId);
      const session = ctx.importable.find((entry) => entry.projectId === params.projectId && entry.sessionId === params.sessionId);
      if (!session) {
        throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `no transcript for session ${params.sessionId}`, data: { sessionId: params.sessionId } });
      }
      if (session.threadId !== null) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'this session is already a thread', data: { sessionId: params.sessionId, threadId: session.threadId } });
      }
      await new Promise((resolve) => setTimeout(resolve, IMPORT_LIST_MS));
      const id: ThreadId = `t-${++ctx.seq}`;
      const turnA: Turn = { id: `turn-${id}-1`, threadId: id, status: 'done', queuedAt: session.startedAt, startedAt: session.startedAt, finishedAt: session.startedAt + 4_000, usage: null, error: null };
      const turnB: Turn = { id: `turn-${id}-2`, threadId: id, status: 'done', queuedAt: session.updatedAt - 9_000, startedAt: session.updatedAt - 9_000, finishedAt: session.updatedAt, usage: null, error: null };
      const thread: Thread = {
        id,
        projectId: params.projectId,
        title: session.title,
        titleSource: 'agent',
        providerId: 'claude',
        accountId: params.accountId,
        model: 'claude-sonnet-5',
        effort: null,
        cwd: project.path,
        branch: null,
        permissionMode: 'default',
        status: 'idle',
        unread: false,
        archived: false,
        pinned: false,
        sessionId: session.sessionId,
        load: null,
        context: null,
        createdAt: session.startedAt,
        updatedAt: session.updatedAt,
        commands: [],
        messagesBefore: null,
        turns: [turnA, turnB],
        messages: [
          { id: `${id}-m1`, threadId: id, turnId: turnA.id, role: 'user', parts: [{ type: 'text', text: 'Where does the shell look for a core, in what order?' }], state: 'complete', createdAt: turnA.queuedAt },
          {
            id: `${id}-m2`, threadId: id, turnId: turnA.id, role: 'assistant', state: 'complete', createdAt: turnA.queuedAt + 1_000,
            parts: [
              { type: 'thinking', text: 'The order lives in the Rust side, next to the sidecar lookup.' },
              { type: 'tool', toolId: `${id}-tool-1`, name: 'Grep', input: { pattern: 'boite-core', path: 'apps/shell/src-tauri/src' }, output: 'apps/shell/src-tauri/src/core.rs:41\napps/shell/src-tauri/src/core.rs:58', status: 'done' },
              { type: 'text', text: 'Three places, in order: the sidecar beside the exe, `BOITE_CORE` in the environment, then `bun run core` from the repository.' }
            ]
          },
          { id: `${id}-m3`, threadId: id, turnId: turnB.id, role: 'user', parts: [{ type: 'text', text: 'Write that down in docs/releasing.md' }], state: 'complete', createdAt: turnB.queuedAt },
          { id: `${id}-m4`, threadId: id, turnId: turnB.id, role: 'assistant', state: 'complete', createdAt: turnB.queuedAt + 2_000, parts: [{ type: 'text', text: 'Done: a short list under "Where the shell looks for a core".' }] }
        ]
      };
      ctx.threads.set(id, thread);
      session.threadId = id;
      ctx.emit('thread.created', structuredClone(toSummary(thread)));
      return structuredClone(toSummary(thread));
    },
  } satisfies Partial<FakeMethods>;
}
