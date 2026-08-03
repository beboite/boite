import type {
  Backend,
  BackendCaps,
  ControlEvent,
  DbApi,
  EditorApi,
  ExplorerApi,
  FastpickApi,
  FastpickListing,
  FolderState,
  GitApi,
  LiveClaudeSession,
  AgentTurn,
  UsageReport,
  LogApi,
  ProjectApi,
  PtyApi,
  PushApi,
  ScopeApi,
  SessionApi,
  SessionHit,
  ShellApi,
  SystemApi,
  WorkspaceMetaApi,
  WorktreeApi,
  WorktreeEntry,
  WorktreeHold,
} from "../types";
import type { Project, Settings, Thread, TodoItem } from "$lib/types";
import type { CommitState, PrLookup } from "$lib/features/git/api";
import type { Platform, ShellOption } from "$lib/storage/platform.svelte";
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

// Drives a boite-server over one WebSocket. Every Backend method maps to an RPC
// or binary frame; thread status/title flow back as control events (the server
// is authoritative). pty.open attaches to a live thread or spawns then attaches.
export class RemoteBackend implements Backend {
  readonly kind = "remote" as const;
  readonly caps: BackendCaps = { clientStatus: false, appLogs: false };

  readonly pty: PtyApi;
  readonly db: DbApi;
  readonly git: GitApi;
  readonly worktree: WorktreeApi;
  readonly explorer: ExplorerApi;
  readonly editor: EditorApi;
  readonly project: ProjectApi;
  readonly system: SystemApi;
  readonly shell: ShellApi;
  readonly fastpick: FastpickApi;
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

  constructor(
    url: string,
    token: string,
    onState: (s: ConnState) => void = () => {},
    onAuthRejected: () => void = () => {},
  ) {
    const socket = new Socket(url, token, onState, onAuthRejected);
    this.#socket = socket;
    const rpc = (m: string, p?: unknown) => socket.rpc(m, p);
    const keyToThread = this.#keyToThread;
    const threadIdOf = (key: string) => keyToThread.get(key) ?? key;

    this.pty = {
      open: async (args, onEvent) => {
        const { threadId, spec, meta } = args;
        const onOutput = (bytes: Uint8Array) => onEvent({ type: "output", bytes });
        const onReset = () => onEvent({ type: "reset" });
        const spawn = () =>
          rpc("thread.spawn", {
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
        // Declarations, not consts: the two call each other, and hoisting is
        // what keeps that from being an ordering puzzle.
        // The key the caller is holding, so a respawn can retire it rather than
        // leaving one dead entry per server restart in a map that is only ever
        // added to.
        let issued: string | null = null;
        async function attach(): Promise<string> {
          const res = await socket.attach(
            threadId,
            spec.cols,
            spec.rows,
            onOutput,
            onReset,
            onLost,
          );
          const key = res?.ptyId ? String(res.ptyId) : threadId;
          if (issued !== null && issued !== key) {
            keyToThread.delete(issued);
            // The old key named a PTY that is gone. Writes still routed, since
            // the stale entry pointed at the right thread, but `session.find`
            // asks the server to resolve a pid from this id and the server has
            // never heard of it.
            onEvent({ type: "key", key });
          }
          issued = key;
          keyToThread.set(key, threadId);
          return key;
        }
        // The socket reconnected onto a server that restarted under us, so the
        // thread row is there and its PTY is not. Spawning again is what makes
        // a deploy survivable from the client side: the row kept its sessionId,
        // so an agent resumes its conversation and anything else re-runs its
        // command. Giving up here is what left a permanently blank pane.
        function onLost(): void {
          void spawn()
            .then(() => attach())
            .catch(() => {});
        }
        try {
          return await attach();
        } catch (e) {
          if (!String(e).includes("not live")) throw e;
          await spawn();
          return await attach();
        }
      },
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
      warm: (repo) => rpc("worktree.warm", { repo }).then(() => {}),
      migrate: (repo, threadId, from) =>
        rpc("worktree.migrate", { repo, threadId, from }).then((r) => ({
          path: (r.path as string) ?? null,
          gone: Boolean(r.gone),
        })),
      list: (repo) =>
        rpc("worktree.list", { repo }).then((r) => (r.worktrees ?? []) as WorktreeEntry[]),
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
      // No server-side twin yet: the bytes would have to cross the socket, and
      // the protocol carries no binary frame. A refusal with a reason beats a
      // preview that renders nothing.
      readBase64: () => Promise.reject(new Error("not-supported-remote")),
    };

    this.project = {
      inspect: (path) => rpc("project.inspect", { path }),
      homeDir: () => rpc("project.homeDir").then((r) => r.path as string),
      folderState: (path) =>
        rpc("project.folderState", { path }).then((r) => r as unknown as FolderState),
      createFolder: (path) => rpc("project.createFolder", { path }).then(() => undefined),
    };

    // The boite's OS, not the phone's. An older server has no arm for this, and
    // "unknown" is the honest answer then: the caller keeps whatever it already
    // had rather than picking a shell list for a machine it guessed at.
    this.system = {
      platform: () =>
        rpc("system.platform")
          .then((r) => {
            const os = r.platform as string;
            return os === "windows" || os === "macos" || os === "linux"
              ? (os as Platform)
              : ("unknown" as Platform);
          })
          .catch(() => "unknown" as Platform),
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

    // Asked of the server, never of this device: fastpick's config and key files live
    // where the agents run, and a picker drawn on a phone must still describe that
    // machine's endpoints rather than the phone's.
    this.fastpick = {
      list: (provider, refresh) =>
        rpc("fastpick.list", { provider: provider ?? null, refresh: refresh ?? false }).then(
          (r) => JSON.parse(r.json as string) as FastpickListing,
        ),
      version: () =>
        rpc("fastpick.version", {}).then((r) => (r.version as string | null) ?? null),
    };

    // The server derives its filesystem trust boundary from persisted projects;
    // clients never set roots directly.
    this.scope = {
      registerProjectRoots: () => Promise.resolve(),
      workspaceRoot: () =>
        rpc("fs.workspaceRoot").then((r) => (r.root as string | null) ?? null),
    };

    this.session = {
      // The transcripts are on the boite, not on the phone reading them. An
      // older server has no answer, and an empty report is the honest one: the
      // card then says nothing was found rather than inventing a total.
      usage: (cwds, days) =>
        rpc("session.usage", { cwds, days })
          .then((r) => r as unknown as UsageReport)
          .catch(() => ({ models: [], days: [], sessions: 0, missing: [] })),
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
      // Same reasoning: the agents run on the server, so it is the only machine
      // that can read what they say about themselves. An older server answers
      // with an error, and an empty list reads as "nobody said anything", which
      // leaves the boite's threads on the status it derives for itself.
      agentTurns: (queries) =>
        rpc("session.agentTurns", { queries })
          .then((r) => (r.turns ?? []) as AgentTurn[])
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
    // file). Remote logging is a no-op for now, and `caps.appLogs: false` is how
    // the panel knows to say so instead of drawing an empty list.
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

  // The boite refused the token, so no amount of backoff will help and the app
  // has to ask for a new one.
  get authRejected(): boolean {
    return this.#socket.authRejected;
  }

  // Jump the backoff queue. Driven by the retry button in the connection banner.
  retryNow(): void {
    this.#socket.retryNow();
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
