import { expect, spyOn, test } from 'bun:test';
import type { AgentProfile } from '@boite/contracts';
import { quietAgent as quiet, startTestCore, waitFor } from './harness.ts';
import { connect } from '../src/client.ts';

test('declared shared write resources serialize agents until the holder stops', async () => {
  const h = await startTestCore();
  try {
    const client = await h.connect();
    const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    const agents: AgentProfile[] = [];
    h.core.workforce.setLimits({ ...h.core.workforce.limits(), paused: true });
    for (const name of ['First', 'Second']) {
      const agent = await client.call('agents.profile.save', { value: { name, domain: '', instructions: '', avatar: '', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' }, status: 'active', tools: ['messages'] } });
      agents.push(agent);
      const scope = { kind: 'agent' as const, id: agent.id };
      await client.call('agents.resource.save', { value: { scope, name: 'Shared files', kind: 'directory', value: h.dataDir, access: 'write' } });
      await client.call('agents.message.send', { scope, recipientIds: [], text: '[sleep:60000]', requestId: `shared_resource_${name}` });
    }
    h.core.workforce.setLimits({ ...h.core.workforce.limits(), paused: false });
    await waitFor(() => h.core.workforce.records.list('run').some(r => r.status === 'running'));
    // An unrelated event makes the runtime reconsider the second item while the lock is held.
    h.core.workforce.changed();
    await client.call('agents.snapshot', {});
    expect(h.core.workforce.records.list('run')).toHaveLength(1);
    const work = h.core.workforce.records.list('work')[0]!;
    await client.call('agents.work.control', { workId: work.id, expectedRevision: work.revision, action: 'cancel' });
    await waitFor(() => h.core.workforce.records.list('run').some(r => r.agentId === agents[1]!.id && r.status === 'running'));
    expect(h.core.workforce.records.list('run').filter(r => r.status === 'running')).toHaveLength(1);
  } finally { await h.stop(); }
});

test('a decision continuation consumes the same group turn allowance', async () => {
  const h = await startTestCore();
  try {
    const client = await h.connect();
    const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    const agent = await client.call('agents.profile.save', { value: { name: 'Worker', domain: '', instructions: '', avatar: '', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' }, status: 'active', tools: ['decisions'] } });
    const group = await client.call('agents.group.save', { value: { name: 'One turn', memberIds: [agent.id], mode: 'round', maxTurns: 1, maxTurnsPerAgent: 1, paused: false } });
    await client.call('agents.message.send', { scope: { kind: 'group', id: group.id }, text: '[sleep:60000]', recipientIds: [], requestId: 'group_decision_001' });
    await waitFor(() => h.core.workforce.records.list('run').some(r => r.status === 'running'));
    const run = h.core.workforce.records.list('run')[0]!;
    const worker = await connect(h.url, h.core.agents.tokenFor(run.threadId));
    const decision = await worker.call('agents.decision.request', { threadId: run.threadId, prompt: 'Continue?', options: [], requestId: 'group_decision_002' });
    await waitFor(() => h.core.scheduler.state().running.length === 0);
    await client.call('agents.decision.answer', { decisionId: decision.id, expectedRevision: decision.revision, answer: 'Continue' });
    await waitFor(() => h.core.workforce.records.list('work').some(w => w.status === 'paused'));
    expect(h.core.workforce.records.list('run')).toHaveLength(1);
    expect(h.core.workforce.records.list('work').at(-1)?.error).toContain('Group turn limit');
    worker.close();
  } finally { await h.stop(); }
});

test('autonomous groups take bounded turns and paused groups retain their deliveries', async () => {
  const h = await startTestCore();
  try {
    const client = await h.connect();
    const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    const agents = [];
    for (const name of ['Researcher', 'Reviewer']) agents.push(await client.call('agents.profile.save', { value: { name, domain: '', instructions: '', avatar: '', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' }, status: 'active', tools: ['messages'] } }));
    // The subagent guide would fill the echo driver's 2,000-token window and add compactions to the count.
    for (const agent of agents) await quiet(client, agent);
    const group = await client.call('agents.group.save', { value: { name: 'Ideas', memberIds: agents.map(a => a.id), mode: 'autonomous', maxTurns: 3, maxTurnsPerAgent: 2, paused: true } });
    await client.call('agents.message.send', { scope: { kind: 'group', id: group.id }, recipientIds: [agents[0]!.id], text: 'Discuss the design', requestId: 'bounded_001' });
    expect(h.core.workforce.records.list('work')).toHaveLength(1);
    await client.call('agents.group.save', { id: group.id, expectedRevision: group.revision, value: { ...group, paused: false } });
    await waitFor(() => h.core.workforce.records.list('work').filter(w => w.status === 'done').length === 3, 10000);
    const snapshot = await client.call('agents.snapshot', {});
    expect(snapshot.work).toHaveLength(3);
    expect(snapshot.messages.filter(m => m.senderId !== null).map(m => m.senderId)).toEqual([agents[0]!.id, agents[1]!.id, agents[0]!.id]);
    expect(snapshot.deliveries.at(-1)?.status).toBe('limited');
  } finally { await h.stop(); }
}, 15000);

test('a persistent agent answers without a project and keeps group contexts separate', async () => {
  const h = await startTestCore();
  try {
    const client = await h.connect();
    const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    const agent = await client.call('agents.profile.save', { value: { name: 'Researcher', domain: '', instructions: 'Be concise.', avatar: '', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' }, status: 'active', tools: ['messages', 'memory'] } });
    const group = await client.call('agents.group.save', { value: { name: 'Ideas', memberIds: [agent.id], mode: 'mentions', maxTurns: 6, maxTurnsPerAgent: 2, paused: false } });
    await client.call('agents.message.send', { scope: { kind: 'agent', id: agent.id }, recipientIds: [agent.id], text: 'private greeting', requestId: 'direct_001' });
    await client.call('agents.message.send', { scope: { kind: 'group', id: group.id }, recipientIds: [agent.id], text: 'shared greeting', requestId: 'shared_001' });
    await waitFor(() => h.core.workforce.records.list('work').filter(w => w.status === 'done').length === 2, 10000);
    const snapshot = await client.call('agents.snapshot', {});
    expect(snapshot.sessions).toHaveLength(2);
    expect(new Set(snapshot.sessions.map(s => s.threadId)).size).toBe(2);
    expect(snapshot.messages.filter(m => m.senderId === agent.id)).toHaveLength(2);
    expect(snapshot.deliveries.every(d => d.status === 'processed')).toBe(true);
    expect(h.core.journal.listProjects()).toEqual([]);
    const groupRun = snapshot.runs.find(r => snapshot.sessions.find(s => s.threadId === r.threadId)?.scope.kind === 'group')!;
    expect('instructions' in groupRun.context).toBe(false);
    expect(h.core.workforce.records.get('run', groupRun.id).context.instructions).not.toContain('private greeting');
    const thread = h.core.threads.require(groupRun.threadId);
    expect(thread.projectId).toBeNull();
    await expect(client.call('turns.start', { threadId: thread.id, prompt: 'bypass scheduling' })).rejects.toThrow('persistent');
    expect((await client.call('agent.where', { threadId: thread.id })).projectId).toBeNull();
    await expect(client.call('todos.list', { threadId: thread.id })).rejects.toThrow('no project');
  } finally { await h.stop(); }
});

test('an idle agent runtime reads nothing until a record changes, then starts the new work', async () => {
  const h = await startTestCore();
  try {
    const client = await h.connect();
    const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    const r = h.core.workforce.records;
    const statusReads = spyOn(r, 'withStatus');
    const listReads = spyOn(r, 'list');
    const settingReads = spyOn(h.core.journal, 'getSetting');
    const limitReads = () => settingReads.mock.calls.filter(call => call[0] === 'agents:limits').length;
    // A tick or two settle it, then three more at 500 ms find it quiet.
    await new Promise(resolve => setTimeout(resolve, 1200));
    const before = { status: statusReads.mock.calls.length, list: listReads.mock.calls.length, limits: limitReads() };
    await new Promise(resolve => setTimeout(resolve, 1600));
    expect(statusReads.mock.calls.length).toBe(before.status);
    expect(listReads.mock.calls.length).toBe(before.list);
    expect(limitReads()).toBe(before.limits);
    const agent = await client.call('agents.profile.save', { value: { name: 'Quiet', domain: '', instructions: '', avatar: '', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' }, status: 'active', tools: ['messages'] } });
    await client.call('agents.message.send', { scope: { kind: 'agent', id: agent.id }, recipientIds: [], text: 'Wake up', requestId: 'quiet_runtime_wake' });
    await waitFor(() => r.list('run').some(run => run.status === 'done'));
  } finally { await h.stop(); }
});

test('what the user attaches to an agent message reaches its turn and stays out of the snapshot', async () => {
  const h = await startTestCore();
  try {
    const client = await h.connect();
    const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    const agent = await client.call('agents.profile.save', { value: { name: 'Looker', domain: '', instructions: '', avatar: '', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' }, status: 'active', tools: ['messages'] } });
    const scope = { kind: 'agent' as const, id: agent.id };
    const sleeper = await client.call('agents.profile.save', { value: { name: 'Sleeper', domain: '', instructions: '', avatar: '', selection: agent.selection, status: 'active', tools: ['messages'] } });
    const sleeping = { kind: 'agent' as const, id: sleeper.id };
    const picture = { kind: 'image' as const, mimeType: 'image/png' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', name: 'pixel.png' };
    const notes = { kind: 'file' as const, mimeType: 'text/plain', data: Buffer.from('two lines\nof notes').toString('base64'), name: 'notes.txt' };
    // While a turn that took them runs, a later turn of the same work (a decision's continuation) gets none.
    const slow = await client.call('agents.message.send', { scope: sleeping, recipientIds: [], text: '[sleep:60000]', attachments: [notes], requestId: 'attach_slow' });
    await waitFor(() => h.core.workforce.records.list('work').some(w => w.messageId === slow.id && w.status === 'running'));
    const running = h.core.workforce.records.list('work').find(w => w.messageId === slow.id)!;
    expect(h.core.journal.getSetting(`agents:attachments:${slow.id}`)).toBeDefined();
    expect(h.core.workforce.attachmentsFor({ ...running, prompt: 'Decision on: which one?' })).toEqual([]);
    const thread = h.core.workforce.records.list('run').find(r => r.workId === running.id)!.threadId;
    const worker = await connect(h.url, h.core.agents.tokenFor(thread));
    // An agent speaks in words: its own messages carry no attachments.
    await expect(worker.call('agents.message.send', { threadId: thread, scope: sleeping, recipientIds: [], text: 'mine', attachments: [notes], requestId: 'attach_002' })).rejects.toThrow(/attachments/);
    worker.close();
    // Cancelled, the work frees them.
    await client.call('agents.work.control', { workId: running.id, expectedRevision: h.core.workforce.records.get('work', running.id).revision, action: 'cancel' });
    expect(h.core.journal.getSetting(`agents:attachments:${slow.id}`)).toBeUndefined();

    // Pictures alone make a message, as they make a prompt.
    const sent = await client.call('agents.message.send', { scope, recipientIds: [], text: '', attachments: [picture, notes], requestId: 'attach_001' });
    expect(sent.attachments).toEqual([{ kind: 'image', mimeType: 'image/png', name: 'pixel.png', bytes: 70 }, { kind: 'file', mimeType: 'text/plain', name: 'notes.txt', bytes: 18 }]);
    expect(JSON.stringify(await client.call('agents.snapshot', {}))).not.toContain(picture.data);
    await waitFor(() => h.core.workforce.records.list('work').some(w => w.messageId === sent.id && w.status === 'done'));
    const run = h.core.workforce.records.list('run').find(r => r.agentId === agent.id)!;
    const prompt = [...h.core.journal.walkTurnMessages(run.threadId, run.turnId!)].find(m => m.role === 'user')!;
    expect(prompt.parts.filter(p => p.type === 'image').length).toBe(1);
    expect(prompt.parts.some(p => p.type === 'file' && p.name === 'notes.txt')).toBe(true);
    // Once every recipient took them, the bytes leave the core's settings.
    expect(h.core.journal.getSetting(`agents:attachments:${sent.id}`)).toBeUndefined();
  } finally { await h.stop(); }
});

test('attachments survive a resume before the turn, and leave once no delivery can run', async () => {
  const h = await startTestCore();
  try {
    const client = await h.connect();
    const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    const selection = { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' as const };
    const agent = await client.call('agents.profile.save', { value: { name: 'Looker', domain: '', instructions: '', avatar: '', selection, status: 'active', tools: ['messages'] } });
    const scope = { kind: 'agent' as const, id: agent.id };
    const notes = (text: string) => ({ kind: 'file' as const, mimeType: 'text/plain', data: Buffer.from(text).toString('base64'), name: 'notes.txt' });
    const held = (id: string) => h.core.journal.getSetting(`agents:attachments:${id}`);
    h.core.workforce.setLimits({ ...h.core.workforce.limits(), paused: true });

    // Paused and resumed before it ever ran: the resume rewrites the prompt, the file still goes.
    const first = await client.call('agents.message.send', { scope, recipientIds: [], text: 'read this', attachments: [notes('first')], requestId: 'attach_resume' });
    let work = h.core.workforce.records.list('work')[0]!;
    work = await client.call('agents.work.control', { workId: work.id, expectedRevision: work.revision, action: 'pause' });
    await client.call('agents.work.control', { workId: work.id, expectedRevision: work.revision, action: 'resume' });
    h.core.workforce.setLimits({ ...h.core.workforce.limits(), paused: false });
    await waitFor(() => h.core.workforce.records.get('work', work.id).status === 'done').catch(e => { console.log('WORK', JSON.stringify(h.core.workforce.records.get('work', work.id))); throw e; });
    const run = h.core.workforce.records.list('run')[0]!;
    const prompt = [...h.core.journal.walkTurnMessages(run.threadId, run.turnId!)].find(m => m.role === 'user')!;
    expect(prompt.parts.some(p => p.type === 'file' && p.name === 'notes.txt')).toBe(true);
    expect(held(first.id)).toBeUndefined();

    // The same request id with other bytes of the same size is another message, refused.
    await expect(client.call('agents.message.send', { scope, recipientIds: [], text: 'read this', attachments: [notes('other')], requestId: 'attach_resume' })).rejects.toThrow(/different input/);

    // A group message nobody receives keeps no bytes.
    const quiet = await client.call('agents.group.save', { value: { name: 'Quiet', memberIds: [agent.id], mode: 'mentions', maxTurns: 4, maxTurnsPerAgent: 2, paused: false } });
    const unheard = await client.call('agents.message.send', { scope: { kind: 'group', id: quiet.id }, recipientIds: [], text: 'fyi', attachments: [notes('fyi')], requestId: 'attach_nobody' });
    expect(unheard.recipientIds).toEqual([]);
    expect(held(unheard.id)).toBeUndefined();

    // An agent archived before its turn: the work is cancelled and the bytes go with it.
    h.core.workforce.setLimits({ ...h.core.workforce.limits(), paused: true });
    const late = await client.call('agents.message.send', { scope, recipientIds: [], text: 'later', attachments: [notes('later')], requestId: 'attach_archived' });
    const profile = h.core.workforce.records.get('profile', agent.id);
    await client.call('agents.profile.save', { id: profile.id, expectedRevision: profile.revision, value: { ...profile, status: 'archived' } });
    h.core.workforce.setLimits({ ...h.core.workforce.limits(), paused: false });
    await waitFor(() => h.core.workforce.records.list('work').some(w => w.messageId === late.id && w.status === 'cancelled'));
    expect(held(late.id)).toBeUndefined();
  } finally { await h.stop(); }
});
