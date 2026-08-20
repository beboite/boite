import type {
  ApprovalsApi,
  SyncApi,
  SyncConflict,
  SyncJob,
  SyncProbe,
  SyncSource,
  SyncStatus,
  Backend,
  BackendCaps,
  CommitStateAnswer,
  ConductApi,
  ControlEvent,
  DbApi,
  Checkpoint,
  CheckpointApi,
  CheckpointDiff,
  CheckpointFileVersions,
  CliApi,
  CliDataPath,
  CliLatest,
  CliJob,
  CliRow,
  EditorApi,
  ExplorerApi,
  CodexSwitcherApi,
  CodexSwitcherList,
  FastMcpSshApi,
  KebaccSwitcherApi,
  KebaccSwitcherList,
  FastpickApi,
  FastpickListing,
  FolderState,
  GitApi,
  LiveClaudeSession,
  AgentTurn,
  UsageReport,
  LogApi,
  PendingApproval,
  DispatchLine,
  OrchestratorAction,
  OrchestratorMessage,
  PairedDevice,
  PairingApi,
  PairingInvite,
  ProjectApi,
  PtyApi,
  PushApi,
  ScopeApi,
  SearchApi,
  ServerIdentity,
  SessionApi,
  SessionHit,
  ShellApi,
  SystemApi,
  WorkspaceHit,
  WorkspaceMetaApi,
  WorktreeApi,
  WorktreeEntry,
  WorktreeHold,
} from "../types";
import type { Project, Settings, Thread, TodoItem } from "$lib/types";
import type { CommitState, PrLookup } from "$lib/features/git/api";
import type { Platform, ShellOption } from "$lib/storage/platform.svelte";
import { Socket, type ConnState, type SocketOptions } from "./socket";

