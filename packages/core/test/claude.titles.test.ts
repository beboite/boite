import { expect, test } from 'bun:test';
import { waitFor } from './harness.ts';
import { assistant, calls, claudeThread, harness, init, scripted, sdk, success, useClaudeHarness } from './fixtures/claude-query.ts';

useClaudeHarness();

test('Claude titles the first request with its images while the main SDK query keeps running', async () => {
  const client = await harness.connect();
  const thread = harness.core.threads.require(await claudeThread(client));
  harness.core.journal.putThread({ ...thread, titleSource: 'prompt', titleState: undefined });
  const release = Promise.withResolvers<void>();
  scripted((fake, options) => {
    if (options.persistSession === false) {
      fake.emit(sdk({ ...success('title'), result: '{"title":"Inspect scheduler image","needsRefinement":false}' }));
      fake.end();
    } else {
      fake.emit(init('main'));
      fake.emit(assistant('main', [{ type: 'text', text: 'Inspecting the scheduler.' }]));
      void release.promise.then(() => { fake.emit(success('main')); fake.end(); });
    }
  });
  const titled = client.next('thread.updated', summary => summary.id === thread.id && summary.titleSource === 'agent', 5000);
  const finished = client.next('turn.finished', turn => turn.threadId === thread.id, 5000);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  try {
    await client.call('turns.start', { threadId: thread.id, prompt: 'inspect the scheduler image', attachments: [{ kind: 'image', mimeType: 'image/png', data: png, name: 'scheduler.png' }] });
    expect(await titled).toMatchObject({ title: 'Inspect scheduler image', status: 'running', titleState: { needsRefinement: false } });
    const titleCall = calls.find(call => call.options.persistSession === false)!;
    await waitFor(() => titleCall.prompts.length > 0);
    expect(titleCall.options.model).toBe('claude-haiku-5-5');
    expect(titleCall.options.tools).toEqual([]);
    expect(titleCall.options.settingSources).toEqual([]);
    expect(titleCall.options.maxTurns).toBe(1);
    expect(titleCall.prompts[0]).toContain('needsRefinement');
    expect(titleCall.prompts[0]).toContain(png);
    expect(calls).toHaveLength(2);
    release.resolve();
    expect((await finished).status).toBe('done');
    expect(calls).toHaveLength(2);
  } finally { release.resolve(); }
});
