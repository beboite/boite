// Owns shared dropped-group marks and their reconciliation between windows.
import { withoutTrailingSlashes } from '@boite/contracts';

export const DROPPED_STORAGE_KEY = 'boite.group.dropped';
const DROPPED_MAX = 256;
/** Machines remembered as dropped. A removal is never forgotten to make room: past this, nothing a group brings is reached by itself. */
const DROPPED_MEMBERS_MAX = 2048;

interface Dropped { at: number; epoch: number }

/** What this window knows was dropped: what it read or wrote, less what it cleared itself. */
const known = new Map<string, Dropped>();

/** Address to when the group dropped the machine there, and which admission of it that was. */
export function droppedAddresses(): Record<string, Dropped> {
  try {
    const raw = window.localStorage.getItem(DROPPED_STORAGE_KEY);
    // Storage emptied: nothing is left for this window to put back.
    if (raw === null) known.clear();
    const parsed: unknown = JSON.parse(raw ?? '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, Partial<Dropped> | null>)
      .filter((entry): entry is [string, Dropped] => typeof entry[1]?.at === 'number' && typeof entry[1].epoch === 'number'));
  } catch {
    return {};
  }
}

function writeDropped(marks: Record<string, Dropped>): void {
  const entries = Object.entries(marks);
  // Addresses make room for newer ones: what was saved for an old one is long gone. Machines do not.
  const members = entries.filter(([key]) => key.startsWith('member ')).slice(0, DROPPED_MEMBERS_MAX);
  const addresses = entries.filter(([key]) => !key.startsWith('member ')).slice(-DROPPED_MAX);
  try {
    window.localStorage.setItem(DROPPED_STORAGE_KEY, JSON.stringify(Object.fromEntries([...members, ...addresses])));
  } catch {
    /* a browser that refuses storage still runs for this session */
  }
}

/**
 * Windows share the record without a lock: two that write at the same instant
 * each start from what they had read, and the later one erases or lowers what
 * the other recorded. A window that hears the record change puts back what it
 * knew. A lower admission is raised again. A machine's mark that went is
 * restored: when a later admission cleared it, that admission is past the mark
 * anyway. An address that went stays gone, since a pairing made by hand clears
 * it and putting it back would hide that machine.
 */
export function keepDropped(): void {
  const now = droppedAddresses();
  const back: Record<string, Dropped> = {};
  for (const [key, was] of known) {
    const mark = now[key];
    if (mark === undefined && !key.startsWith('member ')) known.delete(key);
    else if (mark === undefined || mark.epoch < was.epoch) back[key] = { at: Math.max(was.at, mark?.at ?? 0), epoch: was.epoch };
  }
  for (const [key, mark] of Object.entries({ ...now, ...back })) known.set(key, mark);
  if (Object.keys(back).length > 0) writeDropped({ ...now, ...back });
}

/**
 * The addresses of machines a group brought and then dropped, shared by every
 * window. Nothing saved for one is read again, whichever window left it and
 * wherever it sits, and no ticket is asked for it on the word of a member that
 * still lists the admission that was dropped. It ends when a new key is
 * issued for that address: by a pairing made by hand, or by the group having
 * admitted the machine again.
 */
export function setDropped(url: string, epoch: number | null): void {
  setMark(withoutTrailingSlashes(url), epoch);
}

/** The same machine under every address it gives: a drop heard for one of them holds for the others. */
export function memberKey(groupId: string, coreId: string): string {
  return `member ${groupId} ${coreId}`;
}

export function setMark(target: string, epoch: number | null): void {
  const { [target]: was, ...rest } = droppedAddresses();
  if (epoch === null) {
    known.delete(target);
    if (was !== undefined) writeDropped(rest);
    return;
  }
  // A window that knew an older admission must not lower what another one recorded: the highest admission dropped stays.
  const mark = { at: Date.now(), epoch: Math.max(was?.epoch ?? epoch, known.get(target)?.epoch ?? epoch, epoch) };
  known.set(target, mark);
  writeDropped({ ...rest, [target]: mark });
}

/**
 * Whether the group dropped the machine at this address and nothing brought it
 * back. With `epoch`, the admission a member lists for it now: a later one
 * than the one dropped means the machine was admitted again, and is not dropped.
 */
export function isDropped(url: string, epoch?: number): boolean {
  const mark = droppedAddresses()[withoutTrailingSlashes(url)];
  return mark !== undefined && (epoch === undefined || epoch <= mark.epoch);
}

/**
 * Whether the address was dropped after `began`. A ticket exchange that began
 * before the drop and ends after it is for a machine that has left since: its
 * key is not kept, and does not bring the address back.
 */
export function droppedSince(url: string, began: number, member?: { coreId?: string; groupId?: string }): boolean {
  const marks = droppedAddresses();
  const of = member?.coreId !== undefined && member.groupId !== undefined ? marks[memberKey(member.groupId, member.coreId)] : undefined;
  return [marks[withoutTrailingSlashes(url)], of].some((mark) => mark !== undefined && mark.at >= began);
}

/**
 * Whether the group dropped this machine, whatever address it is reached at.
 * With `epoch`, the admission a member lists for it now: a later one than the
 * one dropped is the machine admitted again.
 */
export function isMemberDropped(groupId: string | undefined, coreId: string | undefined, epoch?: number): boolean {
  if (groupId === undefined || coreId === undefined) return false;
  const marks = droppedAddresses();
  const mark = marks[memberKey(groupId, coreId)];
  // No room left to remember a removal: one that could not be written must not look like none.
  if (mark === undefined) return Object.keys(marks).filter((key) => key.startsWith('member ')).length >= DROPPED_MEMBERS_MAX;
  return epoch === undefined || epoch <= mark.epoch;
}
