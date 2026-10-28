import type { BrowserProfile } from './browser';
import type { AccountId, ProviderId, RequestId } from './ids';
import type { ClientPreferences, ExperimentId, SettingAsk, SettingRequestParams } from './setting-requests.ts';
import type { AutoCompact, CacheKeepalive } from './settings-validation.ts';
import type { SubscriptionProxy } from './subscription-proxy';
import type { ThreadSummary } from './threads';

export type CompactionTarget = 'agent' | 'subagent' | 'bot';

/** A complete override; removing the target restores the current common defaults. */
export interface CompactionPolicy {
  autoCompact: AutoCompact | null;
  backgroundCompaction: boolean;
}

/** Children take precedence, including children started by a resident bot. */
export function effectiveCompaction(settings: Pick<Settings, 'autoCompact' | 'backgroundCompaction' | 'compactionByType'>, thread: Pick<ThreadSummary, 'parentThreadId' | 'agentSessionId'>): CompactionPolicy {
  const target: CompactionTarget = thread.parentThreadId ? 'subagent' : thread.agentSessionId ? 'bot' : 'agent';
  return settings.compactionByType?.[target] ?? {
    autoCompact: settings.autoCompact ?? null,
    backgroundCompaction: settings.backgroundCompaction === true,
  };
}

/** Per-core consent. Installation identifiers never cross RPC. */
export interface TelemetryState {
  mode: 'off' | 'basic' | 'enhanced';
  configured: boolean;
  pendingDeletion: boolean;
}

export const DEFAULT_THREAD_DONE_RETENTION_DAYS = 3;
export const DEFAULT_THREAD_DELETION_RETENTION_DAYS = 30;

/** A recoverable conversation, with the time its whole family was deleted. */
export interface DeletedThreadSummary extends ThreadSummary {
  deletedAt: number;
}