interface RawSession {
  id: string;
  modifiedMs?: number;
  title?: string | null;
  ownPid?: boolean;
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
    // Absent from a server too old to send it, which reads as "not confirmed"
    // and leaves the attribution guess in charge, exactly as before.
    ownPid: r.ownPid === true,
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
  readonly checkpoints: CheckpointApi;
  readonly project: ProjectApi;
  readonly system: SystemApi;
  readonly shell: ShellApi;
  readonly fastpick: FastpickApi;
  readonly codexSwitcher: CodexSwitcherApi;
  readonly fastMcpSsh: FastMcpSshApi;
  readonly kebaccSwitcher: KebaccSwitcherApi;
  readonly cli: CliApi;
  readonly scope: ScopeApi;
  readonly session: SessionApi;
  readonly search: SearchApi;
  readonly sync: SyncApi;
  readonly log: LogApi;
  readonly approvals: ApprovalsApi;
  readonly push: PushApi;
  readonly meta: WorkspaceMetaApi;
  readonly pairing: PairingApi;
  readonly conduct: ConductApi;

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
    options: SocketOptions = {},
  ) {
    const socket = new Socket(url, token, onState, onAuthRejected, options);
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
      // Its own RPC rather than `sendInput`, and that is the point rather than a
      // detail: the input frame carries arbitrary bytes, this carries a token
      // the server parses against a closed vocabulary before anything reaches a
      // PTY. It also takes a thread id directly, so a device that never attached
      // to this terminal can still answer its dialog.
      reply: (threadId, answer) =>
        rpc("thread.reply", { threadId, answer }).then(() => {}),
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
      // Reachable, and unused on this path: the server watches its own PTYs and
      // writes the mark itself. A client that called it would be claiming
      // runtime state it does not own.
      markThreadStarted: (id) => rpc("thread.started", { threadId: id }).then(() => {}),
      setThreadSettled: (id, status, settled) =>
        rpc("thread.settle", { threadId: id, status, settled }).then(() => {}),
      deleteThread: (id) => rpc("thread.delete", { threadId: id }).then(() => {}),
      loadSettings: () =>
        rpc("settings.get").then((r) => (r.settings ?? {}) as Partial<Settings>),
      saveSettings: (s) => rpc("settings.set", { settings: s }).then(() => {}),
      loadTodos: () => rpc("todo.list").then((r) => (r.todos ?? []) as TodoItem[]),
      saveTodo: (todo) => rpc("todo.save", { todo }).then(() => {}),
      deleteTodo: (id) => rpc("todo.delete", { todoId: id }).then(() => {}),
    };

    this.approvals = {
      list: () =>
        rpc("approval.list").then((r) => (r.approvals ?? []) as PendingApproval[]),
      decide: (id, allow) =>
        rpc("approval.decide", { id, allow }).then(
          (r) => (r.decided ?? null) as PendingApproval | null,
        ),
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
      // A failure here used to borrow `known: false`, which is the repository
      // saying it has never seen the sha, and the chip drew "not pushed" over a
      // commit that was on the remote. The shape is still filled in, since the
      // caller needs a `short` to render at all, but it carries the reason with
      // it, and `known: false` goes back to meaning what git means by it.
      commitState: (path, sha) =>
        rpc("git.commitState", { path, sha })
          .then((r) => r.state as CommitState)
          .catch(
            (): CommitStateAnswer => ({
              known: false,
              pushed: false,
              short: sha.slice(0, 7),
              subject: null,
              branch: null,
              unreachable: true,
            }),
          ),
      // `unavailable` is no gh and no GitHub remote: nothing to report and
      // nothing to fix. A transport that never asked has both still to find
      // out, and `failed` is the kind that already exists for it.
      pullRequest: (path, branch) =>
        rpc("git.pullRequest", { path, branch })
          .then((r) => (r.lookup ?? { kind: "unavailable" }) as PrLookup)
          .catch(
            (err): PrLookup => ({ kind: "failed", auth: false, detail: String(err) }),
          ),
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
        rpc("worktree.open", { repo, threadId }).then((r) => ({
          path: (r.path as string) ?? null,
          dirty: (r.dirty ?? []) as string[],
          more: Boolean(r.more),
        })),
      warm: (repo) => rpc("worktree.warm", { repo }).then(() => {}),
      migrate: (repo, threadId, from) =>
        rpc("worktree.migrate", { repo, threadId, from }).then((r) => ({
          path: (r.path as string) ?? null,
          gone: Boolean(r.gone),
        })),
      adopt: (repo, threadId) =>
        rpc("worktree.adopt", { repo, threadId }).then((r) => (r.path as string) ?? null),
      list: (repo) =>
        rpc("worktree.list", { repo }).then((r) => (r.worktrees ?? []) as WorktreeEntry[]),
      claim: (path, name) => rpc("worktree.claim", { path, name }).then(() => {}),
      reserve: (path, name) => rpc("worktree.reserve", { path, name }).then(() => {}),
      hold: (path) => rpc("worktree.hold", { path }).then((r) => r as WorktreeHold),
      remove: (repo, path, force) =>
        rpc("worktree.remove", { repo, path, force }).then(() => {}),
      sizes: (paths) =>
        rpc("worktree.sizes", { paths }).then((r) => (r.sizes ?? []) as number[]),
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
      // The bytes cross as base64 in the JSON reply, which is what the desktop
      // already hands the page: no binary frame was ever needed, so a PDF or an
      // image in a pane on a remote workspace stopped being a blank frame the
      // moment the server grew the same command.
      readBase64: (path) => rpc("file.readBase64", { path }).then((r) => r.base64 as string),
    };

    this.checkpoints = {
      capture: (repo, threadId, edge) =>
        rpc("checkpoint.capture", { repo, threadId, edge }).then(
          (r) => r as unknown as Checkpoint | null,
        ),
      list: (repo, threadId) =>
        rpc("checkpoint.list", { repo, threadId }).then((r) => r.checkpoints as Checkpoint[]),
      diff: (repo, from, to, patch) =>
        rpc("checkpoint.diff", { repo, from, to, patch }).then(
          (r) => r as unknown as CheckpointDiff,
        ),
      fileVersions: (repo, from, to, file) =>
        rpc("checkpoint.fileVersions", { repo, from, to, file }).then(
          (r) => r as unknown as CheckpointFileVersions,
        ),
      restore: (repo, threadId, sha) =>
        rpc("checkpoint.restore", { repo, threadId, sha }).then(() => {}),
      forget: (repo, threadId) =>
        rpc("checkpoint.forget", { repo, threadId }).then(() => {}),
    };

    this.project = {
      inspect: (path) => rpc("project.inspect", { path }),
      homeDir: () => rpc("project.homeDir").then((r) => r.path as string),
      folderState: (path) =>
        rpc("project.folderState", { path }).then((r) => r as unknown as FolderState),
      createFolder: (path) => rpc("project.createFolder", { path }).then(() => undefined),
    };

    // The boite's OS, not the phone's. "unknown" is the boite answering and
    // being none of the three. A call that got no answer rejects: it used to
    // resolve "unknown" as well, so a dropped frame and a machine nobody
    // recognises arrived as the same word, and `hostKnown` could not tell the
    // caller which of the two it was holding.
    this.system = {
      platform: () =>
        rpc("system.platform").then((r) => {
          const os = r.platform as string;
          return os === "windows" || os === "macos" || os === "linux"
            ? (os as Platform)
            : ("unknown" as Platform);
        }),
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

    this.codexSwitcher = {
      list: () =>
        rpc("codexSwitcher.list", {}).then((r) => JSON.parse(r.json as string) as CodexSwitcherList),
      save: () => rpc("codexSwitcher.save", {}),
      activate: (accountId) => rpc("codexSwitcher.activate", { accountId }),
      version: () =>
        rpc("codexSwitcher.version", {}).then((r) => (r.version as string | null) ?? null),
    };

    this.fastMcpSsh = {
      version: () =>
        rpc("fastMcpSsh.version", {}).then((r) => (r.version as string | null) ?? null),
    };

    this.kebaccSwitcher = {
      list: (provider) =>
        rpc("kebaccSwitcher.list", { provider: provider ?? null }).then(
          (r) => JSON.parse(r.json as string) as KebaccSwitcherList,
        ),
      add: (provider) =>
        rpc("kebaccSwitcher.add", { provider }).then(
          (r) => JSON.parse(r.json as string) as KebaccSwitcherList,
        ),
      switchTo: (provider, email) =>
        rpc("kebaccSwitcher.switch", { provider, email }).then(
          (r) => JSON.parse(r.json as string) as KebaccSwitcherList,
        ),
      version: () =>
        rpc("kebaccSwitcher.version", {}).then((r) => (r.version as string | null) ?? null),
    };

    // Installed on the machine the threads spawn on, which is this server. A
    // phone asking for an install is asking the server to fetch a Linux binary
    // for itself, and the progress it reads back is the server's.
    this.cli = {
      catalog: (probeVersions) =>
        rpc("cli.catalog", { probeVersions: probeVersions ?? false }).then(
          (r) => (r.clis as CliRow[] | null) ?? [],
        ),
      latest: () => rpc("cli.latest", {}).then((r) => (r.latest as CliLatest[] | null) ?? []),
      jobs: () => rpc("cli.jobs", {}).then((r) => (r.jobs as CliJob[] | null) ?? []),
      dataPaths: (id) =>
        rpc("cli.dataPaths", { id }).then((r) => (r.paths as CliDataPath[] | null) ?? []),
      install: (id) => rpc("cli.install", { id }).then((r) => r.job as CliJob),
      uninstall: (id, purgeData) =>
        rpc("cli.uninstall", { id, purgeData }).then((r) => r.job as CliJob),
      cancel: (id) => rpc("cli.cancel", { id }).then((r) => r.cancelled as boolean),
      dismiss: (id) => rpc("cli.dismiss", { id }).then(() => undefined),
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
      // empty report used to stand in for a read that never happened, and the
      // calendar drew a full year of empty squares as though the machine had
      // never run anything. The empty report is still what comes back, because
      // the caller's own catch would flatten a rejection into one anyway, but
      // it now says which of the two it is.
      usage: (cwds, days, orchestratorSessions) =>
        rpc("session.usage", { cwds, days, orchestratorSessions: orchestratorSessions ?? [] })
          .then((r) => r as unknown as UsageReport)
          .catch(
            (): UsageReport => ({
              models: [],
              days: [],
              sessions: 0,
              orchestratorTotal: 0,
              orchestratorSessions: 0,
              missing: [],
              unreachable: true,
            }),
          ),
      // ptyId names a PTY the server owns, so it resolves the pid on its side.
      // An older server ignores the extra param and keeps skipping every live
      // session, which is the behaviour it had before.
      find: (kind, cwd, afterUnixMs, excludeIds, ptyId) =>
        rpc("session.find", { kind, cwd, afterUnixMs, excludeIds, ptyId: ptyId ?? null }).then(
          (r) => normalizeSession(r.session),
        ),
      // The agents run on the server, so that is where the registry lives. An
      // empty list is a machine with nothing open; a call that failed rejects,
      // and the caller writes a line about the check it did not get rather than
      // launching on an answer nobody gave.
      liveClaude: () =>
        rpc("session.liveClaude").then((r) => (r.sessions ?? []) as LiveClaudeSession[]),
      // The worst of them. `[]` is every agent on the machine having been asked
      // and having said nothing, which is what a status pass demotes on. One
      // dropped frame therefore reported an entire boite as idle. The poll
      // already keeps its last answer through a rejection, so this only had to
      // stop pretending.
      agentTurns: (queries) =>
        rpc("session.agentTurns", { queries }).then((r) => (r.turns ?? []) as AgentTurn[]),
      // `false` is a session nothing was holding. A stop that never reached the
      // boite is not that, and the caller is the one that gets to decide what
      // an unanswered stop costs the launch behind it.
      stopClaude: (sessionId) =>
        rpc("session.stopClaude", { sessionId }).then((r) => Boolean(r.stopped)),
      // `true` replays the id, which is still what the caller does with a
      // rejection. The difference is that the guess is now made in the open,
      // one level up, instead of being dressed as copilot's own answer.
      copilotResumable: (sessionId) =>
        rpc("session.copilotResumable", { sessionId }).then((r) => r.resumable !== false),
      // The transcripts live next to the agents, so the server does the copy.
      // `false` is a copy that was attempted and did not carry; a copy that was
      // never attempted rejects, and the move reports that the agent is coming
      // back without its conversation instead of doing it silently.
      migrate: (kind, sessionId, fromCwd, toCwd) =>
        rpc("session.migrate", { kind, sessionId, fromCwd, toCwd }).then((r) =>
          Boolean(r.migrated),
        ),
    };

    this.search = {
      query: (text, limit) =>
        rpc("search.query", { q: text, limit }).then(
          (r) => (r.hits ?? []) as WorkspaceHit[],
        ),
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

    // Failures answer empty rather than rejecting: this is fanned out over
    // every connected environment, and one boite being down must not cost the
    // caller the hits the others found.
    this.search = {
      query: (q, limit = 20) =>
        rpc("search.query", { q, limit })
          .then((r) => (r.hits ?? []) as WorkspaceHit[])
          .catch(() => [] as WorkspaceHit[]),
    };

    // Runs on the machine the threads spawn on, which is this server. A phone
    // asking to sync is asking the server to read its own ~/.claude and use its
    // own git credentials, and the merge tool the phone draws decides the
    // server's files. The same rule the CLI surface follows.
    this.sync = {
      sources: () =>
        rpc("sync.sources").then((r) => ((r.sources ?? []) as SyncSource[])),
      status: () => rpc("sync.status").then((r) => r as unknown as SyncStatus),
      probe: (remoteUrl) =>
        rpc("sync.probe", { remoteUrl }).then((r) => r as unknown as SyncProbe),
      pull: () =>
        rpc("sync.pull").then((r) => ((r.conflicts ?? []) as SyncConflict[])),
      conflicts: () =>
        rpc("sync.conflicts").then((r) => ((r.conflicts ?? []) as SyncConflict[])),
      resolve: (path, content) =>
        rpc("sync.resolve", { path, content }).then((r) => r as unknown as SyncJob),
      skip: (path) => rpc("sync.skip", { path }).then((r) => r as unknown as SyncJob),
      push: () => rpc("sync.push").then((r) => r as unknown as SyncJob),
      cancel: () => rpc("sync.cancel").then((r) => Boolean(r.cancelled)),
      dismiss: () => rpc("sync.dismiss").then(() => {}),
      repair: () => rpc("sync.repair").then(() => {}),
    };

    this.push = {
      publicKey: () => rpc("push.publicKey").then((r) => (r.key as string) ?? null),
      subscribe: (sub) => rpc("push.subscribe", sub).then(() => {}),
      unsubscribe: (endpoint) => rpc("push.unsubscribe", { endpoint }).then(() => {}),
    };

    const readMeta = (
      r: { name?: unknown; color?: unknown; version?: unknown } | undefined,
    ) => ({
      name: typeof r?.name === "string" ? r.name : null,
      color: typeof r?.color === "string" ? r.color : null,
      // Absent on a boite older than this field: unknown, not empty.
      version: typeof r?.version === "string" && r.version ? r.version : null,
    });
    this.meta = {
      get: () => rpc("workspace.info").then(readMeta),
      set: (patch) => rpc("workspace.setInfo", patch).then(readMeta),
    };

    // The generic RPC arm answers for the conduct domain; only `pulse` needs a
    // ceiling of its own, set in RPC_TIMEOUTS above the server's 120 s wait.
    // A pulse torn by a reconnect rejects like any other in-flight call, and
    // the caller's loop asks again with the cursor it already holds.
    this.conduct = {
      record: (moment) => rpc("conduct.record", moment).then((r) => ({ seq: (r?.seq as number) ?? 0 })),
      pulse: (params) => rpc("conduct.pulse", params),
      post: (params) =>
        rpc("orchestrator.post", params).then((r) => ({
          messageId: (r?.messageId as string) ?? "",
        })),
      messages: (params) =>
        rpc("orchestrator.messages", params).then(
          (r) => (r?.messages ?? []) as OrchestratorMessage[],
        ),
      start: (params) =>
        rpc("orchestrator.start", params).then((r) => ({
          threadId: (r?.threadId as string) ?? "",
        })),
      status: (params) =>
        rpc("orchestrator.status", params).then((r) => ({
          threadId: (r?.threadId as string | null) ?? null,
          state: (r?.state as string) ?? "off",
        })),
      actions: (params) =>
        rpc("orchestrator.actions", params).then(
          (r) => (r?.actions ?? []) as OrchestratorAction[],
        ),
      undo: (params) =>
        rpc("orchestrator.undo", params).then((r) => ({
          done: r?.done === true,
        })),
      acceptDispatch: (params) =>
        rpc("thread.acceptDispatch", params).then((r) => ({
          threadId: (r?.threadId as string) ?? params.threadId,
          accept: (r?.accept as boolean) ?? params.accept,
          dropped: (r?.dropped as number) ?? 0,
        })),
      drainDispatches: (params) =>
        rpc("dispatch.drain", params).then(
          (r) => (r?.dispatches ?? []) as DispatchLine[],
        ),
      settleDispatch: (params) =>
        rpc("dispatch.settle", params).then((r) => ({
          settled: r?.settled === true,
        })),
      transcribe: (params) =>
        rpc("voice.transcribe", params).then((r) => ({
          text: (r?.text as string) ?? "",
        })),
    };

    this.pairing = {
      list: () => rpc("pairing.list").then((r) => (r.pairings ?? []) as PairedDevice[]),
      invite: (options) => rpc("pairing.create", options).then((r) => r as PairingInvite),
      revoke: (id) => rpc("pairing.revoke", { id }).then((r) => r.revoked === true),
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

  // Which build is running over there, and on what. Read during the handshake,
  // so it is in place before `connectionState` says "connected" and a reader
  // keyed on that flag never sees a connected boite with no identity. Null
  // until the first handshake completes, and again if `hello` failed.
  get serverIdentity(): ServerIdentity | null {
    return this.#socket.serverIdentity;
  }

  // Jump the backoff queue. Driven by the retry button in the connection banner.
  retryNow(): void {
    this.#socket.retryNow();
  }

  /**
   * Ask a socket believed to be live whether it still is.
   *
   * `hello` and not a ping: it is the same round trip the handshake makes, it
   * carries the short ceiling, and an answer proves the boite is serving rather
   * than merely holding a TCP connection open. What a foregrounded app runs
   * before deciding it needs a new session.
   */
  probe(): Promise<ServerIdentity | null> {
    return this.#socket.rpc("hello").then(() => this.#socket.serverIdentity);
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

  answerAgentRequest(requestId: string, payload: Record<string, unknown>): Promise<void> {
    return this.#socket
      .rpc("agent.answerRequest", { requestId, payload })
      .then(() => {});
  }
}
