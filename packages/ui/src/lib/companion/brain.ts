/*
 * The companion's characters are Boite agents (`crew.svelte.ts`): each one
 * runs the way every agent runs, through the account and the subscription
 * proxy its profile names, with its own memory and its own conversation in
 * the Agents page. What lives here is what the companion adds on top: the
 * role it writes into the agent's instructions, the line each request
 * carries, the agent a new companion runs on and how it reads an answer.
 * Pure, so it is tested without a core.
 */
import { defaultTitleModel, providerEnabled, type Account, type Message, type PermissionMode, type ProviderSummary } from '@boite/contracts';
import type { CompanionControl, CompanionPrefs } from './prefs';

export interface Brain {
  providerId: string;
  accountId: string;
  model: string | null;
  effort: string | null;
}

/**
 * Written into the instructions of each agent that stands as the companion
 * (`withRole`), so every turn of the agent carries it. The bracketed lines are
 * read by the companion (`directives.ts`) and never shown.
 */
export const COMPANION_ROLE = `You also stand as Boite's desktop companion: a small character on the user's screen, their personal assistant. When the user talks to you from the companion, your reply appears in a speech bubble beside you; they may also write to you from Boite's Agents page.

- Answer in one to three short sentences, in plain text: no Markdown, no headings, no code blocks unless the user asks for one.
- Answer in the language the user writes in.
- When the user asks you to do something on this computer, do it with your tools, then say in a few words what you did. Do not explain how they could do it themselves.
- This is a Windows desktop. Use PowerShell:
  - An app, a file, a folder or a web page: Start-Process (Start-Process msedge, Start-Process 'https://example.com', Start-Process notepad). Find an installed app with Get-StartApps when its name is unknown.
  - A Steam game: Start-Process 'steam://rungameid/<appid>'. The app ids of installed games are in the steamapps\\appmanifest_*.acf files of the Steam library folders.
  - Music: Spotify URIs (Start-Process 'spotify:search:<words>', or a playlist URI), then the media keys: (New-Object -ComObject WScript.Shell).SendKeys([char]179) plays or pauses, [char]176 skips, [char]177 goes back.
- Never delete, move or overwrite the user's files, and never change system settings, unless the user asks for exactly that.
- A message sent from the companion ends with a line [[context: …]]: the user's local date and time, then the files that go with the message: the user's screens as they are now, the part of a screen they picked to show you, or files they dropped on you. Open each path it names with your file-reading tool before you answer. Then come the user's threads in Boite, their conversations with other agents: the ones that need the user first, then the ones running, failed, finished, each with its title, project, id, what it does or waits for, and its last answer.

Your memory of the user is the Memory (JSON) list of these instructions. Learn who the user is as you go: their name, what they like, their habits, their projects, how they want you to talk.
- When you learn something lasting and useful, add a line of its own: [[remember: one short fact]]. The companion keeps it in your memory; do not also save it with boite agent remember.
- When a fact turns out wrong or the user asks you to forget it: [[forget: the fact]]
- Never tell the user you remember something your memory does not list. Never keep passwords, keys, codes or other secrets.

You cannot wait or run in the background, but the companion can ring a reminder for you. When the user asks to be reminded, add a line of its own: [[remind: WHEN | what to say]], where WHEN is a delay (+45s, +20m, +1h30m), a time today (18:30) or a date and time (2026-10-12 09:00). Then say when it will ring.

The companion also shows one timer beside you, which the user sees run; starting one replaces the one running.
- A timer that rings when the time is up (a minuteur, a countdown, "remind me in 10 minutes" said as a timer): [[timer: DURATION | what it is for]], where DURATION is 90s, 10m, 1h30m. Use it rather than [[remind: …]] whenever the user asks for a timer.
- A stopwatch that counts up: [[stopwatch: what it is for]]
- A pomodoro or time to concentrate: [[pomodoro: DURATION | what it is for]], where DURATION is the work time (25m, 50m); leave it out for the user's usual length ([[pomodoro: | the report]]). The break follows by itself.
- To stop the one running: [[timer: stop]]
- When the user wants quiet, add [[focus: on]]: finished threads wait until the end and the sounds stay off, except for the agents that need the user and the reminders. [[focus: off]] ends it.

You can also hand work to another Boite agent, in a thread of its own the user follows in Boite. When the user asks for work to be done in one of their projects (a change to its code, a fix, a review, a document), do not do it yourself: add a line of its own, [[task: PROJECT | INSTRUCTION]], where PROJECT is the project's name as Boite lists it (the list is below) and INSTRUCTION is complete, since that agent sees nothing of this conversation. Then say in a few words what you handed over. The companion launches it, after the user confirms when it asks before acting.

The user may ask where their threads stand: what runs, what waits for them, how a thread is going. Answer from the threads the context line lists, in a sentence or two, naming them by title.
- To open one of them in Boite, when the user asks to see or go to it: [[open: ITS ID]]
- To find a past conversation by what was said in it, when the list does not show it: [[find: KEY WORDS]], with the names and terms that would appear in it, not words like conversation or thread. The companion searches all the threads, shows what it finds and opens it when only one matches. Then say in a few words that you are looking.

The user never sees the bracketed lines.`;

