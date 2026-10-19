import type { QuotaWindow } from './accounts';
import type { ProviderId, ThreadId, Timestamp } from './ids';

// ---------------------------------------------------------------------------
// Plugins: one manifest format, `boite-plugin.json`. The recommended ones ship
// inside the core; the owner adds others from a git URL. docs/plugins.md.
// ---------------------------------------------------------------------------

/** The file a plugin repository carries at its root. */
export const PLUGIN_MANIFEST_FILE = 'boite-plugin.json';
/** The one manifest schema this core reads. */
export const PLUGIN_MANIFEST_SCHEMA = 1;
/** `${process.platform}-${process.arch}` keys an artifact may be published for. */
export const PLUGIN_PLATFORMS = ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'] as const;
export type PluginPlatform = (typeof PLUGIN_PLATFORMS)[number];

/** One native executable, downloaded over https and checked against its digest. */
export interface PluginArtifact {
  url: string;
  /** Lowercase hex SHA-256 of the file at `url`. */
  sha256: string;
}

/** What Boite does with the executable: account pools, a desktop app, a gateway, or several. */
export interface PluginProvides {
  /** The executable answers the account pool commands for these providers. */
  accountPools?: { providers: ProviderId[] };
  /**
   * The executable is a desktop app the core starts with no arguments and
   * keeps running. It reaches the core with `BOITE_CORE_URL` and the owner
   * token in `BOITE_TOKEN`. No fields today.
   */
  desktopApp?: Record<string, never>;
  /**
   * The executable is a subscription gateway speaking Douane's runtime
   * contract: the core runs it in the background with `--config <file>` it
   * writes, on a loopback port, and the subscription proxy's local mode points
   * at it. No fields today.
   */
  gateway?: Record<string, never>;
}

/** Where a gateway plugin stands. Null on a plugin that provides no gateway. */
export interface PluginGatewayState {
  /** Whether the core runs it. True after a first install, kept across restarts and updates. */
  enabled: boolean;
  /**
   * Whether the core starts it when the core starts, whatever a stop left
   * `enabled` at. True after a first install. Absent from cores older than
   * `plugins.autostart`.
   */
  autostart?: boolean;
  /**
   * `starting`: launched and not answering `/health` yet, or waiting to start
   * again after a crash. `updating`: a newer release waits for the requests in
   * flight to end. `crashed`: it failed four times in five minutes; it waits
   * for the owner.
   */
  status: 'stopped' | 'starting' | 'running' | 'updating' | 'crashed';
  /** The loopback port it listens on, or will at its next start. */
  port: number;
  /** What its `/health` reported, once it answered. */
  version: string | null;
  pid: number | null;
  exitCode: number | null;
  /** Why it is not running, when Boite knows. Never its own output. */
  error: string | null;
  startedAt: Timestamp | null;
  /** Where its configuration, sign-ins and database live; an uninstall keeps them. */
  dataDir: string;
}

/** Where a desktop-app plugin stands. Null on a plugin that provides no desktop app. */
export interface PluginAppState {
  /** Whether the core starts the app. True after a first install, kept across restarts and updates. */
  enabled: boolean;
  /**
   * Whether the core starts the app when the core starts, whatever a stop
   * left `enabled` at. True after a first install. Absent from cores older
   * than `plugins.autostart`.
   */
  autostart?: boolean;
  /**
   * `stopped`: not running, after a stop, a clean exit or before the first start.
   * `crashed`: it failed four times in five minutes; it waits for the owner.
   * `unavailable`: this core cannot show a window; `error` says why.
   */
  status: 'stopped' | 'starting' | 'running' | 'crashed' | 'unavailable';
  pid: number | null;
  /** The last exit code, set after the app exits. */
  exitCode: number | null;
  /** Why the app is not running, when Boite knows. Never the app's own output. */
  error: string | null;
  startedAt: Timestamp | null;
}

/**
 * What `ui.reveal` shows in the owner's desktop window: a thread, an agent's
 * page, or the app updates in Settings. `agentId` is 1 to 200 characters.
 * `coreId` names the machine the thread or the agent lives on: another member
 * of this core's group or a machine trusted for coordination. Missing, or this
 * core's own id, means this core.
 */
export type UiRevealTarget =
  | { kind: 'thread'; threadId: ThreadId; coreId?: string }
  | { kind: 'agent'; agentId: string; coreId?: string }
  | { kind: 'update' };

export interface PluginManifest {
  schema: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  /** https page of the project, shown as its source link. */
  homepage: string;
  /** The file name Boite writes, `.exe` appended on Windows. */
  executable: string;
  artifacts: Partial<Record<PluginPlatform, PluginArtifact>>;
  provides: PluginProvides;
}

/** Where a plugin added from a URL came from. */
export interface PluginSource {
  /** The repository URL, as the core normalized it. */
  url: string;
  /** The branch, tag or commit asked for, `HEAD` when none was. */
  ref: string;
  /** The commit the manifest was read at. */
  commit: string;
}

/** A manifest the core refused, with the file, the field and what it expected. */
export interface PluginRejected {
  file: string;
  field: string;
  expected: string;
  message: string;
}

/**
 * Where a move sends the logins: the configured proxy's Douane (absent), or
 * `plugin`, the Douane plugin this core runs, whatever the proxy points at.
 */
export type GatewayMoveTarget = 'proxy' | 'plugin';

