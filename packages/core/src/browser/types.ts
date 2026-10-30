// Shared state of Chromium engines and the tabs attached to them.
import type { BrowserAction, BrowserDiagnostic, BrowserHistoryEntry, BrowserPreset, RemoteBrowserFrame, ThreadId } from '@boite/contracts';
import type { Cdp } from './cdp.ts';
import type { BrowserIdentity } from './chromium.ts';
import type { TabRecorder } from './recorder.ts';
import type { PageInfo, ScreenTurns } from './frames.ts';
import type { AgentPage } from './automation.ts';
import type { SleepState } from './sleep.ts';
import type { NetworkCapture } from './network.ts';

/** One Chromium process: a profile folder, or a throwaway one for private tabs. */
export interface Engine {
  /** The profile, prefixed `host:` when the desktop app hosts it (`browser/host.ts`). */
  key: string;
  profile: string;
  /** Its tabs are webviews of the desktop app: windows and cookies are that app's own, a copy saved here. */
  hosted: boolean;
  dir: string;
  cdp: Cdp;
  kill(): void;
  exited: Promise<unknown>;
  tabs: Set<string>;
  idle?: ReturnType<typeof setTimeout>;
  /** The save a navigation asked for, and the one that repeats while tabs are open. */
  saveSoon?: ReturnType<typeof setTimeout>;
  saveEvery?: ReturnType<typeof setInterval>;
  /** What `boite-cookies.json` holds, so an unchanged set is not written again. */
  saved?: string;
  /** Removed when the process ends: private tabs keep nothing. */
  throwaway: boolean;
  /** What its tabs say they are, as the same browser with a window would; null leaves the browser's own. */
  identity: BrowserIdentity | null;
}

export interface Tab {
  id: string;
  threadId: ThreadId;
  engine: Engine;
  targetId: string;
  sessionId: string;
  url: string;
  title: string;
  preset: BrowserPreset | null;
  orientation: 'portrait' | 'landscape';
  colorScheme: 'system' | 'light' | 'dark';
  diagnostics: BrowserDiagnostic[];
  dropped: number;
  history: BrowserHistoryEntry[];
  requests: Map<string, string>;
  /** The page's calls while an agent captures them (`network.ts`), null otherwise. */
  network: NetworkCapture | null;
  recorder: TabRecorder | null;
  /** The agent's turn ended while its recording ran: the video was thrown away. */
  discarded: boolean;
  frame: { at: number; key: string; promise: Promise<{ frame: RemoteBrowserFrame; page: PageInfo }> } | null;
  /** Captures and page size changes of this tab take turns (`frames.ts`, `takeTurn`). */
  screen: ScreenTurns;
  off: Array<() => void>;
  /** Its page's frames, so a download a frame begins is the conversation's (`downloads.ts`). */
  frames: Set<string>;
  /** An agent command is running: the dialogs it raises follow `page.dialogPolicy`. */
  acting: boolean;
  /** The command `acting` belongs to: the late end of a given-up one leaves it set. */
  actor: object | null;
  /** An action given up past its bound whose work still runs on this tab; `by` is its command. */
  stuck: { action: BrowserAction['kind']; since: number; by: object } | null;
  page: AgentPage;
  /** Frozen while nobody drives or watches it (`sleep.ts`). */
  sleep: SleepState;
}
