import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ImageAttachment, MessagePart, RpcEvents, ToolDocument } from '@boite/contracts';
import { echoThread, scriptedClaude, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

let harness: TestCore;

beforeEach(async () => {
  harness = await startTestCore();
});

afterEach(async () => {
  await harness.stop();
});

describe('echo driver', () => {
  test('a turn streams the prompt back, then finishes with usage', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('threads.subscribe', { threadId });

    const prompt = 'the echo driver streams this prompt back in small chunks';
    const deltas: string[] = [];
    client.on('message.delta', (event) => {
      if (event.threadId === threadId) deltas.push(event.text);
    });

    const started = client.next('message.started', (message) => message.role === 'assistant');
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);

    const turn = await client.call('turns.start', { threadId, prompt });
    expect(turn.status).toBe('queued');

    const assistant = await started;
    expect(assistant.threadId).toBe(threadId);

    const completed = await client.next(
      'message.completed',
      (event) => event.messageId === assistant.id,
      10000,
    );
    expect(completed.state).toBe('complete');
    expect(deltas.join('')).toBe(prompt);

    const done = await finished;
    expect(done.status).toBe('done');
    expect(done.usage?.outputTokens).toBe(prompt.split(' ').length);
    expect(done.usage?.inputTokens).toBe(prompt.split(' ').length);
    expect(done.usage?.cacheReadTokens).toBe(0);
    expect(done.usage?.costUsdEquivalent).toBeNull();

    const thread = await client.call('threads.get', { threadId });
    expect(thread.status).toBe('idle');
    expect(thread.sessionId).toBe(`echo-${threadId}`);
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[0]?.role).toBe('user');
    expect(thread.messages[1]?.parts).toEqual([{ type: 'text', text: prompt }]);
  });

  test('a think directive streams a thinking part in two deltas before the text', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('threads.subscribe', { threadId });

    const deltas: { partIndex: number; text: string }[] = [];
    client.on('message.delta', (event) => {
      if (event.threadId === threadId) deltas.push({ partIndex: event.partIndex, text: event.text });
    });

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: '[think]what the echo says' });
    expect((await finished).status).toBe('done');

    const thread = await client.call('threads.get', { threadId });
    expect(thread.messages[1]?.parts).toEqual([
      { type: 'thinking', text: 'thinking about: what the echo says' },
      { type: 'text', text: 'what the echo says' },
    ]);
    // Two deltas on the thinking part, whatever the journal coalesced after them.
    expect(deltas.filter((delta) => delta.partIndex === 0).map((delta) => delta.text).join('')).toBe(
      'thinking about: what the echo says',
    );
  });

  test('every turn writes the context meter on the thread, and a compact directive lowers it behind a divider', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('threads.subscribe', { threadId });

    const updates: RpcEvents['thread.updated'][] = [];
    client.on('thread.updated', (summary) => {
      if (summary.id === threadId) updates.push(summary);
    });

    let finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'twelve chars' });
    await finished;
    const plain = (await client.call('threads.get', { threadId })).context;
    expect(plain).toMatchObject({ tokens: 112, window: 2000 });
    // The meter reached the subscribers before the turn ended, on the thread itself.
    expect(updates.some((summary) => summary.context?.tokens === 112)).toBe(true);

    finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'before [compact] after' });
    await finished;
    const thread = await client.call('threads.get', { threadId });
    expect(thread.context).toMatchObject({ tokens: 300, window: 2000 });
    expect(thread.messages[3]?.parts).toEqual([
      { type: 'text', text: 'before ' },
      { type: 'compaction', trigger: 'auto', preTokens: 1800, postTokens: 300 },
      { type: 'text', text: ' after' },
    ]);
  });

  test('a tool directive produces a running then a done tool part', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('threads.subscribe', { threadId });

    const parts: MessagePart[] = [];
    client.on('message.part', (event) => {
      if (event.threadId === threadId) parts.push(event.part);
    });

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'run [tool] now' });
    await finished;

    const tools = parts.filter((part) => part.type === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ name: 'fake_tool', status: 'running', output: null });
    expect(tools[1]).toMatchObject({ name: 'fake_tool', status: 'done', output: 'ok' });
  });

  test('a tool-stream directive types the input as deltas before the parsed one lands', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('threads.subscribe', { threadId });

    const parts: { partIndex: number; part: MessagePart }[] = [];
    const deltas: { partIndex: number; text: string }[] = [];
    client.on('message.part', (event) => {
      if (event.threadId === threadId) parts.push({ partIndex: event.partIndex, part: event.part });
    });
    client.on('message.delta', (event) => {
      if (event.threadId === threadId) deltas.push({ partIndex: event.partIndex, text: event.text });
    });

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'run [tool-stream] now' });
    expect((await finished).status).toBe('done');

    const json = '{"command":"echo streamed","description":"a streamed input"}';
    const opened = parts.find((entry) => entry.part.type === 'tool');
    expect(opened?.part).toMatchObject({ type: 'tool', name: 'Bash', input: {}, inputText: '' });
    const at = opened?.partIndex ?? -1;

    const typed = deltas.filter((delta) => delta.partIndex === at);
    expect(typed.length).toBeGreaterThan(1);
    expect(typed.map((delta) => delta.text).join('')).toBe(json);

    const thread = await client.call('threads.get', { threadId });
    expect(thread.messages[1]?.parts[at]).toMatchObject({
      type: 'tool',
      name: 'Bash',
      input: JSON.parse(json) as Record<string, unknown>,
      inputText: null,
      output: 'streamed',
      status: 'done',
    });
  });

  test('the diff, doc and image directives each carry their document on the tool part', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('threads.subscribe', { threadId });

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: '[diff][doc][image]' });
    expect((await finished).status).toBe('done');

    const thread = await client.call('threads.get', { threadId });
    const tools = (thread.messages[1]?.parts ?? []).filter((part) => part.type === 'tool');
    expect(tools.map((part) => (part.type === 'tool' ? part.name : ''))).toEqual(['Edit', 'Read', 'Screenshot']);

    const documentsOf = (at: number): ToolDocument[] => {
      const part = tools[at];
      return part?.type === 'tool' ? (part.documents ?? []) : [];
    };

    const diff = documentsOf(0)[0];
    expect(diff?.kind).toBe('diff');
    if (diff?.kind !== 'diff') throw new Error('the first document is not a diff');
    expect(diff.path).toBe('src/app.ts');
    expect(diff.oldText.split('\n')).toHaveLength(3);
    // The middle line changed and one line was added.
    expect(diff.newText.split('\n')).toHaveLength(4);
    expect(diff.newText).toContain('warm: true');

    const doc = documentsOf(1)[0];
    expect(doc).toMatchObject({ kind: 'markdown', title: 'README.md' });
    const text = doc?.kind === 'markdown' ? doc.text : '';
    expect(text.split('\n')).toHaveLength(6);
    expect(text).toContain('# README');
    expect(text).toContain('- the first item');
    expect(text).toContain('```ts');

    const image = documentsOf(2)[0];
    expect(image).toMatchObject({ kind: 'image', mimeType: 'image/png', alt: 'one pixel' });
    // Base64 with no `data:` prefix, and a real PNG behind it.
    const data = image?.kind === 'image' ? image.data : '';
    expect(data.startsWith('data:')).toBe(false);
    expect([...Buffer.from(data, 'base64').subarray(0, 4)]).toEqual([137, 80, 78, 71]);
  });

  test('an image sent with the prompt is journalled on the user message and named back by the agent', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('threads.subscribe', { threadId });

    // A one-pixel PNG, 70 bytes, as the composer would send it.
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', {
      threadId,
      prompt: 'what is this',
      attachments: [{ kind: 'image', mimeType: 'image/png', data: png, name: 'pixel.png' }],
    });
    expect((await finished).status).toBe('done');

    const thread = await client.call('threads.get', { threadId });
    expect(thread.messages[0]?.parts).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image', mimeType: 'image/png', data: png, alt: 'pixel.png' },
    ]);
    expect(thread.messages[1]?.parts).toEqual([{ type: 'text', text: '[image image/png, 70 bytes, pixel.png] what is this' }]);
  });

  test('an attachment is refused by name: the format, the body, the weight, the count', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const image = (over: Partial<{ mimeType: string; data: string; name: string | null }>): ImageAttachment =>
      ({ kind: 'image', mimeType: 'image/png', data: png, name: 'pixel.png', ...over }) as ImageAttachment;

    await expect(
      client.call('turns.start', { threadId, prompt: 'x', attachments: [image({ mimeType: 'image/bmp' })] }),
    ).rejects.toThrow('pixel.png: image/bmp is not an image format an agent reads');
    await expect(
      client.call('turns.start', { threadId, prompt: 'x', attachments: [image({ data: 'data:image/png;base64,abcd' })] }),
    ).rejects.toThrow('pixel.png: the image data is not base64');
    await expect(
      client.call('turns.start', { threadId, prompt: 'x', attachments: [image({ data: 'A'.repeat(7 * 1048576), name: null })] }),
    ).rejects.toThrow('attachment 1: 5.3 MB is over the 5 MB an image may weigh');
    await expect(
      client.call('turns.start', { threadId, prompt: 'x', attachments: Array.from({ length: 9 }, () => image({})) }),
    ).rejects.toThrow('a turn carries at most 8 images, this one has 9');

    // Nothing above started a turn, so the thread is still idle and empty.
    const thread = await client.call('threads.get', { threadId });
    expect(thread.status).toBe('idle');
    expect(thread.messages).toHaveLength(0);
  });

  test('a permission directive waits for the answer, then continues', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('threads.subscribe', { threadId });

    const requested = client.next('permission.requested', (request) => request.threadId === threadId, 10000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: '[permission]' });

    const request = await requested;
    expect(request.toolName).toBe('fake_tool');
    expect((await client.call('threads.get', { threadId })).status).toBe('waiting');

    const resolved = client.next('permission.resolved', (event) => event.requestId === request.id, 10000);
    await client.call('permissions.answer', { requestId: request.id, decision: 'allow' });
    expect((await resolved).decision).toBe('allow');

    const done = await finished;
    expect(done.status).toBe('done');

    const thread = await client.call('threads.get', { threadId });
    const assistant = thread.messages[thread.messages.length - 1];
    expect(assistant?.parts[0]).toMatchObject({ type: 'permission', requestId: request.id, decision: 'allow' });
    expect(assistant?.parts[1]).toEqual({ type: 'text', text: 'allowed' });
  });

  test('a pending permission is listed to a client that never subscribed, and gone once answered', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const other = await echoThread(harness, client, 'the thread nobody asked about');
    await client.call('threads.subscribe', { threadId });

    const requested = client.next('permission.requested', (request) => request.threadId === threadId, 10000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: '[permission]' });
    const request = await requested;

    // A second client, connected after the request and subscribed to nothing:
    // the event never reached it, the method has to.
    const latecomer = await harness.connect();
    const pending = await latecomer.call('permissions.list', {});
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(request.id);
    expect(pending[0]?.threadId).toBe(threadId);
    expect(pending[0]?.turnId).toBe(request.turnId);
    expect(pending[0]?.toolName).toBe('fake_tool');
    expect(pending[0]?.input).toEqual({ echo: true });

    expect(await latecomer.call('permissions.list', { threadId })).toHaveLength(1);
    expect(await latecomer.call('permissions.list', { threadId: other.threadId })).toEqual([]);

    await latecomer.call('permissions.answer', { requestId: request.id, decision: 'allow' });
    expect((await finished).status).toBe('done');
    expect(await latecomer.call('permissions.list', {})).toEqual([]);
  });

  test('a question draws a card, is listed while it waits, and the answer comes back', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const other = await echoThread(harness, client, 'the thread nobody asked about');
    await client.call('threads.subscribe', { threadId });

    const asked = client.next('question.asked', (request) => request.threadId === threadId, 10000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'question' });

    const question = await asked;
    expect(question.text).toBe('Which shape should the echo take?');
    expect(question.options.map((option) => option.id)).toEqual(['short', 'long']);
    expect(question.allowText).toBe(true);
    expect(question.multiple).toBe(false);
    expect((await client.call('threads.get', { threadId })).status).toBe('waiting');

    // A client that connected after the question, subscribed to nothing: the
    // event never reached it, the method has to.
    const latecomer = await harness.connect();
    const pending = await latecomer.call('questions.list', {});
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(question.id);
    expect(pending[0]?.turnId).toBe(question.turnId);
    expect(await latecomer.call('questions.list', { threadId })).toHaveLength(1);
    expect(await latecomer.call('questions.list', { threadId: other.threadId })).toEqual([]);

    const answered = client.next('question.answered', (event) => event.questionId === question.id, 10000);
    await latecomer.call('questions.answer', {
      threadId,
      questionId: question.id,
      optionIds: ['short'],
      text: 'one line please',
    });
    expect((await answered).answer).toEqual({ optionIds: ['short'], text: 'one line please' });
    expect(await latecomer.call('questions.list', {})).toEqual([]);

    expect((await finished).status).toBe('done');
    const thread = await client.call('threads.get', { threadId });
    const assistant = thread.messages[thread.messages.length - 1];
    expect(assistant?.parts[0]).toMatchObject({
      type: 'question',
      questionId: question.id,
      answer: { optionIds: ['short'], text: 'one line please' },
    });
    expect(assistant?.parts[1]).toEqual({ type: 'text', text: 'answered short one line please' });
  });

  test('a question refuses an unknown id, an option nobody offered and an empty answer', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('threads.subscribe', { threadId });

    await expect(
      client.call('questions.answer', { threadId, questionId: 'qst_nobody', optionIds: ['short'] }),
    ).rejects.toThrow(/qst_nobody/);

    const asked = client.next('question.asked', (request) => request.threadId === threadId, 10000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'question' });
    const question = await asked;

    await expect(
      client.call('questions.answer', { threadId, questionId: question.id, optionIds: ['purple'] }),
    ).rejects.toThrow(/options/);
    await expect(
      client.call('questions.answer', { threadId, questionId: question.id, optionIds: [] }),
    ).rejects.toThrow(/option or some text/);
    // Refused and still pending: the card is answerable after a bad try.
    expect(await client.call('questions.list', { threadId })).toHaveLength(1);

    await client.call('questions.answer', { threadId, questionId: question.id, optionIds: ['long'] });
    expect((await finished).status).toBe('done');
  });

  test('a turn stopped while a question waits cancels it', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('threads.subscribe', { threadId });

    const asked = client.next('question.asked', (request) => request.threadId === threadId, 10000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'question' });
    const question = await asked;

    const answered = client.next('question.answered', (event) => event.questionId === question.id, 10000);
    expect((await client.call('turns.stop', { threadId })).stopped).toBe(true);

    expect((await answered).answer).toBeNull();
    expect((await finished).status).toBe('stopped');
    expect(await client.call('questions.list', {})).toEqual([]);
    expect((await client.call('threads.get', { threadId })).status).toBe('idle');
  });

  test('a turn stopped while a permission card is open denies it and the turn really ends', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('threads.subscribe', { threadId });

    const requested = client.next('permission.requested', (request) => request.threadId === threadId, 10000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: '[permission]' });
    const request = await requested;
    expect((await client.call('threads.get', { threadId })).status).toBe('waiting');

    // Before the fix this stopped nothing: the driver stayed parked on the
    // card, no turn.finished ever fired and the thread stayed `waiting`.
    const resolved = client.next('permission.resolved', (event) => event.requestId === request.id, 10000);
    expect((await client.call('turns.stop', { threadId })).stopped).toBe(true);

    expect((await resolved).decision).toBe('deny');
    expect((await finished).status).toBe('stopped');
    expect(await client.call('permissions.list', {})).toEqual([]);
    expect((await client.call('threads.get', { threadId })).status).toBe('idle');
  });

  test('with two cards open, answering one keeps the thread waiting on the other', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('threads.subscribe', { threadId });

    const raised: string[] = [];
    client.on('permission.requested', (request) => {
      if (request.threadId === threadId) raised.push(request.id);
    });
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: '[permission:2]' });
    await waitFor(() => raised.length === 2);
    const cards = await client.call('permissions.list', { threadId });
    expect(cards).toHaveLength(2);
    expect((await client.call('threads.get', { threadId })).status).toBe('waiting');

    // Answering the first used to put the thread back to `running` with a card
    // still on screen, so the header said the agent was working on nothing.
    await client.call('permissions.answer', { requestId: cards[0]?.id ?? '', decision: 'allow' });
    expect((await client.call('threads.get', { threadId })).status).toBe('waiting');
    expect(await client.call('permissions.list', { threadId })).toHaveLength(1);

    await client.call('permissions.answer', { requestId: cards[1]?.id ?? '', decision: 'allow' });
    expect((await finished).status).toBe('done');
    expect(await client.call('permissions.list', { threadId })).toEqual([]);
  });

  test('an unsubscribed connection gets thread.updated but no message.delta', async () => {
    const subscriber = await harness.connect();
    const watcher = await harness.connect();
    const { threadId } = await echoThread(harness, subscriber);
    await subscriber.call('threads.subscribe', { threadId });

    const seen: string[] = [];
    watcher.onAny((event) => seen.push(event));

    const finished = subscriber.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await subscriber.call('turns.start', { threadId, prompt: 'nobody is watching this one closely' });
    await finished;

    expect(seen).toContain('thread.updated');
    expect(seen).not.toContain('message.delta');
    expect(seen).not.toContain('message.started');
  });

  test('a spawn directive traces the child and appends its output', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('threads.subscribe', { threadId });

    const started: RpcEvents['process.started'][] = [];
    client.on('process.started', (record) => {
      if (record.threadId === threadId) started.push(record);
    });
    const exited = client.next('process.exited', (record) => record.threadId === threadId, 10000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 15000);

    await client.call('turns.start', { threadId, prompt: '[spawn:echo hello]' });
    const done = await finished;
    expect(done.status).toBe('done');

    expect(started).toHaveLength(1);
    expect(started[0]?.commandLine).toContain('echo hello');
    const exitEvent = await exited;
    expect(exitEvent.exitCode).toBe(0);

    const thread = await client.call('threads.get', { threadId });
    const assistant = thread.messages[thread.messages.length - 1];
    const text = assistant?.parts.map((part) => (part.type === 'text' ? part.text : '')).join('') ?? '';
    expect(text).toContain('hello');

    const trace = await client.call('trace.get', { threadId });
    expect(trace).toHaveLength(1);
    expect(trace[0]?.exitCode).toBe(0);
    // The child wrote `hello` into a pipe, so WriteTransferCount is above zero
    // wherever Job Objects read the counters. Elsewhere the poll path measures
    // nothing and the field stays null.
    if (process.platform === 'win32') {
      expect(trace[0]?.ioBytes).toBeGreaterThan(0);
    } else {
      expect(trace[0]?.ioBytes).toBeNull();
    }
    expect(exitEvent.ioBytes).toBe(trace[0]?.ioBytes ?? null);
  });

  test('an error directive fails the turn loudly', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('threads.subscribe', { threadId });

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'this [error] ends it' });
    const done = await finished;
    expect(done.status).toBe('error');
    expect(done.error).toBe('echo error requested');
    expect((await client.call('threads.get', { threadId })).status).toBe('error');
  });

  test('turns.start on a claude account with no login fails with Unavailable', async () => {
    scriptedClaude(harness);
    const client = await harness.connect();
    const project = await client.call('projects.add', { path: harness.dataDir, name: 'claude project' });
    const account = await client.call('accounts.add', { providerId: 'claude', label: 'no login' });
    expect(account.status).toBe('unauthenticated');

    const thread = await client.call('threads.create', {
      projectId: project.id,
      providerId: 'claude',
      accountId: account.id,
    });
    expect(thread.model).toBe('claude-sonnet-5');

    let failure = 'none';
    try {
      await client.call('turns.start', { threadId: thread.id, prompt: 'hello' });
    } catch (error) {
      failure = (error as Error).message;
    }
    expect(failure).toBe('the account no login is not logged in');
  });

  test('a model change resets the effort to the new model default, and an unknown level is refused', async () => {
    const client = await harness.connect();
    const project = await client.call('projects.add', { path: harness.dataDir, name: 'claude project' });
    const account = await client.call('accounts.add', { providerId: 'claude', label: 'effort seat' });
    const thread = await client.call('threads.create', {
      projectId: project.id,
      providerId: 'claude',
      accountId: account.id,
      effort: 'xhigh',
    });
    expect(thread.effort).toBe('xhigh');

    // Only the model moves: the effort goes back to null, the new model's own default.
    const moved = await client.call('threads.update', { threadId: thread.id, model: 'claude-opus-4-7' });
    expect(moved.model).toBe('claude-opus-4-7');
    expect(moved.effort).toBeNull();

    // The model and a level in the same call: the level is checked against the new model.
    const both = await client.call('threads.update', { threadId: thread.id, model: 'claude-opus-5', effort: 'max' });
    expect(both.effort).toBe('max');

    let failure = 'none';
    try {
      await client.call('threads.update', { threadId: thread.id, model: 'claude-opus-4-7', effort: 'max' });
    } catch (error) {
      failure = (error as Error).message;
    }
    expect(failure).toBe('the model does not offer this reasoning effort');
  });

  test('a finished turn on an unwatched thread marks it unread until markRead', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'unread please' });
    await finished;

    expect((await client.call('threads.get', { threadId })).unread).toBe(true);
    await client.call('threads.markRead', { threadId });
    expect((await client.call('threads.get', { threadId })).unread).toBe(false);
  });

  test('a pin is kept in the journal and survives a restart, and pinning twice is not an update', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    expect((await client.call('threads.get', { threadId })).pinned).toBe(false);

    const updates: boolean[] = [];
    client.on('thread.updated', (summary) => {
      if (summary.id === threadId) updates.push(summary.pinned);
    });
    expect((await client.call('threads.pin', { threadId })).pinned).toBe(true);
    expect((await client.call('threads.pin', { threadId })).pinned).toBe(true);
    expect(updates).toEqual([true]);

    const reopened = harness.core.journal.getThread(threadId);
    expect(reopened?.pinned).toBe(true);

    expect((await client.call('threads.pin', { threadId, pinned: false })).pinned).toBe(false);
    expect((await client.call('threads.list', {})).find((t) => t.id === threadId)?.pinned).toBe(false);
  });

  test('the agent lists its slash commands once, a /command reaches it, and archiving forgets them', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    expect((await client.call('threads.get', { threadId })).commands).toEqual([]);

    const listed: RpcEvents['thread.commands'][] = [];
    client.on('thread.commands', (event) => {
      if (event.threadId === threadId) listed.push(event);
    });

    let finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: '/shout the echo hears this' });
    expect((await finished).status).toBe('done');

    const shouted = await client.call('threads.get', { threadId });
    expect(shouted.messages[1]?.parts).toEqual([{ type: 'text', text: 'THE ECHO HEARS THIS' }]);
    expect(shouted.commands).toEqual([
      { name: 'shout', description: 'The prompt back in capitals', hint: '<text>' },
      { name: 'whisper', description: 'The prompt back as it came', hint: null },
    ]);

    // The same list on the second turn is no event: the clients only hear a change.
    finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'plain' });
    expect((await finished).status).toBe('done');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.commands.map((command) => command.name)).toEqual(['shout', 'whisper']);

    await client.call('threads.archive', { threadId });
    expect((await client.call('threads.get', { threadId })).commands).toEqual([]);
  });
});