export interface PluginState {
  id: string;
  name: string;
  /** Shipped in the core's recommended list, or added by the owner from a git URL. */
  origin: 'recommended' | 'url';
  description: string;
  homepage: string | null;
  /** The version on disk, null while nothing is installed. */
  version: string | null;
  /** The version an install or an update brings. */
  availableVersion: string | null;
  status: 'not-installed' | 'installed' | 'installing' | 'error' | 'rejected';
  progress: number;
  error: string | null;
  /** Null for a recommended plugin. */
  source: PluginSource | null;
  /** What an install downloads on this machine, null when the manifest publishes nothing for it. */
  artifact: PluginArtifact | null;
  /** This machine's key, `win32-x64` and so on. */
  platform: string;
  /** The command lines Boite runs, `<pool>` and `<email>` standing for the values. */
  commands: string[];
  /** The providers whose account pools the plugin serves. */
  pools: ProviderId[];
  /** Set exactly when `status` is `rejected`. */
  rejected: PluginRejected | null;
  /** The desktop app the plugin provides, null when it provides none. */
  app: PluginAppState | null;
  /** The gateway the plugin provides, null when it provides none. Absent from cores older than gateway plugins. */
  gateway?: PluginGatewayState | null;
  /**
   * Where Boite looks for this recommended plugin's newer releases, and what
   * it last found there. Null when its entry names no update source. Absent
   * from cores older than update sources.
   */
  updates?: PluginUpdates | null;
}

/**
 * A recommended plugin's update source and its last check. The source is the
 * reviewed list's, never the plugin's own: docs/plugins.md, Updating.
 */
export interface PluginUpdates {
  /** The https repository and the ref whose `boite-plugin.json` is read. */
  source: { url: string; ref: string };
  /** A check is running now. */
  checking: boolean;
  /** When the last check finished, successful or not. */
  checkedAt: Timestamp | null;
  /** When the core checks again by itself, null when it does not. */
  nextCheckAt: Timestamp | null;
  /** A newer release the last check found and accepted; `availableVersion` then names it. */
  available: { version: string; commit: string; checkedAt: Timestamp } | null;
  /** Why the manifest read there was not offered: not newer, another id, no artifact here. Not an error. */
  ignored: string | null;
  /** Why the last check could not read the source. Checks back off after one. */
  error: string | null;
}

/** What `plugins.inspect` read, shown to the owner before anything is downloaded. */
export interface PluginPreview {
  /** What `plugins.add` takes. Null when the manifest was refused. */
  previewId: string | null;
  source: PluginSource;
  manifest: PluginManifest | null;
  rejected: PluginRejected | null;
  artifact: PluginArtifact | null;
  platform: string;
  commands: string[];
  /** The version installed under the same id, which this install replaces. */
  replaces: string | null;
  expiresAt: Timestamp;
}

export interface PluginPool {
  provider: string;
  accounts: { email: string; active: boolean; windows: QuotaWindow[]; checkedSecondsAgo: number | null }[];
}

export interface PluginsRpcMethods {
  /** The recommended plugins, then every one installed from a URL, rejected ones included. */
  'plugins.list': { params: Record<string, never>; result: PluginState[] };
  /**
   * Fetches the repository at `ref` (default `HEAD`) and reads its manifest.
   * Downloads no artifact and runs nothing. https URLs only.
   */
  'plugins.inspect': { params: { url: string; ref?: string }; result: PluginPreview };
  /** Installs exactly what a preview showed: that manifest, read at that commit. */
  'plugins.add': { params: { previewId: string }; result: PluginState };
  /** Installs a recommended plugin, or reinstalls one already added from a URL. */
  'plugins.install': { params: { id: string }; result: PluginState };
  'plugins.cancel': { params: { id: string }; result: PluginState };
  'plugins.uninstall': { params: { id: string }; result: PluginState };
  'plugins.accounts': { params: { id: string; refresh?: boolean }; result: PluginPool[] };
  'plugins.accountAction': {
    params: { id: string; provider: string; action: 'add' | 'switch' | 'remove'; email?: string };
    result: PluginPool[];
  };
  /**
   * Controls a desktop-app plugin. `start` enables and launches it, `stop`
   * disables and kills it, `restart` kills and launches it again.
   */
  'plugins.app': { params: { id: string; action: 'start' | 'stop' | 'restart' }; result: PluginState };
  /** Owner-only. Start, stop or restart a gateway plugin. */
  'plugins.gateway': { params: { id: string; action: 'start' | 'stop' | 'restart' }; result: PluginState };
  /**
   * Owner-only. Whether the plugin's desktop app and gateway start when the
   * core starts. It changes nothing running now; a stop no longer keeps a
   * plugin off across core starts once this is on. A client offers it only
   * when the plugin's state carries `autostart`.
   */
  'plugins.autostart': { params: { id: string; autostart: boolean }; result: PluginState };
  /**
   * Reads the update source of one recommended plugin, or of every one that
   * names a source, now. Answers once the reads finish; each changed state is
   * also announced by `plugins.updated`. Installs nothing.
   */
  'plugins.checkUpdates': { params: { id?: string }; result: PluginState[] };
}

export interface PluginsRpcEvents {
  /** One plugin after any change. A `url` plugin that comes back `not-installed` is gone from the list. */
  'plugins.updated': PluginState;
}
