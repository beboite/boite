import { httpBase } from "$lib/backend/remote/socket";

/**
 * Turning an invitation into this device's own credential.
 *
 * The half of pairing that runs before there is a connection, so it goes over
 * plain `fetch` rather than through a `Backend`: the whole point is that a
 * device with nothing saved can reach a boite it has never spoken to.
 */

/** How the fragment carries a one-time token. */
const HASH_KEY = "pair";

/**
 * What this device calls itself, so the list on the other end says something.
 *
 * Cosmetic and never read as authorisation: the server normalises it to a word
 * it can draw an icon for and throws the rest away.
 */
export function deviceKind(): string {
  if (typeof navigator === "undefined") return "unknown";
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) return "desktop";
  const coarse =
    typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  if (!coarse) return "browser";
  const wide = typeof screen !== "undefined" && Math.min(screen.width, screen.height) >= 600;
  return wide ? "tablet" : "phone";
}

/** A name a person would recognise in a list of devices. */
export function deviceLabel(): string {
  const kind = deviceKind();
  if (typeof navigator === "undefined") return kind;
  const ua = navigator.userAgent;
  const os =
    /Android/i.test(ua) ? "Android"
    : /iPhone|iPad|iPod/i.test(ua) ? "iOS"
    : /Mac OS X/i.test(ua) ? "macOS"
    : /Windows/i.test(ua) ? "Windows"
    : /Linux/i.test(ua) ? "Linux"
    : "";
  return os ? `${os} ${kind}` : kind;
}

/**
 * Reads a pairing token out of the fragment, and takes it out of history in the
 * same breath.
 *
 * The fragment is where the token lives precisely because it never reaches the
 * server, so it is in no access log and no `Referer`. What it *is* in is this
 * tab's history entry, which survives a reload and shows up in the address bar,
 * so it is replaced before anything else runs. `replaceState` rather than
 * `pushState`: a back button that walks into a spent token is a confusing
 * error, not a feature.
 */
export function takePairingTokenFromHash(): string | null {
  if (typeof location === "undefined" || !location.hash) return null;
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const token = params.get(HASH_KEY);
  if (!token) return null;
  params.delete(HASH_KEY);
  const rest = params.toString();
  try {
    history.replaceState(null, "", `${location.pathname}${location.search}${rest ? `#${rest}` : ""}`);
  } catch {
    // A sandboxed frame can refuse it. The token is spent by the exchange
    // below either way, so the worst case is a dead string in the address bar.
  }
  return token;
}

export interface PairedHere {
  credential: string;
  label: string;
  scopes: string[];
}

/**
 * Exchanges a one-time token for this device's own long-lived credential.
 *
 * Everything travels in the body: a token in a query string is a token in the
 * access log of whatever reverse proxy is in front. The answer is the only copy
 * of the credential the server will ever hand out, so a caller that fails to
 * save it has to pair again.
 */
export async function redeemPairing(wsUrl: string, token: string): Promise<PairedHere> {
  let base: string;
  try {
    base = httpBase(wsUrl);
  } catch {
    throw new Error("that boite address is not a URL");
  }
  const res = await fetch(`${base}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, label: deviceLabel(), kind: deviceKind() }),
  });
  if (res.status === 401) {
    throw new Error("that invitation is spent, expired, or was never one");
  }
  if (!res.ok) throw new Error(`pairing refused (${res.status})`);
  const body = (await res.json().catch(() => null)) as {
    credential?: unknown;
    pairing?: { label?: unknown; scopes?: unknown };
  } | null;
  if (typeof body?.credential !== "string" || !body.credential) {
    throw new Error("the boite issued no credential");
  }
  return {
    credential: body.credential,
    label: typeof body.pairing?.label === "string" ? body.pairing.label : "",
    scopes: Array.isArray(body.pairing?.scopes)
      ? body.pairing.scopes.filter((s): s is string => typeof s === "string")
      : [],
  };
}
