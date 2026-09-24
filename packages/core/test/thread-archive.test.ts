import { expect, spyOn, test } from 'bun:test';
import { echoThread, startTestCore } from './harness.ts';

test('archiving persists immediately and waits for browser cleanup before returning', async () => {
  const harness = await startTestCore();
  const owner = await harness.connect();
  const { threadId } = await echoThread(harness, owner);
  const oldKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'test-only-key';
  let releaseCleanup!: () => void;
  const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
  const stop = spyOn(harness.core.browser, 'stopThread').mockImplementation(() => cleanup);
  try {
    await harness.core.browser.configure({ enabled: true, executablePath: null });
    let returned = false;
    const archived = Promise.resolve(harness.core.threads.archive(threadId, true)).then(thread => {
      returned = true;
      return thread;
    });

    expect(harness.core.threads.require(threadId).archived).toBe(true);
    expect(harness.core.journal.listThreads().find(thread => thread.id === threadId)?.archived).toBe(true);
    expect(stop).toHaveBeenCalledWith(threadId);
    expect(() => harness.core.browser.start({ threadId, pluginId: 'jev-browser', url: 'https://example.org', goal: 'Open page', completion: { text: 'Example' } })).toThrow('Unarchive the thread');
    await Promise.resolve();
    expect(returned).toBe(false);

    releaseCleanup();
    expect((await archived).archived).toBe(true);
    expect(returned).toBe(true);
    expect((await harness.core.threads.archive(threadId, false)).archived).toBe(false);
    expect(harness.core.threads.require(threadId).archived).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
  } finally {
    releaseCleanup();
    stop.mockRestore();
    if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = oldKey;
    await harness.stop();
  }
});

test('removing a project archives every thread before waiting for each browser cleanup once', async () => {
  const harness = await startTestCore();
  const owner = await harness.connect();
  const first = await echoThread(harness, owner);
  const second = await echoThread(harness, owner);
  const projectId = harness.core.threads.require(first.threadId).projectId;
  const releases = new Map<string, () => void>();
  const pending = new Map([first.threadId, second.threadId].map(id => [id,
    new Promise<void>(resolve => { releases.set(id, resolve); }),
  ]));
  const stop = spyOn(harness.core.browser, 'stopThread').mockImplementation(id => pending.get(id)!);
  try {
    let removed = false;
    const removal = harness.core.projects.remove(projectId).then(() => { removed = true; });
    expect(harness.core.threads.require(first.threadId).archived).toBe(true);
    expect(harness.core.threads.require(second.threadId).archived).toBe(true);
    expect(stop).toHaveBeenCalledTimes(2);
    releases.get(first.threadId)!();
    await Promise.resolve();
    expect(removed).toBe(false);
    expect(harness.core.projects.list().some(project => project.id === projectId)).toBe(true);
    releases.get(second.threadId)!();
    await removal;
    expect(removed).toBe(true);
    expect(harness.core.projects.list()).toEqual([]);
    expect(harness.core.journal.listThreads()).toEqual([]);
    expect(stop).toHaveBeenCalledTimes(2);
  } finally {
    for (const release of releases.values()) release();
    stop.mockRestore();
    await harness.stop();
  }
});