export interface Settings {
  /** Routes Claude and Codex through this machine's optional subscription gateway. */
  subscriptionProxy?: SubscriptionProxy | null;
  /** Subscription priority shared by this core's clients and tray. Account ids stay on their owning machine. */
  quotaOrder?: AccountId[];
  /** Days after deletion before history is purged. 0 keeps it indefinitely. Missing means 30. */
  threadDeletionRetentionDays?: number;
  /** Days after marking done before deletion. 0 disables it. Missing means 3. */
  threadDoneRetentionDays?: number;
  /** New worktrees only. Missing means project mode; existing checkouts keep their path. */
  worktreeStorage?: WorktreeStorage;
  /** Exact browser origins allowed to connect alongside the shell and this core's own origin. */
  browserOrigins?: string[];
  /**
   * The browser profiles the user made on this machine's desktop, each its own
   * cookies and logins. The built-in `default` and `private` are not listed.
   */
  browserProfiles?: BrowserProfile[];
  /** The profile a new browser tab opens in. Missing or unknown means `default`; never `private`. */
  browserDefaultProfile?: string;
  /** HTTPS origin served by the reverse proxy, used in phone pairing links. */
  publicUrl?: string | null;
  /** Minutes a Claude process stays warm after a turn. 0 releases it at once. */
  warmProcessMinutes: number;
  /** Bind the RPC to every interface so a phone on the LAN can pair. */
  listenOnLan: boolean;
  /**
   * Hard CPU ceiling for every agent process together, as a percentage of the
   * whole machine. 0 disables the cap. Windows only: it is the global job's
   * CPU rate control, and other systems ignore it.
   */
  agentCpuCapPercent: number;
  /** Share of physical RAM for all agents, an integer from 10 to 90. Default 60. */
  agentMemoryBudgetPercent: number;
  /**
   * Memory ceiling for one thread's whole process tree, in megabytes. 0 means
   * half the effective budget, rounded down to 256 MB. An explicit cap cannot
   * exceed the budget. The kernel safety net sits 10% above this quota on Windows.
   */
  threadMemoryCapMb: number;
  /** Memory kept available in MB. 0 uses 10% of RAM or 3 GB; below 12 GB, it uses 25% of RAM. */
  memoryReserveMb: number;
  /** Automatic memory stops and Windows allocation caps. Missing means enabled. */
  memoryProtection?: boolean;
  /**
   * Windows of agent processes never keep the foreground: one that takes it is
   * sent to the bottom without activation and the window the user was on gets
   * the focus back. Windows only, ignored elsewhere.
   */
  focusGuard: boolean;
  /**
   * Audio sessions of agent processes are muted while they run, so a sound an
   * agent plays never reaches the user's speakers. The mute is undone when the
   * process exits. Windows only, ignored elsewhere.
   */
  muteAgents: boolean;
  /**
   * A process a thread left running after its turn, whose parent has exited, is
   * stopped once the thread has been idle for a few seconds: what an interrupted
   * or refused command started and nobody is left to stop. Windows only, where
   * the job reports grandchildren. Missing on older cores, which read as on.
   */
  reapOrphans?: boolean;
  /**
   * The core updates its agents by itself: checked ten minutes after start,
   * or six hours after the reading kept from the last run when that is later,
   * then every six hours, each one updated once no turn of its provider is in
   * flight. It needs no client connected, which is how a server stays current.
   */
  autoUpdateHarnesses: boolean;
  /**
   * This computer's desktop app installs a release the six-hourly check found
   * by itself: it downloads it, then installs only while the window is in the
   * tray and the core grants an idle stop (no turn, queued turn or tracked
   * process); a busy machine tries again at the next check. The new app comes
   * back in the tray. Followed from the group's default machine. Missing reads
   * as off.
   */
  autoInstallUpdates?: boolean;
  /**
   * Agents without asynchronous questions of their own are told about
   * `boite ask` at the start of a session, so they can ask without stopping.
   * Missing on older cores, which read as on.
   */
  asyncQuestions?: boolean;
  /**
   * Every normal turn asks the agent to work silently and answer short:
   * no text between tool calls, result first, no preamble or recap. Claude
   * also starts without its own progress reminder. Missing reads as on.
   */
  shortAnswers?: boolean;
  /**
   * Claude writes a one-line summary of each batch of tool calls, which the
   * timeline shows in place of the counted calls. Each summary is one request
   * to Claude's small model, billed to the thread's account. Applies when a
   * Claude process starts. Missing reads as off.
   */
  toolSummaries?: boolean;
  /**
   * Agents may read this machine's anonymized diagnostics and draft an issue
   * from them (`boite logs`, `boite issue`). Missing reads as on.
   */
  agentLogAccess?: boolean;
  /**
   * The model that writes every thread's title after its first answer. Null
   * or missing: each thread's own provider on its small model
   * (`defaultTitleModel`), under the thread's account. A provider that can no
   * longer write one falls back to that too.
   */
  titleModel?: TitleModel | null;
  /**
   * The model that writes and checks every `/goal2` checklist. Null or
   * missing: `GOAL_TRACKER_DEFAULTS`, else the conversation's own model.
   */
  goalTracker?: GoalTrackerModel | null;
  /**
   * Independent token limit and idle moments for automatic compaction. The
   * limit reaches native tool boundaries where supported. Null or missing
   * leaves each agent's own behaviour. Missing on older cores.
   */
  autoCompact?: AutoCompact | null;
  /**
   * Experimental: as a thread nears its `autoCompact` token limit, a forked
   * copy of its session compacts in the background while the conversation
   * goes on; at its first pause after the copy is done, the thread swaps to it
   * and its next prompt carries the turns since the fork (docs/context.md, "Background
   * compaction"). OpenCode V2 gets its own `experimental.background_compaction`.
   * Missing reads as off.
   */
  backgroundCompaction?: boolean;
  /** Complete policies per thread type. Missing targets follow the live common defaults. */
  compactionByType?: Partial<Record<CompactionTarget, CompactionPolicy>>;
  /**
   * Experimental: while a thread of the user's waits on its delegated agents
   * or workflows, the core sends a minimal turn before its prompt cache lapses
   * so their result is read from the cache (`docs/prompt-cache.md`). Null or
   * missing: off. Missing on older cores.
   */
  cacheKeepalive?: CacheKeepalive | null;
  /**
   * The models the user starred, one list for all of the owner's machines:
   * each client keeps the newest one it saw by `at` and writes it to every
   * machine it controls. Missing on older cores and before the first star.
   */
  modelFavorites?: ModelFavorites;
  /**
   * A turn that failed on a subscription usage limit resumes by itself once
   * that limit's window resets: one new turn per window and thread, with a
   * short continue prompt (docs/usage.md). Missing reads as off.
   */
  autoResumeLimitedThreads?: boolean;
  /**
   * The Device panel shows an Android device as live H.264 video and drives it
   * with real touches, Unicode text and the clipboard, through a scrcpy server
   * the core pushes to the device (docs/devices.md, "Live stream"). Off, the
   * panel polls screenshots and `adb shell input`. Missing reads as off.
   */
  deviceStream?: boolean;
  /**
   * Apps `boite window` never captures, beside `WINDOW_CAPTURE_EXCLUDED`:
   * executable names (`Signal.exe`) or full paths, matched without case
   * (docs/windows.md). Missing reads as none.
   */
  windowCaptureExclusions?: string[];
  /**
   * Agents on the other machines of this machine's group may start threads
   * here (`boite thread new --machine`), in its projects, as their own agent
   * would from this machine. Each machine decides for itself. Missing reads as off.
   */
  groupThreads?: boolean;
  /**
   * The bots of the other machines of this machine's group may look after the
   * projects here their owner entrusted to them: list their threads, read and
   * steer them, answer their questions, archive, stop or rename them, and hear
   * their events. Never delete them, decide tool permissions or change this
   * machine's settings. Turned off, every such access ends at once. Each
   * machine decides for itself. Missing reads as off.
   */
  groupBots?: boolean;
  /**
   * While this machine follows its group's settings home, what it keeps for
   * itself (`SyncKey`): each entry was changed here and the copy skips it.
   * Missing or empty: everything synced follows. Clients write it; the core
   * reads it to leave those keys out of `settings.follow`.
   */
  syncOverrides?: string[];
}