/** What an agent created for the companion works on, after its name. */
export const COMPANION_DOMAIN = "The user's desktop companion and personal assistant";

/** The marks around the role in an agent's instructions: the companion replaces or removes what they hold, and nothing else. */
export const ROLE_START = '<!-- boite-companion -->';
export const ROLE_END = '<!-- /boite-companion -->';

/** Brackets close a line the companion reads: a name never closes it early. */
export const plain = (name: string) => name.replace(/[[\]\n]/g, ' ').trim();

/** The role as the instructions hold it, with Boite's projects for `[[task: …]]`. */
export function roleBlock(projects: string[]): string {
  const listed = projects.length ? `Boite's projects: ${projects.map(plain).join(', ')}.` : 'Boite lists no project yet.';
  return `${ROLE_START}\n${COMPANION_ROLE}\n\n${listed}\n${ROLE_END}`;
}

/** The instructions without the companion's role, as the user wrote them. */
export function withoutRole(instructions: string): string {
  const start = instructions.indexOf(ROLE_START);
  if (start < 0) return instructions;
  const end = instructions.indexOf(ROLE_END, start);
  const after = end < 0 ? '' : instructions.slice(end + ROLE_END.length);
  return `${instructions.slice(0, start).trimEnd()}\n\n${after.trimStart()}`.trim();
}

/** The instructions with `block` in place of the role they held, after what the user wrote. */
export function withRole(instructions: string, block: string): string {
  const own = withoutRole(instructions);
  return own ? `${own}\n\n${block}` : block;
}

/** What the images and files of a request show, in the order `contextLine` names them. */
export type Seen = { kind: 'screen' } | { kind: 'screens'; count: number } | { kind: 'zone' };

/** What goes with a request besides its words. */
export interface RequestContext {
  now: Date;
  /** What the kept screen images show, and where they are; none when no image goes. */
  seen: Seen | null;
  shots: string[];
  /** The files dropped on the companion, where they are kept. */
  files: string[];
  /** The user's threads in Boite as `threadsDigest` tells them; none when they could not be read. */
  threads?: string | null;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (value: number) => String(value).padStart(2, '0');

/** `Friday 2026-10-09 14:32`, local time: the agent knows no time zone of its own. */
export function localTime(now: Date): string {
  return `${WEEKDAYS[now.getDay()]} ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function seenPart(seen: Seen, shots: string[]): string {
  const paths = shots.map(plain).join(', ');
  if (seen.kind === 'zone') return `the part of the screen the user picked to show you: ${paths}`;
  if (seen.kind === 'screens') return `the user's ${seen.count} screens, the main one first: ${paths}`;
  return `the user's screen: ${paths}`;
}

/** The line that ends a request sent from the companion: the time, where its images and files are, then the user's threads. */
export function contextLine(context: RequestContext): string {
  const parts = [`local time ${localTime(context.now)}`];
  if (context.seen && context.shots.length) parts.push(seenPart(context.seen, context.shots));
  if (context.files.length) parts.push(`files the user dropped on you: ${context.files.map(plain).join(', ')}`);
  return `[[context: ${parts.join('; ')}${context.threads ? `\n${context.threads}` : ''}]]`;
}

/** The message an agent receives: the request, then the context line. */
export function messageFor(request: string, context: RequestContext): string {
  return `${request.trim()}\n\n${contextLine(context)}`;
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
 * The provider a new companion agent runs on: the one chosen in Settings when
 * it is still on, here and signed in, otherwise the first that is, on its
 * small model, the one titles are written with when it lists it. Null when no
 * provider can run.
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

/** What the bubble shows of a thread message: its text parts, the reasoning and the tools left out. */
export function replyText(message: Pick<Message, 'parts'>): string {
  return message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('').trim();
}
