/**
 * What a browser pane is allowed to point at, decided on this side too.
 *
 * The same four rules the MCP endpoint applies (`classify_browser_url` in
 * `agent_api.rs`), deliberately duplicated rather than trusted, because the
 * endpoint is not the only way a `pane.open` reaches this app: the identical
 * request also arrives from a remote boite over the control plane, and that
 * one was checked by somebody else's process. The frame is created here, so
 * the last word belongs here.
 *
 * It is also what the palette's own address prompt runs on, so a user typing
 * the app's own origin into it is told no rather than handed a pane that can
 * reach `window.parent`.
 */

/**
 * Hosts that mean "this machine", spelled as a URL serializes them.
 *
 * Mirrored one for one by `frame-src` in `tauri.conf.json` and by
 * `LOCAL_HOSTS` in `agent_api.rs`. A host accepted here that the CSP does not
 * carry is a pane that opens blank, which is the bug this whole file exists
 * because of.
 */
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"];

/** The ports the app itself is served from in a dev build. */
const APP_PORTS = ["1420", "1430"];

/**
 * Whether a host names the machine resolving it.
 *
 * Exported because the answer depends on who is asking: the same four spellings
 * mean the boite when the boite says them and this device when this device
 * does, and the caller is the only one that knows which.
 */
export function isLoopbackHost(host: string): boolean {
  return LOCAL_HOSTS.includes(host.toLowerCase());
}

export type BrowserRefusal =
  | "notAUrl"
  | "scheme"
  | "credentials"
  | "appOrigin"
  | "otherMachine"
  | "cleartext";

export interface BrowserSource {
  /**
   * Whether loopback in this address means the machine the window is on.
   *
   * False for a `pane.open` that arrived from a boite: the agent that wrote
   * `http://localhost:5173` meant the server's port, and this device resolving
   * it reaches its own, which is a different dev server or nothing at all.
   * Defaults to true, which is every address this window's own agents and its
   * own user produce.
   */
  requesterIsThisMachine?: boolean;
}

export type BrowserTarget =
  | {
      ok: true;
      /** The parsed form, so what is framed is what was checked. */
      url: string;
      /** On this machine, so it can be framed without asking. */
      local: boolean;
    }
  | { ok: false; reason: BrowserRefusal };

export function classifyBrowserUrl(raw: string, source: BrowserSource = {}): BrowserTarget {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "notAUrl" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "scheme" };
  }
  // A userinfo segment exists here only to make the host read as something it
  // is not: `http://evil.com@localhost` goes to localhost.
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "credentials" };
  }
  const host = parsed.hostname.toLowerCase();
  // Tauri serves the window itself from `*.localhost`, and the dev build from
  // a port on loopback. Framing either is framing the app's own origin, which
  // hands the page `window.parent` and the IPC behind it.
  if (host.endsWith(".localhost")) return { ok: false, reason: "appOrigin" };
  const loopback = isLoopbackHost(host);
  if (loopback && APP_PORTS.includes(parsed.port)) {
    return { ok: false, reason: "appOrigin" };
  }
  // Loopback written by another machine addresses that machine, and nothing on
  // this one can stand in for it. Refused rather than reinterpreted: framing
  // this device's own port would show an unrelated dev server under the name of
  // the one the agent meant, and it used to be waved through as "already the
  // user's own code" on a premise about a machine the user is not on.
  if (loopback && source.requesterIsThisMachine === false) {
    return { ok: false, reason: "otherMachine" };
  }
  const local = loopback;
  // A local dev server is the case this feature exists for. Plain http to
  // anywhere else is a document the network gets to write, and the shipped CSP
  // frames no such thing either.
  if (parsed.protocol === "http:" && !local) {
    return { ok: false, reason: "cleartext" };
  }
  return { ok: true, url: parsed.toString(), local };
}

/**
 * Whether the frame may keep its own origin.
 *
 * `allow-same-origin` on a page the agent chose is what turns "show me a page"
 * into "run this page's scripts under its own origin inside the user's app
 * window". A dev server on this machine is already the user's own code; every
 * other page gets an opaque origin, so its scripts run with no storage, no
 * cookies and nothing to reach back through.
 */
export function isLocalPage(url: string): boolean {
  const target = classifyBrowserUrl(url);
  return target.ok && target.local;
}
