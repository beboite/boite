import type { CoreLogContext, CoreLogLevel, CoreLogRecord, CoreLogsQuery } from './diagnostics';
import type { ProviderId, Timestamp } from './ids';
import type { PROTOCOL_VERSION } from './index';
import type { Os } from './providers';
import type { TraceCapability } from './trace';

/**
 * Which install of Boite this is. `stable` is the app the user works in every
 * day; `dev` is a second install beside it, with its own identifier, its own
 * product name and its own data directory, so a beta build never overwrites
 * the stable one nor reads its journal.
 */
export type Channel = 'stable' | 'dev';

export interface CoreInfo {
  /** Display name reported by the execution host. */
  hostname?: string;
  version: string;
  /** SHA-256 of the loaded JavaScript entry bundle, captured before serving requests. */
  bundleHash?: string;
  protocolVersion: typeof PROTOCOL_VERSION;
  /** Optional optimizations. Their absence keeps older cores and clients interoperable. */
  features?: {
    threadSnapshots?: boolean;
    /** Answers a request that carries `progress` in counted slices (`RPC_CHUNK_MARK`). */
    chunkedAnswers?: boolean;
    /** `threads.get` takes `around` and `compactImages`; `messages.list` takes `after`. */
    readingPages?: boolean;
    /** Pages say where they sit (`messageOffset`, `offset`) and `messages.list` reads from a position (`from`). */
    messagePositions?: boolean;
    /** `threads.get` and `messages.list` take `compactToolParts`; `messages.toolPart` exists. No message is refused for its size then. */
    deferredToolParts?: boolean;
    /** A device of its group says hello with a signature of its own device key (`hello` `device`). */
    deviceKeys?: boolean;
    /** Prompt-free draft reservations and create-time subscription. */
    draftPreparation?: boolean;
    /** Connection-owned attachment uploads resolved by turns.start. */
    attachmentUploads?: boolean;
    /** `ui.reveal` takes `coreId` on a thread or an agent target and opens it on that machine. An older core drops the field and opens this core's. */
    revealMachines?: boolean;
    /** A load sample reaches a client whose hello `accepts` `thread.load` as that event alone, not as a whole `thread.updated` row. */
    loadEvents?: boolean;
    /** `core.desktopUpdateReport`, `core.desktopUpdateStatus` and `core.updateEverything` `app`: the desktop app of this machine updates on another machine's click. */
    desktopUpdates?: boolean;
    /** `subscriptionProxy.movePlan` and `subscriptionProxy.move`: this machine's logins move into Douane. */
    gatewayMove?: boolean;
    /** `todos.update` takes `goalThreadId`, a card carries its goal, and a paired device reads and moves cards: the project board. */
    projectBoard?: boolean;
    /** Shared-project version 1 RPCs and scoped invalidations; absent until all enforcing handlers exist. */
    sharedProjects?: 1;
    /** contacts.sendHuman preserves a contact's human provenance without owner authority. */
    contactHumanLetters?: 1;
    /** `group.settingsHome` and `Group.settingsHome`: one member's settings, chosen for the whole group, that the others follow. */
    settingsHome?: boolean;
  };
  /** The fingerprint of this core's identity key: the id its group knows it by, and the one a device signs its hello for. */
  coreId?: string;
  os: Os;
  /** The install this core belongs to. `--channel` on its command line decides. */
  channel: Channel;
  pid: number;
  startedAt: Timestamp;
  /** Bind address, possibly a wildcard. `pairing.grant` gives the link a phone opens. */
  endpoint: { host: string; port: number };
  dataDir: string;
  trace: TraceCapability;
}

/** The server on one machine, independently of the desktop application's updater. */
export interface ServerUpdateStatus {
  mode: 'systemd' | 'docker' | 'manual';
  phase: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'waiting' | 'installing' | 'error';
  currentVersion: string;
  version: string | null;
  channel: 'stable' | 'nightly';
  publishedAt: string | null;
  checkedAt: Timestamp | null;
  received: number;
  total: number | null;
  error: string | null;
}

/**
 * The desktop app's updater on the machine whose core this is, as that
 * machine's own window reported it. Only the window drives the installer, so
 * the core keeps the last report and nothing more.
 */
export interface DesktopUpdateStatus {
  phase: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'waiting' | 'installing' | 'error';
  currentVersion: string;
  version: string | null;
  channel: 'stable' | 'nightly';
  received: number;
  total: number | null;
  error: string | null;
}

/** What `core.updateEverything` started on its machine. */
export interface UpdateEverythingResult {
  /** The agents whose update started, or was already under way. */
  agents: ProviderId[];
  /** Each agent named that did not start, with the core's reason. */
  failed: { providerId: ProviderId; message: string }[];
  /** Boite's own updater once the request is in: downloading, or as it was when `server` was null. */
  server: ServerUpdateStatus;
  /** Why Boite's own release did not start, null when it did or was not asked for. */
  serverError: string | null;
  /** The desktop app's updater as its window last reported it; absent from a core without `desktopUpdates`. */
  app?: DesktopUpdateStatus | null;
  /** Why the desktop app's release was not handed to its window, null when it was or was not asked for. */
  appError?: string | null;
}

export interface CoreRpcMethods {
  'core.logs': { params: CoreLogsQuery; result: CoreLogRecord[] };
  'core.shutdown': { params: Record<string, never>; result: { ok: true } };
  /** Owner only. Stop the way an update does, each running turn ending its tool call first, for the next core to resume; the desktop shell starts that core again. */
  'core.restart': { params: Record<string, never>; result: { ok: true } };
  'core.updateStatus': { params: { refresh?: boolean }; result: ServerUpdateStatus };
  /** Confirm the version shown to the owner so a stale dialog cannot install another release. */
  'core.updateInstall': { params: { version: string }; result: ServerUpdateStatus };
  'core.updateCancel': { params: Record<string, never>; result: ServerUpdateStatus };
  /**
   * Owner only. One click's worth of updates on this machine: every agent in
   * `agents` starts its update the way `providers.update` does, and Boite's
   * own release, when `server` names the version the client showed, starts
   * downloading at once. That release installs only once the agent updates
   * are done and the core is idle, so no updater is cut off by the restart.
   * Answers as soon as everything has started; progress arrives as
   * `providers.updatesChanged` and `core.updateChanged`. One part failing
   * leaves the others running. `app` names the desktop app's offered
   * release: once the agents named here finished, the core hands it to this
   * machine's own window, which installs it and restarts; `appError` says
   * when no window is open to do it.
   */
  'core.updateEverything': { params: { agents: ProviderId[]; server: string | null; app?: string | null }; result: UpdateEverythingResult };
  /**
   * Owner only, and only from this machine's own desktop window (the core
   * token on loopback): its updater's state, sent again on every change. A
   * paired device or another member of the group has no installer here to
   * speak for, so it is refused. Kept until that window's socket closes.
   */
  'core.desktopUpdateReport': { params: { status: DesktopUpdateStatus }; result: { ok: true } };
  /** Owner only. The desktop app's updater on this machine, null when no window of it is connected. */
  'core.desktopUpdateStatus': { params: Record<string, never>; result: DesktopUpdateStatus | null };
}

export interface CoreRpcEvents {
  'core.log': { level: CoreLogLevel; message: string; at: Timestamp } & CoreLogContext;
  'core.updateChanged': ServerUpdateStatus;
  /** Owner connections only: this machine's desktop updater as its window reported it, null once that window left. */
  'core.desktopUpdateChanged': { status: DesktopUpdateStatus | null };
}
