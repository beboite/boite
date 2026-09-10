import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  NOTIFICATIONS_STORAGE_KEY,
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
    expect(toastFor('done', 'Port the scheduler', null)).toEqual({ title: 'Port the scheduler', body: 'Done' });
    expect(toastFor('error', 'Port the scheduler', 'the model refused')).toEqual({
      title: 'Port the scheduler',
      body: 'the model refused'
    });
    expect(toastFor('error', 'Port the scheduler', null).body).toBe('Failed');
    expect(toastFor('needs-you', 'Port the scheduler', null).body).toBe('Needs your answer');
  });
});

describe('sendNotification', () => {
  afterEach(() => setNotificationSender(null));

  test('goes through the sender handed in, and swallows what it throws', async () => {
    const sent: Toast[] = [];
    setNotificationSender(async (toast) => {
      sent.push(toast);
    });
    await sendNotification({ title: 'a', body: 'b' });
    expect(sent).toEqual([{ title: 'a', body: 'b' }]);

    setNotificationSender(async () => {
      throw new Error('no surface');
    });
    await expect(sendNotification({ title: 'a', body: 'b' })).resolves.toBeUndefined();
  });
});
