import type {
  Backend,
  BackendCaps,
  ControlEvent,
  DbApi,
  EditorApi,
  ExplorerApi,
  FolderState,
  GitApi,
  LiveClaudeSession,
  LogApi,
  ProjectApi,
  PtyApi,
  PushApi,
  ScopeApi,
  SessionApi,
  SessionHit,
  ShellApi,
  WorkspaceMetaApi,
  WorktreeApi,
  WorktreeHold,
} from "../types";
import type { Project, Settings, Thread, TodoItem } from "$lib/types";
import type { CommitState, PrLookup } from "$lib/features/git/api";
import type { ShellOption } from "$lib/storage/platform.svelte";
import { Socket, type ConnState } from "./socket";

interface RawSession {
  id: string;
  modifiedMs?: number;
  title?: string | null;
}

function normalizeSession(raw: unknown): SessionHit | null {
  if (raw == null) return null;
  if (typeof raw === "string") return { id: raw, mtimeMs: null };
  const r = raw as RawSession;
  if (!r.id) return null;
  return {
    id: r.id,
    mtimeMs: typeof r.modifiedMs === "number" ? r.modifiedMs : null,
    title: typeof r.title === "string" && r.title ? r.title : null,
  };
}

// A write that reaches here is a bug in the caller, not a workspace the user
// should have to reason about — say which feature is missing and where.
async function chatUnsupported(): Promise<never> {
  throw new Error("chats are a local-workspace feature (caps.chat is false here)");
}

// Drives a boite-server over one WebSocket. Every Backend method maps to an RPC
// or binary frame; thread status/title flow back as control events (the server
// is authoritative). pty.open attaches to a live thread or spawns then attaches.
export class RemoteBackend implements Backend {
  readonly kind = "remote" as const;
  readonly caps: BackendCaps = { clientStatus: false, chat: false };

  readonly pty: PtyApi;
  readonly db: DbApi;
  readonly git: GitApi;
  readonly worktree: WorktreeApi;
  readonly explorer: ExplorerApi;
  readonly editor: EditorApi;
  readonly project: ProjectApi;
  readonly shell: ShellApi;
  readonly scope: ScopeApi;
  readonly session: SessionApi;
  readonly log: LogApi;
  readonly push: PushApi;
  readonly meta: WorkspaceMetaApi;

  #socket: Socket;
  #keyToThread = new Map<string, string>();
  // Coalesce resize RPCs: a pinch-zoom refit or rotation fires many in a row,
  // but the server only needs the final size.
  #resizeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(url: string, token: string, onState: (s: ConnState) => void = () => {}) {
    const socket = new Socket(url, token, onState);
    this.#socket = socket;
    const rpc = (m: string, p?: unknown) => socket.rpc(m, p);
    const keyToThread = this.#keyToThread;
    const threadIdOf = (key: string) => keyToThread.get(key) ?? key;

