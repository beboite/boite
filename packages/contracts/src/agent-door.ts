import type { ContextPreset, ContextRequest } from './context-mode';
import type { AgentAddress } from './coordination';
import type { ProjectId, ProviderId, ThreadId, TurnId } from './ids';
import type { SettingsReading } from './setting-requests.ts';
import type { ThreadSummary } from './threads';

/**
 * Who a connection is. The owner said hello with the core token itself, which
 * only the shell, the tests and `boite-core pair` hold, or with the key of a
 * pairing whose role was `owner`; a session said hello with a token the core
 * minted for a `device` pairing; an agent said hello with the per-thread token
 * the core put in the environment of a process that thread launched, and is
 * held to `AGENT_METHODS` on that one thread. Minting grants and revoking
 * sessions are the owner's alone.
 */
export type Principal = 'owner' | 'session' | 'agent';

// ---------------------------------------------------------------------------
// The agent's door. Every process a thread launches carries these variables
// and the `boite` CLI on its PATH. The CLI says hello with the token, becomes
// the `agent` principal of that thread, and every call it makes names that
// thread: a call that names another one is refused.
// ---------------------------------------------------------------------------

export const AGENT_ENV = {
  threadId: 'BOITE_THREAD_ID',
  coreUrl: 'BOITE_CORE_URL',
  token: 'BOITE_AGENT_TOKEN',
} as const;

/** Where the agent is, as `agent.where` answers and the CLI prints it. */
export interface AgentWhere {
  threadId: ThreadId;
  title: string;
  projectId: ProjectId | null;
  projectPath: string | null;
  /** The thread's working directory: the project, or its worktree. */
  cwd: string;
  branch: string | null;
  worktree: boolean;
  providerId: ProviderId;
  model: string;
}

/** One project of `agent.projects`: what an agent names in `delegate spawn --project` or `thread move`. */
export interface AgentProject {
  id: ProjectId;
  name: string;
  path: string;
  /** The folder holds a `.git`: `--worktree` works there. */
  repository: boolean;
  /** The drafts project, where a thread gets a new folder of its own. */
  drafts: boolean;
  /** The calling thread's own project. */
  current: boolean;
}

/** The answer of `agent.addProject`: the project, and whether this call registered it. */
export interface AgentProjectAdded extends AgentProject {
  /** False when the folder was already a project; nothing changed then. */
  added: boolean;
}

/**
 * One end of `agent.spawn`. On the new thread's first prompt as `startedBy`
 * (the thread whose agent started it), and on a system line of the starting
 * thread as `started` (the thread it started).
 */
export interface ThreadLink {
  threadId: ThreadId;
  title: string;
  projectId: ProjectId;
  /** The project's name when the link was made. */
  project: string;
  /** The other machine of the group the thread is on, by its name, when it is not this one. */
  machine?: string;
}

/** What `agent.spawn` answers: the new thread, its first turn and how to reach its agent. */
export interface AgentSpawn {
  thread: ThreadSummary;
  turnId: TurnId;
  /** Its address for `collaboration.send`. */
  address: AgentAddress;
  /** The project's name. */
  project: string;
}

/** What `agent.move` answers: where the thread goes, and when. */
export interface AgentMove {
  threadId: ThreadId;
  projectId: ProjectId;
  /** The target project's name. */
  project: string;
  /** The target project's folder. */
  projectPath: string;
  /**
   * The folder the next turn starts in: known now for a plain project folder,
   * null while a turn runs and the move will make a worktree or a draft folder.
   */
  cwd: string | null;
  /** `turn-end`: a turn runs and the move waits for it to end. `done`: the thread moved on the spot. */
  when: 'turn-end' | 'done';
  /** Background work the agent left running stops when the move happens. */
  stopsBackground: boolean;
}

export interface AgentDoorRpcMethods {

  // -- The agent's own methods: the CLI, and the owner's UI behind the same surfaces.

  /** Where the calling thread is. */
  'agent.where': { params: { threadId: ThreadId }; result: AgentWhere };
  /**
   * The agent moves its own thread to another project, named by id, name or
   * folder. A process cannot change folder in the middle of a turn, so while
   * one runs the move waits for it to end (`when: 'turn-end'`), then goes
   * through what `threads.move` does; an idle thread moves on the spot. The
   * agent asked, so its next message carries no `MoveNotice` note: the thread
   * records a system message whose text part has `moved` with `by: 'agent'`.
   * Background work stops at the move. Refused for an unknown project, the
   * thread's own project, and every refusal of `threads.move` that already
   * holds when asked; one that only appears at the end of the turn is a system
   * message saying the move did not happen. A core restart before the turn
   * ends drops a waiting move.
   */
  'agent.move': { params: { threadId: ThreadId; project: string }; result: AgentMove };
  /**
   * The unarchived projects the owner added, the caller's own marked
   * `current`: the names `delegation.spawn` and `agent.move` accept.
   */
  'agent.projects': { params: { threadId: ThreadId }; result: AgentProject[] };
  /**
   * The settings an agent may ask about (`REQUESTABLE_SETTINGS`, then the
   * experiments of the app the user last used), each with its value, the page
   * it sits on and its name in that app, so it reads before it proposes. `app`
   * says which language the user reads Boite in.
   */
  'agent.settings': { params: { threadId: ThreadId }; result: SettingsReading };
  /**
   * The agent registers an existing folder as a project, as the owner does
   * from the sidebar, so `agent.spawn` and `agent.move` can name it. `path` is
   * absolute; `name` defaults to the folder's name. A folder that is already a
   * project answers it with `added: false` and changes nothing, an archived
   * one included. Refused under the same Communication settings as
   * `agent.spawn` across projects (off, paused, restricted to its own
   * project), for a
   * delegated child or a persistent agent session, and for a thread an agent
   * started until the user has written in it. The caller's timeline gets a
   * system line naming the project.
   */
  'agent.addProject': { params: { threadId: ThreadId; path: string; name?: string }; result: AgentProjectAdded };
  /**
   * The agent starts a new top-level thread in a project the owner added
   * (id, name or absolute folder), on its own provider, account, model,
   * effort and permission mode, and sends `prompt` as the first message,
   * marked `startedBy`. `worktree` puts it on a new branch of its own. The
   * new thread's first answer returns to the caller as an agent message.
   * Refused when the caller's coordination is off or paused, across projects
   * when it is restricted to its own, past an hourly budget (3 in Brief, 12 in
   * Team), for a delegated child or a persistent agent session, and for a
   * thread an agent started until the user has written in it. `requestId`
   * makes a retry return the same thread.
   *
   * `machine` (a member's name or core id prefix) starts it on another
   * machine of the caller's group, in a project named there, once that
   * machine's owner turned on `groupThreads`. The same gates apply on the
   * caller's side, and that machine across projects in every case.
   */
  'agent.spawn': { params: { threadId: ThreadId; project: string; prompt: string; title?: string; worktree?: boolean; context?: ContextRequest | ContextPreset; requestId: string; machine?: string }; result: AgentSpawn };
}
