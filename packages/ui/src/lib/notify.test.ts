import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ThreadSummary, Turn } from '@boite/contracts';
import {
  finishNotifies,
  NOTIFICATIONS_STORAGE_KEY,
  onNotificationOpen,
  readNotifications,
  sendNotification,
  setNotificationSender,
  shouldNotify,
  toastFor,
  writeNotifications,
  type Toast
} from './notify';

describe('shouldNotify', () => {
  const base = { kind: 'done' as const, threadId: 't-1', openThreadId: 't-1', focused: true, enabled: true };

  test('the open thread on a focused window is already on the screen', () => {
    expect(shouldNotify(base)).toBe(false);
  });

  test('another thread, or another window, gets the toast', () => {
    expect(shouldNotify({ ...base, openThreadId: 't-2' })).toBe(true);
    expect(shouldNotify({ ...base, openThreadId: null })).toBe(true);
    expect(shouldNotify({ ...base, focused: false })).toBe(true);
  });

  test('the switch off wins over everything', () => {
    expect(shouldNotify({ ...base, focused: false, openThreadId: null, enabled: false })).toBe(false);
  });
});

describe('finishNotifies', () => {
  const thread = (id: string, extra: Partial<ThreadSummary> = {}) => ({ id, status: 'idle', ...extra }) as ThreadSummary;
  const turn = (threadId: string, status: Turn['status'], operation?: 'compact' | 'delegation') =>
    ({ threadId, status, ...(operation ? { execution: { operation } } : {}) }) as Pick<Turn, 'threadId' | 'status' | 'execution'>;

  test('a delegated agent never, its parent once the team is done', () => {
    const busy = [thread('root'), thread('child', { parentThreadId: 'root', status: 'running' })];
    expect(finishNotifies(busy, turn('child', 'done'))).toBe(false);
    expect(finishNotifies(busy, turn('child', 'error'))).toBe(false);
    expect(finishNotifies(busy, turn('root', 'done'))).toBe(false);
    expect(finishNotifies(busy, turn('root', 'error'))).toBe(true);
    const idle = [thread('root'), thread('child', { parentThreadId: 'root' })];
    expect(finishNotifies(idle, turn('root', 'done', 'delegation'))).toBe(true);
  });

  test('a persistent agent only when it fails, compaction and stops never', () => {
    const threads = [thread('agent', { agentSessionId: 's-1', projectId: null }), thread('plain')];
    expect(finishNotifies(threads, turn('agent', 'done'))).toBe(false);
    expect(finishNotifies(threads, turn('agent', 'error'))).toBe(true);
    expect(finishNotifies(threads, turn('plain', 'done', 'compact'))).toBe(false);
    expect(finishNotifies(threads, turn('plain', 'stopped'))).toBe(false);
    expect(finishNotifies(threads, turn('plain', 'done'))).toBe(true);
    expect(finishNotifies(threads, turn('unknown', 'done'))).toBe(true);
  });
});

describe('the switch', () => {
  beforeEach(() => window.localStorage.clear());

  test('is on until turned off, and stores nothing while on', () => {
    expect(readNotifications()).toBe(true);
    writeNotifications(false);
    expect(window.localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBe('off');
    expect(readNotifications()).toBe(false);
    writeNotifications(true);
    expect(window.localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBeNull();
    expect(readNotifications()).toBe(true);
  });
});

describe('toastFor', () => {
  test('names the thread and says what happened', () => {
    expect(toastFor('done', 't-1', 'Port the scheduler', null)).toEqual({
      title: 'Port the scheduler',
      body: 'Done',
      threadId: 't-1'
    });
    expect(toastFor('error', 't-1', 'Port the scheduler', 'the model refused')).toEqual({
      title: 'Port the scheduler',
      body: 'the model refused',
      threadId: 't-1'
    });
    expect(toastFor('error', 't-1', 'Port the scheduler', null).body).toBe('Failed');
    expect(toastFor('needs-you', 't-1', 'Port the scheduler', null).body).toBe('Needs your answer');
  });
});

describe('sendNotification', () => {
  afterEach(() => setNotificationSender(null));

  test('a stale push flag still delivers through the worker with the push tag and raw thread id', async () => {
    const showNotification = vi.fn().mockResolvedValue(undefined);
    const browserNotification = vi.fn(function () {});
    Object.assign(browserNotification, { permission: 'granted' });
    vi.stubGlobal('Notification', browserNotification);
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: vi.fn().mockResolvedValue({ showNotification }) } });
    localStorage.setItem('boite.web-push', 'on');
    try {
      await sendNotification({ title: 'Done', body: 'Finished', threadId: '["machine","t-1"]', coreThreadId: 't-1', origin: location.origin });
      expect(showNotification).toHaveBeenCalledWith('Done', expect.objectContaining({ tag: 'thread-t-1', data: { threadId: 't-1' } }));
      expect(browserNotification).not.toHaveBeenCalled();
      showNotification.mockRejectedValueOnce(new Error('worker unavailable'));
      await sendNotification({ title: 'Done', body: 'Finished', threadId: 't-1', coreThreadId: 't-1', origin: location.origin });
      expect(browserNotification).toHaveBeenCalledOnce();
    } finally { localStorage.removeItem('boite.web-push'); vi.unstubAllGlobals(); }
  });

  test('goes through the sender handed in, and swallows what it throws', async () => {
    const sent: Toast[] = [];
    setNotificationSender(async (toast) => {
      sent.push(toast);
    });
    await sendNotification({ title: 'a', body: 'b', threadId: 't-1' });
    expect(sent).toEqual([{ title: 'a', body: 'b', threadId: 't-1' }]);

    setNotificationSender(async () => {
      throw new Error('no surface');
    });
    await expect(sendNotification({ title: 'a', body: 'b', threadId: 't-1' })).resolves.toBeUndefined();
  });

  test('on the web, a click on the toast opens its thread and closes the toast', async () => {
    const shown: FakeNotification[] = [];
    class FakeNotification {
      static permission: NotificationPermission = 'granted';
      static requestPermission = async () => FakeNotification.permission;
      onclick: (() => void) | null = null;
      closed = false;
      constructor(
        public title: string,
        public options: { body?: string; tag?: string }
      ) {
        shown.push(this);
      }
      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal('Notification', FakeNotification);
    const opened: string[] = [];
    const stop = onNotificationOpen((threadId) => opened.push(threadId));
    try {
      await sendNotification({ title: 'Port the scheduler', body: 'Done', threadId: 't-2' });
      expect(shown).toHaveLength(1);
      expect(shown[0]?.options).toEqual({ body: 'Done', tag: 't-2' });
      shown[0]?.onclick?.();
      expect(opened).toEqual(['t-2']);
      expect(shown[0]?.closed).toBe(true);

      localStorage.setItem('boite.web-push', 'on');
      await sendNotification({ title: 'Local', body: 'Done', threadId: 't-local', origin: location.origin });
      expect(shown).toHaveLength(2);
      await sendNotification({ title: 'Remote', body: 'Done', threadId: 't-remote', origin: 'https://remote.test' });
      expect(shown).toHaveLength(3);

      // Permission refused: nothing is shown, nothing throws.
      FakeNotification.permission = 'denied';
      await sendNotification({ title: 'x', body: 'y', threadId: 't-3' });
      expect(shown).toHaveLength(3);
    } finally {
      stop();
      vi.unstubAllGlobals();
    }
  });
});