    this.pty = {
      open: async (args, onEvent) => {
        const { threadId, spec, meta } = args;
        const onOutput = (bytes: Uint8Array) => onEvent({ type: "output", bytes });
        const onReset = () => onEvent({ type: "reset" });
        let res: { ptyId?: string } | undefined;
        try {
          res = await socket.attach(threadId, spec.cols, spec.rows, onOutput, onReset);
        } catch (e) {
          if (!String(e).includes("not live")) throw e;
          await rpc("thread.spawn", {
            thread: {
              id: threadId,
              projectId: meta.projectId,
              label: meta.label,
              cmd: spec.cmd,
              args: spec.args,
              iconKey: meta.iconKey,
            },
            cwd: spec.cwd,
            cols: spec.cols,
            rows: spec.rows,
            wrap: spec.wrap,
          });
          res = await socket.attach(threadId, spec.cols, spec.rows, onOutput, onReset);
        }
        const key = res?.ptyId ? String(res.ptyId) : threadId;
        keyToThread.set(key, threadId);
        return key;
      },
      // Every PTY this protocol knows is keyed by a thread the server owns, and
      // a chat turn is deliberately not one. `caps.chat` is false here so the
      // UI never offers it; this exists to say why rather than to fail on a
      // missing method.
      spawn: chatUnsupported,
      write: (key, data) => {
        socket.sendInput(threadIdOf(key), data);
        return Promise.resolve();
      },
      resize: (key, cols, rows) => {
        const tid = threadIdOf(key);
        // Update the re-attach size immediately (cheap, local); debounce only
        // the RPC so a burst of refits collapses to one server resize.
        socket.setAttachSize(tid, cols, rows);
        const prev = this.#resizeTimers.get(tid);
        if (prev) clearTimeout(prev);
        this.#resizeTimers.set(
          tid,
          setTimeout(() => {
            this.#resizeTimers.delete(tid);
            // Tolerate a closed socket (reconnect window): an unhandled
            // "socket not open" rejection would otherwise surface.
            void rpc("thread.resize", { threadId: tid, cols, rows }).catch(() => {});
          }, 150),
        );
        return Promise.resolve();
      },
      kill: (key, wait = true) => {
        const tid = threadIdOf(key);
        keyToThread.delete(key);
        return rpc("thread.kill", { threadId: tid, wait }).then(() => {});
      },
      release: (key) => {
        const tid = threadIdOf(key);
        keyToThread.delete(key);
        return socket.detach(tid);
      },
    };

    this.db = {
      loadProjects: () => rpc("project.list").then((r) => r.projects as Project[]),
      saveProject: (p) => rpc("project.create", { project: p }).then(() => {}),
      setProjectArchived: (id, archived) =>
        rpc("project.archive", { id, archived }).then(() => {}),
      deleteProject: (id) => rpc("project.delete", { id }).then(() => {}),
      loadThreads: () => rpc("thread.list").then((r) => r.threads as Thread[]),
      // The server is authoritative for runtime state; this persists the row.
      // Status is forced idle server-side and the live overlay corrects it.
      saveThread: (t) => rpc("thread.create", { thread: t }).then(() => {}),
      updateThreadTitle: (id, title) =>
        rpc("thread.update", { threadId: id, title }).then(() => {}),
      deleteThread: (id) => rpc("thread.delete", { threadId: id }).then(() => {}),
      loadSettings: () =>
        rpc("settings.get").then((r) => (r.settings ?? {}) as Partial<Settings>),
      saveSettings: (s) => rpc("settings.set", { settings: s }).then(() => {}),
      loadTodos: () => rpc("todo.list").then((r) => (r.todos ?? []) as TodoItem[]),
      saveTodo: (todo) => rpc("todo.save", { todo }).then(() => {}),
      deleteTodo: (id) => rpc("todo.delete", { todoId: id }).then(() => {}),
      // `caps.chat` is false here, so the UI never offers a chat on a remote
      // workspace and nothing calls these. Empty rather than throwing: an
      // unconditional load on startup must not fail the whole workspace over a
      // feature it was never going to show.
      loadChats: async () => [],
      saveChat: chatUnsupported,
      deleteChat: chatUnsupported,
      loadChatMessages: async () => [],
      saveChatMessage: chatUnsupported,
    };

    this.git = {
      repoInfo: (path) => rpc("git.repoInfo", { path }),
      findRepos: (path) => rpc("git.findRepos", { path }).then((r) => r.repos),
      branches: (path) => rpc("git.branches", { path }).then((r) => r.branches),
      switchBranch: (path, name, create, stash) =>
        rpc("git.switchBranch", { path, name, create, stash}),
      status: (path) => rpc("git.status", { path }).then((r) => r.entries),
      log: (path, limit, skip) =>
        rpc("git.log", { path, limit, skip }).then((r) => r.commits),
      // An older server answers with an error for either of these. Unknown and
      // no-pull-request are what the panel would draw anyway, so a failure
      // costs a chip rather than a row.
      commitState: (path, sha) =>
        rpc("git.commitState", { path, sha })
          .then((r) => r.state as CommitState)
          .catch(() => ({
            known: false,
            pushed: false,
            short: sha.slice(0, 7),
            subject: null,
            branch: null,
          })),
      pullRequest: (path, branch) =>
        rpc("git.pullRequest", { path, branch })
          .then((r) => (r.lookup ?? { kind: "unavailable" }) as PrLookup)
          // An older server has no answer at all, which is exactly what
          // "nothing to report" means here.
          .catch(() => ({ kind: "unavailable" }) as PrLookup),
      stage: (path, files) => rpc("git.stage", { path, files }).then(() => {}),
      unstage: (path, files) => rpc("git.unstage", { path, files }).then(() => {}),
      discard: (path, files, untracked) =>
        rpc("git.discard", { path, files, untracked }).then(() => {}),
      commit: (path, message) => rpc("git.commit", { path, message }).then((r) => r.sha),
      fetch: (path) => rpc("git.fetch", { path }).then(() => {}),
      push: (path) => rpc("git.push", { path }).then(() => {}),
      pull: (path) => rpc("git.pull", { path }).then(() => {}),
      init: (path) => rpc("git.init", { path }).then(() => {}),
    };

    this.worktree = {
      open: (repo, threadId) =>
        rpc("worktree.open", { repo, threadId }).then((r) => (r.path as string) ?? null),
      claim: (path, name) => rpc("worktree.claim", { path, name }).then(() => {}),
      reserve: (path, name) => rpc("worktree.reserve", { path, name }).then(() => {}),
      hold: (path) => rpc("worktree.hold", { path }).then((r) => r as WorktreeHold),
      remove: (repo, path, force) =>
        rpc("worktree.remove", { repo, path, force }).then(() => {}),
    };

    this.explorer = {
      readDir: (path) => rpc("fs.readDir", { path }).then((r) => r.entries),
      changedPaths: (path) => rpc("git.changedPaths", { path }).then((r) => r.paths),
      search: (path, query, limit) =>
        rpc("fs.search", { path, query, limit }).then((r) => r.hits),
    };

    this.editor = {
      readTextFile: (path) => rpc("file.read", { path }),
      writeTextFile: (path, content) =>
        rpc("file.write", { path, content }).then((r) => r.bytes as number),
      fileVersions: (path, file, headFile) =>
        rpc("git.fileVersions", { path, file, headFile }),
    };

    this.project = {
      inspect: (path) => rpc("project.inspect", { path }),
      homeDir: () => rpc("project.homeDir").then((r) => r.path as string),
      folderState: (path) =>
        rpc("project.folderState", { path }).then((r) => r as unknown as FolderState),
      createFolder: (path) => rpc("project.createFolder", { path }).then(() => undefined),
    };

    this.shell = {
      defaultShell: () => rpc("shell.default").then((r) => r.shell as string),
      warmShell: (shellId) => rpc("shell.warm", { shellId }).then(() => undefined),
      availableShells: () =>
        rpc("shell.available").then((r) =>
          (r.shells as Array<{ id: string; label: string; cmd: string; args: string[]; icon_key: string | null }>).map(
            (s): ShellOption => ({
              id: s.id,
              label: s.label,
              cmd: s.cmd,
              args: s.args,
              iconKey: s.icon_key,
            }),
          ),
        ),
      commandExists: (cmd) =>
        rpc("shell.commandExists", { cmd }).then((r) => r.found as boolean),
    };

    // The server derives its filesystem trust boundary from persisted projects;
    // clients never set roots directly.
    this.scope = {
      registerProjectRoots: () => Promise.resolve(),
      workspaceRoot: () =>
        rpc("fs.workspaceRoot").then((r) => (r.root as string | null) ?? null),
    };

    this.session = {
      // ptyId names a PTY the server owns, so it resolves the pid on its side.
      // An older server ignores the extra param and keeps skipping every live
      // session, which is the behaviour it had before.
      find: (kind, cwd, afterUnixMs, excludeIds, ptyId) =>
        rpc("session.find", { kind, cwd, afterUnixMs, excludeIds, ptyId: ptyId ?? null }).then(
          (r) => normalizeSession(r.session),
        ),
      // The agents run on the server, so that is where the registry lives. An
      // older server answers with an error; an empty list then reads as
      // "nothing is live", which is exactly the behaviour from before.
      liveClaude: () =>
        rpc("session.liveClaude")
          .then((r) => (r.sessions ?? []) as LiveClaudeSession[])
          .catch(() => []),
      stopClaude: (sessionId) =>
        rpc("session.stopClaude", { sessionId })
          .then((r) => Boolean(r.stopped))
          .catch(() => false),
      // An older server has no answer for this; `true` replays the id exactly
      // as before rather than dropping a resume on a guess.
      copilotResumable: (sessionId) =>
        rpc("session.copilotResumable", { sessionId })
          .then((r) => r.resumable !== false)
          .catch(() => true),
      // The transcripts live next to the agents, so the server does the copy.
      // An older one has no answer, and `false` reads as "nothing was carried"
      // — the move still happens, the conversation just starts fresh there.
      migrate: (kind, sessionId, fromCwd, toCwd) =>
        rpc("session.migrate", { kind, sessionId, fromCwd, toCwd })
          .then((r) => Boolean(r.migrated))
          .catch(() => false),
    };

    // App-event logging is a device-local concern (the desktop writes a log
    // file). Remote logging is a no-op for now.
    this.log = {
      event: () => Promise.resolve(),
      read: () => Promise.resolve([]),
      clear: () => Promise.resolve(),
      filePath: () => Promise.resolve(""),
    };

    this.push = {
      publicKey: () => rpc("push.publicKey").then((r) => (r.key as string) ?? null),
      subscribe: (sub) => rpc("push.subscribe", sub).then(() => {}),
      unsubscribe: (endpoint) => rpc("push.unsubscribe", { endpoint }).then(() => {}),
    };

    const readMeta = (r: { name?: unknown; color?: unknown } | undefined) => ({
      name: typeof r?.name === "string" ? r.name : null,
      color: typeof r?.color === "string" ? r.color : null,
    });
    this.meta = {
      get: () => rpc("workspace.info").then(readMeta),
      set: (patch) => rpc("workspace.setInfo", patch).then(readMeta),
    };
  }

  connect(): Promise<void> {
    return this.#socket.connect();
  }

  dispose(): void {
    for (const t of this.#resizeTimers.values()) clearTimeout(t);
    this.#resizeTimers.clear();
    this.#socket.close();
  }

  get connectionState(): ConnState {
    return this.#socket.state;
  }

  subscribe(cb: (event: ControlEvent) => void): () => void {
    return this.#socket.onControl(cb);
  }

  // An older server has no answer for this, and the caller treats a failure as
  // "not mine" — which drops the request rather than running a move that a
  // second device may be running at the same time.
  claimAgentRequest(requestId: string): Promise<boolean> {
    return this.#socket
      .rpc("agent.claimRequest", { requestId })
      .then((r) => Boolean((r as { claimed?: boolean }).claimed));
  }
}
