/*
 * What the companion says without being asked: another conversation that
 * finished, with the first sentence of its answer, which the user may answer
 * from here, and the reminders it was asked for, which ring here since only
 * this window runs all day.
 */
import type { ThreadSummary } from '@boite/contracts';
import type { Client } from '../client';
import { fill, strings } from '../strings';
import { summaryLine } from './describe';
import { addReminder, takeDueReminders, type Reminder } from './memory';
import { threadText } from './watch';
import { replyInThread } from './watch.svelte';

export interface Notice {
  id: string;
  threadId: string;
  title: string;
  /** The answer's first sentence; empty while it is read, or when there is none. */
  line: string;
  /** The answer whole, shown when the user answers it. */
  text: string;
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
  /** The notice the user answers: it stays until the answer goes. */
  replying = $state<string | null>(null);
  /** Why the answer did not go. */
  replyProblem = $state('');
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
        text: '',
        failed: thread?.status === 'error',
        at: now
      };
      if (this.host.setAside?.(notice)) continue;
      // The notice the user answers stays, past the others.
      const others = this.notices.filter((entry) => entry.threadId !== threadId || entry.id === this.replying);
      this.notices = [notice, ...others].filter((entry, index) => index < MAX_NOTICES || entry.id === this.replying);
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
      const text = threadText(messages).answer;
      const line = summaryLine(text);
      if (text) this.notices = this.notices.map((notice) => (notice.id === id ? { ...notice, line, text } : notice));
      if (text && !failed) this.host.answered?.(text);
    } catch {
      /* the title alone says it */
    }
  }

  dismiss(id: string): void {
    this.notices = this.notices.filter((notice) => notice.id !== id);
    if (this.replying === id) this.replying = null;
  }

  /** The answer field opens under the notice, or closes. */
  answer(id: string | null): void {
    this.replying = id;
    this.replyProblem = '';
  }

  /** The user's words go to the thread as its next prompt. False when they did not go: the field keeps them. */
  async reply(id: string, text: string): Promise<boolean> {
    const client = this.host.client();
    const notice = this.notices.find((entry) => entry.id === id);
    if (!client || !notice || !text.trim()) return false;
    try {
      await replyInThread(client, notice.threadId, text.trim());
      this.dismiss(id);
      return true;
    } catch (error) {
      this.replyProblem = fill(strings.companion.failed, { reason: error instanceof Error ? error.message : String(error) });
      return false;
    }
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
    const gone = (notice: Notice) => notice.id !== this.replying && now - Math.max(notice.at, this.heldAt) > NOTICE_MS;
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
