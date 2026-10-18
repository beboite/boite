/*
 * The sign-in card (`boite browser login`): an agent that meets a login page
 * asks the user once, on a card naming each site and why, instead of in the
 * chat. The card's Open button shows the page in the conversation's browser,
 * where the user signs in; the profile keeps it for every conversation of the
 * machine. See docs/browser.md#signing-in.
 */

/** Sites one card may name: a task that needs more asks again later. */
export const SIGN_IN_SITES_MAX = 6;
export const SIGN_IN_REASON_MAX = 500;
const SIGN_IN_URL_MAX = 4096;

/** One page to sign in on, with the host the card names it by. */
export interface SignInSite { url: string; host: string }

/**
 * What a sign-in card holds. `profile` is the browser profile it opens in and
 * keeps the sign-in, `profileName` the name the card shows.
 */
export interface SignInAsk { sites: SignInSite[]; profile: string; profileName: string }

export interface SignInRequestParams {
  threadId: string;
  /** Why the agent needs it: the card's text. */
  reason: string;
  urls: string[];
  /** A profile name or id; the machine's default one when absent. Never `private`. */
  profile?: string;
}

/** The only option of the card: the user says the sign-ins are done. Skip closes it. */
export const SIGN_IN_DONE = 'done';

/** The sites of a request, each an absolute http(s) address, without repeats; or why not. */
export function signInSites(urls: unknown): { ok: true; sites: SignInSite[] } | { ok: false; message: string } {
  if (!Array.isArray(urls) || urls.length === 0 || urls.length > SIGN_IN_SITES_MAX) return { ok: false, message: `a sign-in card names 1 to ${SIGN_IN_SITES_MAX} pages` };
  const sites: SignInSite[] = [];
  for (const url of urls) {
    // The same address rule as `browser.command` open; contracts have no URL parser.
    const match = typeof url === 'string' && url.length <= SIGN_IN_URL_MAX ? /^https?:\/\/([^\s/?#]+)(?:[/?#][^\s]*)?$/i.exec(url) : null;
    if (!match) return { ok: false, message: `${String(url).slice(0, 200)} is not an absolute HTTP or HTTPS address` };
    // A password in the address would sit on the card and in the journal.
    if (match[1]!.includes('@')) return { ok: false, message: 'a sign-in address carries no user name or password' };
    const host = match[1]!.toLowerCase();
    if (!sites.some(site => site.host === host)) sites.push({ url, host });
  }
  return { ok: true, sites };
}

/** What the agent reads once the card is answered. */
export function signInAnswerText(ask: SignInAsk): string {
  const hosts = ask.sites.map(site => site.host).join(', ');
  return `The user says they signed in to ${hosts} in the ${ask.profileName} browser profile of this machine. Open the page again with boite browser open <url> --profile ${ask.profile}; every conversation of this machine uses the same sign-in. If it still asks for a login, say so instead of asking again.`;
}
