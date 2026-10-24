import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ThreadSummary, Turn } from '@boite/contracts';
import {
  finishNotifies,
  limitsKey,
  limitsMachine,
  limitToast,
  NOTIFICATION_MUTED_STORAGE_KEY,
  NOTIFICATIONS_STORAGE_KEY,
  pushKinds,
  onNotificationOpen,
  pushCovers,
  readNotificationKinds,
  readNotifications,
  sendNotification,
  setNotificationSender,
  shouldNotify,
  toastFor,
  writeNotificationKinds,
  writeNotifications,
  type Toast
} from './notify';

describe('shouldNotify', () => {
  const all = ['approvals', 'questions', 'finished', 'errors', 'limits'] as const;
  const base = { kind: 'finished' as const, threadId: 't-1', openThreadId: 't-1', focused: true, enabled: true, kinds: all };

  test('the open thread on a focused window is already on the screen', () => {
    expect(shouldNotify(base)).toBe(false);
  });

  test('another thread, or another window, gets the toast', () => {
    expect(shouldNotify({ ...base, openThreadId: 't-2' })).toBe(true);
    expect(shouldNotify({ ...base, openThreadId: null })).toBe(true);
    expect(shouldNotify({ ...base, focused: false })).toBe(true);
  });

  test('a request for user input notifies even in the focused open thread', () => {
    expect(shouldNotify({ ...base, kind: 'approvals' })).toBe(true);
    expect(shouldNotify({ ...base, kind: 'questions' })).toBe(true);
    expect(shouldNotify({ ...base, kind: 'approvals', enabled: false })).toBe(false);
  });

  test('a device that kept only approvals hears of a permission, not of a finished turn, a failure or a question', () => {
    const elsewhere = { ...base, openThreadId: null, focused: false, kinds: ['approvals'] as const };
    expect(shouldNotify({ ...elsewhere, kind: 'approvals' })).toBe(true);
    expect(shouldNotify({ ...elsewhere, kind: 'finished' })).toBe(false);
    expect(shouldNotify({ ...elsewhere, kind: 'errors' })).toBe(false);
    expect(shouldNotify({ ...elsewhere, kind: 'questions' })).toBe(false);
  });

  test('the switch off wins over everything', () => {
    expect(shouldNotify({ ...base, focused: false, openThreadId: null, enabled: false })).toBe(false);
  });
});

