/*
 * The sign-in card (`boite browser login`, docs/browser.md#signing-in). The
 * agent names the pages and why; the card is drawn without stopping, like
 * `boite ask`. Its Open button opens one of those pages in the conversation's
 * browser, in the card's profile, which keeps the sign-in for every
 * conversation of the machine.
 */
import {
  browserProfilesOf,
  DEFAULT_BROWSER_PROFILE,
  findBrowserProfile,
  PRIVATE_BROWSER_PROFILE,
  SIGN_IN_DONE,
  SIGN_IN_REASON_MAX,
  signInSites,
  type RpcParams,
  type RpcResult,
  type SignInAsk,
} from '@boite/contracts';
import type { Core } from '../core.ts';
import { refused } from '../errors.ts';
import type { Connection } from '../router.ts';

export function requestSignIn(core: Core, params: RpcParams<'browser.signIn'>): RpcResult<'browser.signIn'> {
  const thread = core.threads.require(params.threadId);
  if (thread.archived) throw refused('cannot ask on an archived thread', { threadId: thread.id });
  const reason = typeof params.reason === 'string' ? params.reason.trim() : '';
  if (reason.length === 0 || reason.length > SIGN_IN_REASON_MAX) throw refused(`a sign-in card needs a reason of 1 to ${SIGN_IN_REASON_MAX} characters (--why)`, { field: 'reason' });
  const checked = signInSites(params.urls);
  if (!checked.ok) throw refused(checked.message, { field: 'urls' });
  const { profiles, defaultId } = browserProfilesOf(core.settings.get());
  const profile = params.profile === undefined ? defaultId : typeof params.profile === 'string' ? findBrowserProfile(profiles, params.profile) : null;
  if (profile === null) throw refused(`no browser profile is named ${String(params.profile)}; boite browser profiles lists them`, { field: 'profile' });
  if (profile === PRIVATE_BROWSER_PROFILE) throw refused('a private tab keeps no sign-in: ask in the default profile or a named one', { field: 'profile' });
  // Asked once: a card still open for these sites is the answer to a second ask.
  for (const request of core.threads.listQuestions(thread.id)) {
    const open = request.signIn;
    if (open?.profile === profile && checked.sites.every(site => open.sites.some(known => known.host === site.host))) return { questionId: request.id, signIn: open, reused: true };
  }
  const profileName = profile === DEFAULT_BROWSER_PROFILE ? 'Default' : profiles.find(known => known.id === profile)?.name ?? profile;
  const signIn: SignInAsk = { sites: checked.sites, profile, profileName };
  const { questionId } = core.threads.cards.drawAsync(thread, {
    text: reason, options: [{ id: SIGN_IN_DONE, label: 'Signed in' }], allowText: false, multiple: false, async: true, signIn,
  });
  return { questionId, signIn, reused: false };
}

/**
 * The card's Open: the page shows in the conversation's browser. A tab of the
 * conversation already on that site, in the same profile, comes forward
 * instead of a second one.
 */
export async function openSignIn(core: Core, params: RpcParams<'browser.signInOpen'>, connection: Connection): Promise<RpcResult<'browser.signInOpen'>> {
  const { threadId, questionId, site } = params;
  if (connection.identity.principal !== 'owner' && !connection.subscriptions.has(threadId)) throw refused('subscribe to the conversation before opening its sign-in page');
  const request = core.threads.listQuestions(threadId).find(question => question.id === questionId);
  if (!request?.signIn) throw refused('this sign-in card is closed', { questionId });
  const page = Number.isInteger(site) ? request.signIn.sites[site] : undefined;
  if (!page) throw refused(`the sign-in card names ${request.signIn.sites.length} pages`, { site });
  const profile = request.signIn.profile;
  const status = (await core.browser.command({ threadId, action: { kind: 'status' } })).value as { tabs: Array<{ tabId: string; url: string; profile: string }> };
  const there = status.tabs.find(tab => tab.profile === profile && hostOf(tab.url) === hostOf(page.url));
  const reply = there
    ? await core.browser.command({ threadId, tabId: there.tabId, action: { kind: 'activate' } })
    : await core.browser.command({ threadId, action: { kind: 'open', url: page.url, profile } });
  if (!reply.tabId) throw refused('the browser opened no tab');
  return { tabId: reply.tabId };
}

function hostOf(url: string): string | null {
  try { return new URL(url).host; } catch { return null; }
}