/** One starred model. Accounts are named by label: an id means nothing on another machine. */
export interface ModelFavorite {
  providerId: ProviderId;
  model: { id: string; name: string };
  /** The label of the account it was starred under. Missing: the account the picker uses for that provider. */
  account?: string;
}

/** The starred models, with the time they last changed. */
export interface ModelFavorites {
  /** Milliseconds since the epoch of the last change: between two lists, the later one wins. */
  at: number;
  /** At most `MODEL_FAVORITES_MAX`, each provider, model and account once. */
  items: ModelFavorite[];
}

export type WorktreeStorage =
  | { mode: 'project'; directory: string | null }
  | { mode: 'shared'; directory: string };

/** One provider's model, picked in Settings to write thread titles. */
export interface TitleModel {
  /** A provider whose summary says `titles`. */
  providerId: ProviderId;
  /** A model id that provider lists. */
  model: string;
}

/** One provider's model and reasoning level, picked in Settings, General to keep `/goal2` checklists. */
export interface GoalTrackerModel {
  providerId: ProviderId;
  model: string;
  /** One of the model's levels; null for a model without them. */
  effort: string | null;
}

export interface SettingsRpcMethods {
  /**
   * A settings card on the agent's thread (`boite settings request|open`),
   * asked without stopping like `questions.ask`, with `reason` as its text.
   * With `key` and `value` it proposes a change: refused for a key outside
   * `REQUESTABLE_SETTINGS` (naming them), a value `settings.set` would refuse,
   * the value already set, or a card already open on that key in the thread.
   * The card settles when the setting changes, through Apply or the page; the
   * agent reads `applied`, `changed` or `refuse`. With `page` it points at a
   * page and the agent reads `open` or `refuse`.
   */
  'settings.request': {
    params: SettingRequestParams;
    result: { questionId: RequestId; setting: SettingAsk };
  };

  'telemetry.state': { params: Record<string, never>; result: TelemetryState };
  /** countChoice reports this explicit selection anonymously, including off. Missing: no choice report. */
  'telemetry.configure': { params: { mode: TelemetryState['mode']; countChoice?: boolean }; result: TelemetryState };
  'telemetry.export': { params: Record<string, never>; result: Record<string, unknown> };
  'telemetry.retryForget': { params: Record<string, never>; result: TelemetryState };
  'settings.get': { params: Record<string, never>; result: Settings };
  'settings.set': { params: Partial<Settings>; result: Settings };
  /**
   * The copy from the group's settings home (`Group.settingsHome`): only the
   * synced settings this machine does not keep (`syncOverrides`) at the moment
   * it writes, so a change saved here meanwhile from another window stays.
   * Comes with `features.settingsHome`. Owner only.
   */
  'settings.follow': { params: { patch: Partial<Settings> }; result: Settings };
  /**
   * The app says its language, the experiments it has on and the names it
   * gives settings, after each hello and on every change. Agents read them
   * from the app the user last used (`agent.settings`), and a card about an
   * experiment settles when that app reports it changed. `desktop` is what
   * `client.desktopExperiments` last said, null before any desktop app
   * reported: a phone follows the computer's switches from its first hello.
   */
  'client.preferences': { params: ClientPreferences; result: { ok: true; desktop: ExperimentId[] | null } };
}

export interface SettingsRpcEvents {
  /** The whole settings object, as `settings.set` wrote it. */
  'settings.updated': Settings;
  /**
   * The experiments of the desktop app this core follows, once its report
   * changes them: the app on this machine's loopback, else the last desktop
   * app to report from elsewhere. Kept in memory, like the reports.
   */
  'client.desktopExperiments': { experiments: ExperimentId[] };
}
