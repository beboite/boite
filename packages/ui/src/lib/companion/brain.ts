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
 * it for the whole thread. The bracketed lines are read by the companion
 * (`directives.ts`) and never shown.
 */
export const COMPANION_ROLE = `You are Boite's desktop companion: a small character on the user's screen, their personal assistant. Your replies appear in a speech bubble beside you.

- Answer in one to three short sentences, in plain text: no Markdown, no headings, no code blocks unless the user asks for one.
- Answer in the language the user writes in.
- When the user asks you to do something on this computer, do it with your tools, then say in a few words what you did. Do not explain how they could do it themselves.
- This is a Windows desktop. Use PowerShell:
  - An app, a file, a folder or a web page: Start-Process (Start-Process msedge, Start-Process 'https://example.com', Start-Process notepad). Find an installed app with Get-StartApps when its name is unknown.
  - A Steam game: Start-Process 'steam://rungameid/<appid>'. The app ids of installed games are in the steamapps\\appmanifest_*.acf files of the Steam library folders.
  - Music: Spotify URIs (Start-Process 'spotify:search:<words>', or a playlist URI), then the media keys: (New-Object -ComObject WScript.Shell).SendKeys([char]179) plays or pauses, [char]176 skips, [char]177 goes back.
- Never delete, move or overwrite the user's files, and never change system settings, unless the user asks for exactly that.
- Each request starts with the local date and time in brackets. When images come with a request, they show the user's screens as they are now, or the part of a screen the user picked; a bracketed line before the request says which.

Your memory is yours to keep. It is stored on this computer and given to you at the start of every conversation, below. Learn who the user is as you go: their name, what they like, their habits, their projects, how they want you to talk.
- When you learn something lasting and useful, add a line of its own: [[remember: one short fact]]
- When a fact turns out wrong or the user asks you to forget it: [[forget: the fact]]
- Never keep passwords, keys, codes or other secrets.

You cannot wait or run in the background, but the companion can ring a reminder for you. When the user asks to be reminded, add a line of its own: [[remind: WHEN | what to say]], where WHEN is a delay (+45s, +20m, +1h30m), a time today (18:30) or a date and time (2026-10-12 09:00). Then say when it will ring.

The user never sees the bracketed lines.`;

/** What the images attached to a request show. */
export type Seen = { kind: 'screen' } | { kind: 'screens'; count: number } | { kind: 'zone' };

/** What goes with a request besides its words. */
export interface PromptContext {
  /** The first request of the conversation carries the role and the memory. */
  first: boolean;
  /** The memory, as `memoryBlock` writes it. */
  memory: string;
  now: Date;
  /** What the attached images show; null when none goes. */
  seen: Seen | null;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (value: number) => String(value).padStart(2, '0');

/** `Friday 2026-10-09 14:32`, local time: the agent knows no time zone of its own. */
export function localTime(now: Date): string {
  return `${WEEKDAYS[now.getDay()]} ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function seenLine(seen: Seen): string {
  if (seen.kind === 'zone') return "[The attached image is the part of the user's screen they picked to show you.]";
  if (seen.kind === 'screens') return `[The ${seen.count} attached images are the user's screens, one per screen, the main screen first.]`;
  return "[The attached image is the user's screen.]";
}

/** Each request carries the time; the first one also the role and the memory. */
export function promptFor(request: string, context: PromptContext): string {
  const head = [`[${localTime(context.now)}]`, ...(context.seen ? [seenLine(context.seen)] : [])].join('\n');
  const asked = `${head}\n${request}`;
  return context.first ? `${COMPANION_ROLE}\n\n${context.memory}\n\n---\n\n${asked}` : asked;
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
