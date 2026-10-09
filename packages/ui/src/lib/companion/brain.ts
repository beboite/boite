/*
 * The companion's brain is an ordinary Boite thread in the drafts project, so
 * it runs the way every thread runs: through the agent, the account and the
 * subscription proxy the core already uses. What lives here is what the
 * companion adds on top: which agent it takes, the role it gives it and how
 * it reads the answer for its bubble. Pure, so it is tested without a core.
 */
import { defaultTitleModel, providerEnabled, type Account, type Message, type PermissionMode, type ProviderSummary } from '@boite/contracts';
import type { CompanionControl, CompanionPrefs } from './prefs';

export interface Brain {
  providerId: string;
  accountId: string;
  model: string | null;
  effort: string | null;
}

/** The thread's title in the drafts, where the conversation stays readable. */
export const COMPANION_THREAD_TITLE = 'Companion';

/**
 * Sent before the first request of a conversation, since the UI cannot write
 * an instructions file into a folder for the agent to read. The agent keeps
 * it for the whole thread.
 */
export const COMPANION_ROLE = `You are Boite's desktop companion: a small character at the top of the user's screen. Your replies appear in a speech bubble under you.

- Answer in one to three short sentences, in plain text: no Markdown, no headings, no code blocks unless the user asks for one.
- Answer in the language the user writes in.
- When the user asks you to do something on this computer, do it with your tools, then say in a few words what you did. Do not explain how they could do it themselves.
- This is a Windows desktop. Use PowerShell:
  - An app, a file, a folder or a web page: Start-Process (Start-Process msedge, Start-Process 'https://example.com', Start-Process notepad). Find an installed app with Get-StartApps when its name is unknown.
  - A Steam game: Start-Process 'steam://rungameid/<appid>'. The app ids of installed games are in the steamapps\\appmanifest_*.acf files of the Steam library folders.
  - Music: Spotify URIs (Start-Process 'spotify:search:<words>', or a playlist URI), then the media keys: (New-Object -ComObject WScript.Shell).SendKeys([char]179) plays or pauses, [char]176 skips, [char]177 goes back.
- Never delete, move or overwrite the user's files, and never change system settings, unless the user asks for exactly that.

The user's first request follows.`;

/** The first prompt of a conversation carries the role; the next ones are the request alone. */
export function promptFor(request: string, first: boolean): string {
  return first ? `${COMPANION_ROLE}\n\n---\n\n${request}` : request;
}

export function permissionModeOf(control: CompanionControl): PermissionMode {
  return control === 'auto' ? 'bypassPermissions' : 'default';
}

/**
 * The small model titles are written with, when the agent lists it: the core
 * refuses a model it does not list, and null runs the agent's own default.
 */
function smallModel(provider: ProviderSummary): string | null {
  const id = defaultTitleModel(provider, provider.models);
  return id !== null && provider.models.some((model) => model.id === id) ? id : null;
}

const signedIn = (accounts: Account[], providerId: string): Account[] =>
  accounts.filter((account) => account.providerId === providerId && account.status === 'ok');

/**
 * The agent the companion runs on: the one chosen in Settings when it is still
 * on, here and signed in, otherwise the first that is, on its small model, the
 * one titles are written with when it lists it. Null when no agent can run.
 */
export function pickBrain(prefs: CompanionPrefs, providers: ProviderSummary[], accounts: Account[]): Brain | null {
  const usable = (provider: ProviderSummary) => providerEnabled(provider) && provider.available && signedIn(accounts, provider.id).length > 0;
  const chosen = prefs.providerId === null ? undefined : providers.find((provider) => provider.id === prefs.providerId);
  if (chosen && usable(chosen)) {
    const own = signedIn(accounts, chosen.id);
    const account = own.find((entry) => entry.id === prefs.accountId) ?? own[0]!;
    return { providerId: chosen.id, accountId: account.id, model: prefs.model ?? smallModel(chosen), effort: prefs.model === null ? null : prefs.effort };
  }
  if (prefs.providerId !== null) return null;
  const first = providers.find(usable);
  if (!first) return null;
  return { providerId: first.id, accountId: signedIn(accounts, first.id)[0]!.id, model: smallModel(first), effort: null };
}

/** What the bubble shows of an agent message: its text parts, the reasoning and the tools left out. */
export function replyText(message: Pick<Message, 'parts'>): string {
  return message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('').trim();
}
