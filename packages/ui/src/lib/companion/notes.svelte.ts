/*
 * What the companion says without being asked: another conversation that
 * finished, with the first sentence of its answer, and the reminders it was
 * asked for, which ring here since only this window runs all day.
 */
import type { ThreadSummary } from '@boite/contracts';
import type { Client } from '../client';
import { strings } from '../strings';
import { replyText } from './brain';
import { summaryLine } from './describe';
import { addReminder, takeDueReminders, type Reminder } from './memory';

export interface Notice {
  id: string;
  threadId: string;
  title: string;
  /** The answer's first sentence; empty while it is read, or when there is none. */
  line: string;
  failed: boolean;
  /** When it came, epoch milliseconds: it goes a while after, unless held in view. */
  at: number;
}

export interface NotesHost {
  client(): Client | null;
  threads(): ThreadSummary[];
  ownThreads(): readonly string[];
  /** The pointer is on the companion or its panel is open: notices stay. */
  holding(): boolean;
  rang(reminders: Reminder[]): void;
  /** Focus holds a finished thread back: true when it took the notice. */
  setAside?(notice: Notice): boolean;
  /** The final answer of a finished thread the notes read, whole. */
  answered?(text: string): void;
}

const NOTICE_MS = 15_000;
const SNOOZE_MS = 10 * 60_000;
const MAX_NOTICES = 3;
/** The mood tracker reports a finished thread for a few seconds: one notice for it. */
const SAME_FINISH_MS = 30_000;
/** Enough messages to reach back past a few tool calls to the answer's text. */
const TAIL = 12;
/** An alarm nobody answers rings again, a few times. */
const RING_AGAIN_MS = 60_000;
const RINGS = 3;

export class Notes {
  notices = $state<Notice[]>([]);
  alarms = $state<Reminder[]>([]);
  private readonly noticed = new Map<string, number>();
  /** The last time the notices were held in view. */
  private heldAt = 0;
  /** When the alarms last rang, and how many times. */
  private rungAt = 0;
  private rings = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly host: NotesHost) {
    this.timer = setInterval(() => this.tick(), 1000);
  }

  /** The threads the mood tracker saw finish. */
  finished(ids: string[]): void {
    const now = Date.now();
    for (const threadId of ids) {
      if (this.host.ownThreads().includes(threadId) || now - (this.noticed.get(threadId) ?? 0) < SAME_FINISH_MS) continue;
      this.noticed.set(threadId, now);
      const thread = this.host.threads().find((entry) => entry.id === threadId);
      const notice: Notice = {
        id: `${threadId}:${now}`,
        threadId,
        title: thread?.title || strings.companion.untitled,
        line: '',
        failed: thread?.status === 'error',
        at: now
      };
      if (this.host.setAside?.(notice)) continue;
      this.notices = [notice, ...this.notices.filter((entry) => entry.threadId !== threadId)].slice(0, MAX_NOTICES);
      void this.summarize(notice.id, threadId, notice.failed);
    }
  }

  private async summarize(id: string, threadId: string, failed: boolean) {
    const client = this.host.client();
    if (!client) return;
    try {
      // `threads.get` hands the thread's last messages; `messages.list` wants a cursor.
      const { messages } = await client.call('threads.get', { threadId, limit: TAIL, compactTools: true, compactFiles: true, compactImages: true });
      // The answer's last words, back to the request: its final message may be only tool calls.
      let line = '';
      let text = '';
      for (const message of [...messages].reverse()) {
        if (message.role === 'user') break;
        if (message.role === 'assistant') {
          text = replyText(message);
          line = summaryLine(text);
        }
        if (line) break;
      }
      if (line) this.notices = this.notices.map((notice) => (notice.id === id ? { ...notice, line } : notice));
      if (text && !failed) this.host.answered?.(text);
    } catch {
      /* the title alone says it */
    }
  }

  dismiss(id: string): void {
    this.notices = this.notices.filter((notice) => notice.id !== id);
  }

  done(id: string): void {
    this.alarms = this.alarms.filter((alarm) => alarm.id !== id);
  }

  snooze(id: string): void {
    const alarm = this.alarms.find((entry) => entry.id === id);
    this.done(id);
    if (alarm) addReminder(alarm.text, Date.now() + SNOOZE_MS);
  }

  private tick() {
    const now = Date.now();
    if (this.host.holding()) this.heldAt = now;
    const gone = (notice: Notice) => now - Math.max(notice.at, this.heldAt) > NOTICE_MS;
    if (this.notices.some(gone)) this.notices = this.notices.filter((notice) => !gone(notice));
    const due = takeDueReminders(now);
    if (due.length > 0) {
      this.alarms = [...this.alarms, ...due];
      this.rungAt = now;
      this.rings = 1;
      this.host.rang(due);
    } else if (this.alarms.length > 0 && this.rings < RINGS && now - this.rungAt >= RING_AGAIN_MS) {
      // Nobody answered: the user may have been away from the screen.
      this.rungAt = now;
      this.rings++;
      this.host.rang([]);
    }
  }

  dispose(): void {
    clearInterval(this.timer);
  }
}
