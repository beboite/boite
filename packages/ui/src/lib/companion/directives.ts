/*
 * The lines the companion's agent adds to a reply for the companion itself,
 * as its role asks (`brain.ts`): `[[remember: …]]`, `[[forget: …]]` and
 * `[[remind: when | what]]`. The bubble never shows them; the page acts on
 * them once the reply is complete. Pure, so it is tested without a core.
 */

export interface Directives {
  remember: string[];
  forget: string[];
  remind: { text: string; at: number }[];
}

const DIRECTIVE = /\[\[\s*(remember|forget|remind)\s*:([\s\S]*?)\]\]/gi;
/** A directive still being written while the reply streams. */
const UNFINISHED = /\[\[(?![\s\S]*\]\])[\s\S]*$/;

/** The reply as the bubble shows it: no directive, finished or not. */
export function visibleReply(text: string): string {
  return text
    .replace(DIRECTIVE, '')
    .replace(UNFINISHED, '')
    .replace(/\[$/, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const pad = (value: number) => String(value).padStart(2, '0');

/**
 * When a reminder rings, epoch milliseconds: a delay (`+45s`, `+20m`,
 * `+1h30m`), a time today or, once past, tomorrow (`18:30`), or a local date
 * and time (`2026-10-12 09:00`). Null for anything else or for a past date.
 */
export function parseWhen(when: string, now: Date): number | null {
  const text = when.trim().toLowerCase();
  const delay = /^\+\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+)\s*s)?$/.exec(text);
  if (delay && (delay[1] || delay[2] || delay[3])) {
    const [hours, minutes, seconds] = [delay[1], delay[2], delay[3]].map((part) => Number(part ?? 0));
    const ms = ((hours! * 60 + minutes!) * 60 + seconds!) * 1000;
    return ms > 0 ? now.getTime() + ms : null;
  }
  const clock = /^(\d{1,2})[:h](\d{2})$/.exec(text);
  if (clock) {
    const [hours, minutes] = [Number(clock[1]), Number(clock[2])];
    if (hours > 23 || minutes > 59) return null;
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return at.getTime();
  }
  const date = /^(\d{4})-(\d{2})-(\d{2})[ t](\d{1,2}):(\d{2})$/.exec(text);
  if (date) {
    const [year, month, day, hours, minutes] = date.slice(1).map(Number) as [number, number, number, number, number];
    const at = new Date(year, month - 1, day, hours, minutes);
    // `new Date` rolls an impossible date over (31 February): refuse it instead.
    const exact = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
    if (exact !== `${year}-${pad(month)}-${pad(day)} ${pad(hours)}:${pad(minutes)}`) return null;
    return at.getTime() > now.getTime() ? at.getTime() : null;
  }
  return null;
}

/** What a complete reply asks of the companion. A directive it cannot read is left out. */
export function parseDirectives(text: string, now: Date): Directives {
  const found: Directives = { remember: [], forget: [], remind: [] };
  for (const [, kind, body] of text.matchAll(DIRECTIVE)) {
    const content = body!.trim();
    if (!content) continue;
    if (kind!.toLowerCase() === 'remember') found.remember.push(content);
    else if (kind!.toLowerCase() === 'forget') found.forget.push(content);
    else {
      const bar = content.indexOf('|');
      if (bar < 0) continue;
      const at = parseWhen(content.slice(0, bar), now);
      const what = content.slice(bar + 1).trim();
      if (at !== null && what) found.remind.push({ text: what, at });
    }
  }
  return found;
}
