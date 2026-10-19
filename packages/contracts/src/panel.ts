import type { Principal } from './agent-door';
import type { CoreInfo } from './core';
import type { DeviceHello } from './group';
import type { ThreadId, Timestamp } from './ids';
import type { UiRevealTarget } from './plugins';
import type { HelloAccepted } from './wire';

/**
 * What the right panel shows on request. `file` opens the file at the line;
 * `diff` opens the changes, on one file when a path is given; `browser` opens
 * the url in a new tab of the conversation's browser, the one its agent drives
 * (`artifacts.preview` alone sends a `browser` surface to the panel itself); `trace` and `tasks` open those surfaces.
 * Paths are relative to the thread's working directory or absolute inside it.
 */
export type PanelSurface =
  | { kind: 'file'; path: string; line?: number }
  | { kind: 'files'; path?: string }
  | { kind: 'diff'; path?: string }
  | { kind: 'browser'; url: string; artifact?: { path: string; port: number } }
  | { kind: 'trace' }
  | { kind: 'tasks' }
  | { kind: 'workflow'; runId?: string };

export const PANEL_SURFACE_KINDS = ['file', 'files', 'diff', 'browser', 'trace', 'tasks', 'workflow'] as const;
export type PanelSurfaceKind = (typeof PANEL_SURFACE_KINDS)[number];

export interface PanelRpcMethods {
  /**
   * Asks the owner's desktop windows to show a thread or an agent's page.
   * Emits `ui.reveal` to owner connections only, desktop-app plugins left
   * out; `delivered` counts them.
   */
  'ui.reveal': { params: { target: UiRevealTarget }; result: { delivered: number } };
  /**
   * The first frame. `token` is the core token or a session token; `grant` is
   * a pairing grant, exchanged here for a session whose token comes back in
   * `session` and is what this client says hello with from then on. One of the
   * two, never both. `ticket` is the third way in: a group member's signed
   * word (`group.ticket`), exchanged once like a grant for a session of the
   * role the ticket names.
   *
   * `nonce` goes with a grant: a random string of 16 to 256 characters the
   * client picks once and repeats on every retry. When the answer carrying the
   * session is lost, the same grant and nonce get the same session back until
   * the grant would have expired or the session first says hello with its
   * token. Without a nonce a grant is strictly one-shot. A nonce of another
   * length, or one sent with a token, is refused with `InvalidParams` naming
   * `nonce`, before the grant is spent.
   *
   * `client.device` names what the client runs on, for the agent's note on
   * where a prompt came from (`SentFrom`): the computer's name for the
   * shell, `phone` or `browser` for the web app. At most
   * `CLIENT_DEVICE_MAX` characters; anything else is ignored.
   */
  hello: {
    params: {
      token?: string;
      grant?: string;
      ticket?: string;
      nonce?: string;
      /**
       * On a socket opened at another member's relay route
       * (`groupRelayUrl`), this client's key for that member. The member checks
       * it, takes it out and passes the rest of the hello on: the core at the
       * end never sees it.
       */
      relay?: string | DeviceHello;
      /**
       * A device of the group: its signature for this core (`deviceHelloInput`).
       * With `grant`, the device being admitted: its public key and a
       * signature over the grant (`deviceAdmitInput`), and `name` for the list.
       */
      device?: DeviceHello | { publicKey: string; name?: string; sig: string };
      protocolVersion: number;
      client: { name: string; version: string; device?: string };
      /**
       * Events this client handles that an older client would not, so the
       * core sends them in place of their older form. `thread.load`: a load
       * sample arrives as that event instead of a whole `thread.updated` row.
       * An older core ignores the field.
       */
      accepts?: HelloAccepted[];
    };
    result: {
      core: CoreInfo;
      principal: Principal;
      session?: { id: string; token: string };
      /** The device id a grant just admitted. */
      device?: string;
      /** The one thread an `agent` reaches. */
      threadId?: ThreadId;
    };
  };
  /**
   * Show something in the thread's right panel. Every client subscribed to the
   * thread receives `panel.requested`; `shown` says whether one was. The core
   * checks a path exists inside the working directory and a url is http(s),
   * and refuses by name otherwise.
   */
  'panel.open': { params: { threadId: ThreadId; surface: PanelSurface }; result: { shown: boolean } };
}

export interface PanelRpcEvents {
  /** Subscribed threads only: the agent asked for something in the panel. */
  'panel.requested': { threadId: ThreadId; surface: PanelSurface; at: Timestamp };
  /** Owner connections only: show this thread or agent in the desktop window. */
  'ui.reveal': { target: UiRevealTarget };
  /**
   * This machine's own desktop window only: install this release now, the
   * owner asked from another machine (`core.updateEverything` `app`). The
   * window checks it against its own offer before anything installs.
   */
  'ui.appUpdate': { version: string };
}