describe('finishNotifies', () => {
  const thread = (id: string, extra: Partial<ThreadSummary> = {}) => ({ id, status: 'idle', ...extra }) as ThreadSummary;
  const turn = (threadId: string, status: Turn['status'], operation?: 'compact' | 'delegation' | 'routine', quiet = false) =>
    ({ threadId, status, ...(operation ? { execution: { operation } } : {}), ...(quiet ? { quiet: true as const } : {}) }) as Pick<Turn, 'threadId' | 'status' | 'execution' | 'quiet'>;

  test('a delegated agent never, its parent once the team is done', () => {
    const busy = [thread('root'), thread('child', { parentThreadId: 'root', status: 'running' })];
    expect(finishNotifies(busy, turn('child', 'done'))).toBe(false);
    expect(finishNotifies(busy, turn('child', 'error'))).toBe(false);
    expect(finishNotifies(busy, turn('root', 'done'))).toBe(false);
    expect(finishNotifies(busy, turn('root', 'error'))).toBe(true);
    const idle = [thread('root'), thread('child', { parentThreadId: 'root' })];
    expect(finishNotifies(idle, turn('root', 'done', 'delegation'))).toBe(true);
  });

  test('a persistent agent like any thread unless its wake was quiet, compaction and stops never', () => {
    const threads = [thread('agent', { agentSessionId: 's-1', projectId: null }), thread('plain')];
    expect(finishNotifies(threads, turn('agent', 'done'))).toBe(true);
    expect(finishNotifies(threads, turn('agent', 'done', 'routine', true))).toBe(false);
    expect(finishNotifies(threads, turn('agent', 'error'))).toBe(true);
    expect(finishNotifies(threads, turn('plain', 'done', 'compact'))).toBe(false);
    expect(finishNotifies(threads, turn('plain', 'stopped'))).toBe(false);
    expect(finishNotifies(threads, turn('plain', 'done'))).toBe(true);
    expect(finishNotifies(threads, turn('unknown', 'done'))).toBe(true);
    // A thread this client does not hold yet keeps the turn's own exclusions: a quiet wake or a compaction is no news.
    expect(finishNotifies([], turn('agent', 'done', 'routine', true))).toBe(false);
    expect(finishNotifies([], turn('unknown', 'done', 'compact'))).toBe(false);
  });

  test('a persistent agent\'s memory pass never holds back the answer it follows, a subagent still does', () => {
    const agent = thread('agent', { agentSessionId: 's-1', projectId: null });
    const pass = thread('memory', { parentThreadId: 'agent', status: 'running', createdAt: 100 });
    const finished = { ...turn('agent', 'done'), finishedAt: 100 };
    // Started as the turn ended, before any snapshot named it.
    expect(finishNotifies([agent, pass], finished, new Set())).toBe(true);
    // Named by the snapshot, whenever it started.
    expect(finishNotifies([agent, { ...pass, createdAt: 10 }], turn('agent', 'done'), new Set(['memory']))).toBe(true);
    // A subagent the turn sent and left running is still work the answer waits on.
    expect(finishNotifies([agent, thread('sub', { parentThreadId: 'agent', status: 'running', createdAt: 50 })], finished, new Set())).toBe(false);
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

  test('keeps every kind until one is turned off, stores the ones off, and tells push nothing while off', () => {
    expect(readNotificationKinds()).toEqual(['approvals', 'questions', 'finished', 'errors', 'limits']);
    writeNotificationKinds(['errors', 'approvals']);
    expect(JSON.parse(window.localStorage.getItem(NOTIFICATION_MUTED_STORAGE_KEY)!)).toEqual(['questions', 'finished', 'limits']);
    expect(readNotificationKinds()).toEqual(['approvals', 'errors']);
    expect(pushKinds()).toEqual(['approvals', 'errors']);
    writeNotifications(false);
    expect(pushKinds()).toEqual([]);
    writeNotificationKinds(['approvals', 'questions', 'finished', 'errors', 'limits']);
    expect(window.localStorage.getItem(NOTIFICATION_MUTED_STORAGE_KEY)).toBeNull();
    window.localStorage.setItem(NOTIFICATION_MUTED_STORAGE_KEY, '{broken');
    expect(readNotificationKinds()).toHaveLength(5);
  });
});

describe('toastFor', () => {
  test('names the thread and says what happened', () => {
    expect(toastFor('finished', 't-1', 'Port the scheduler', null)).toEqual({
      title: 'Port the scheduler',
      body: 'Done',
      threadId: 't-1'
    });
    expect(toastFor('errors', 't-1', 'Port the scheduler', 'the model refused')).toEqual({
      title: 'Port the scheduler',
      body: 'the model refused',
      threadId: 't-1'
    });
    expect(toastFor('errors', 't-1', 'Port the scheduler', null).body).toBe('Failed');
    expect(toastFor('questions', 't-1', 'Port the scheduler', null).body).toBe('Needs your answer');
    expect(toastFor('questions', 't-1', 'Port the scheduler', 'Which branch?').body).toBe('Which branch?');
  });
});

describe('limitToast', () => {
  test('names the account and the scoped window, says the share used and keeps the machine for the click', () => {
    const alert = { accountId: 'a', providerId: 'claude', providerName: 'Claude', label: 'Perso', period: 'weekly' as const, threshold: 10,
      window: { id: 'model:Opus', label: 'Weekly · Opus', usedPercent: 91.6, resetsAt: null }, at: 1 };
    expect(limitToast(alert, limitsKey('m1'))).toEqual({ title: 'Claude · Perso · Opus', body: 'Weekly limit: 8% left', threadId: 'boite-limits:m1', limits: true });
    // A gateway entry's label already names its provider.
    expect(limitToast({ ...alert, label: 'Claude Max · chris@', period: 'fiveHour', window: { ...alert.window, label: '5 hours' } }, limitsKey(null)))
      .toEqual({ title: 'Claude Max · chris@', body: '5-hour limit: 8% left', threadId: 'boite-limits:', limits: true });
    expect([limitsMachine('boite-limits:m1'), limitsMachine('boite-limits:'), limitsMachine('["m1","t1"]')]).toEqual(['m1', '', null]);
  });
});

describe('pushCovers', () => {
  afterEach(() => { localStorage.removeItem('boite.web-push'); vi.unstubAllGlobals(); });

  /** A page whose browser holds `subscription`, with the notification permission granted. */
  function device(subscription: object | null) {
    vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission: 'granted' }));
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: vi.fn().mockResolvedValue({ pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription) } }) } });
  }

  test('a device its core pushes to stays quiet: the push is the one notice', async () => {
    device({ endpoint: 'https://web.push.apple.com/x' });
    localStorage.setItem('boite.web-push', 'on');
    expect(await pushCovers(location.origin)).toBe(true);
  });

  test('a device without push, or a toast about another machine, keeps the local notice', async () => {
    device({ endpoint: 'https://web.push.apple.com/x' });
    expect(await pushCovers(location.origin)).toBe(false);
    localStorage.setItem('boite.web-push', 'on');
    expect(await pushCovers('https://remote.test')).toBe(false);
    expect(await pushCovers(undefined)).toBe(false);
    // The flag outlived its subscription.
    device(null);
    expect(await pushCovers(location.origin)).toBe(false);
  });

  test('a notice about a member of the group stays quiet when this device has push: the member forwards it to the push home', async () => {
    device({ endpoint: 'https://web.push.apple.com/x' });
    localStorage.setItem('boite.web-push', 'on');
    expect(await pushCovers('https://remote.test', true)).toBe(true);
    expect(await pushCovers(undefined, true)).toBe(true);
    device(null);
    expect(await pushCovers('https://remote.test', true)).toBe(false);
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

  test('a notice about a machine of another origin goes through the worker with that machine\'s push tag, never the page constructor Android refuses', async () => {
    const showNotification = vi.fn().mockResolvedValue(undefined);
    const browserNotification = vi.fn(function () { throw new TypeError('Illegal constructor'); });
    Object.assign(browserNotification, { permission: 'granted' });
    vi.stubGlobal('Notification', browserNotification);
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: vi.fn().mockResolvedValue({ showNotification }) } });
    const core = 'c'.repeat(64);
    try {
      await sendNotification({ title: 'Which branch?', body: 'Needs you', threadId: '["m2","t-1"]', coreThreadId: 't-1', origin: 'https://remote.test', core });
      expect(showNotification).toHaveBeenCalledWith('Which branch?', expect.objectContaining({ tag: `thread-${core}-t-1`, data: { threadId: 't-1', core } }));
      // No group id known: still the worker, and the window opens it by its own key.
      await sendNotification({ title: 'Which branch?', body: 'Needs you', threadId: '["m3","t-2"]', coreThreadId: 't-2', origin: 'https://other.test' });
      expect(showNotification).toHaveBeenLastCalledWith('Which branch?', expect.objectContaining({ tag: 'thread-["m3","t-2"]', data: { threadId: 't-2', key: '["m3","t-2"]' } }));
      expect(browserNotification).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  test('a limit alert goes through the worker with the data of the core\'s push, never the constructor Android refuses', async () => {
    const showNotification = vi.fn().mockResolvedValue(undefined);
    const browserNotification = vi.fn(function () { throw new TypeError('Illegal constructor'); });
    Object.assign(browserNotification, { permission: 'granted' });
    vi.stubGlobal('Notification', browserNotification);
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: vi.fn().mockResolvedValue({ showNotification }) } });
    const core = 'c'.repeat(64);
    try {
      await sendNotification({ title: 'Claude · Perso', body: 'Weekly limit: 92% used', threadId: 'boite-limits:', limits: true, origin: location.origin });
      expect(showNotification).toHaveBeenLastCalledWith('Claude · Perso', expect.objectContaining({ data: { limits: true } }));
      await sendNotification({ title: 'Codex · Work', body: '5-hour limit: 90% used', threadId: 'boite-limits:m2', limits: true, origin: 'https://remote.test', core });
      expect(showNotification).toHaveBeenLastCalledWith('Codex · Work', expect.objectContaining({ data: { limits: true, core } }));
      expect(browserNotification).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
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
