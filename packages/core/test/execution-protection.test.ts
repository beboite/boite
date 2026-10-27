import {afterEach, expect, test} from 'bun:test';
import {existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkPlan, type AgentLetter} from '@boite/contracts';
import {letterPrompt} from '../src/coordination-letter.ts';
import {ExecutionProtections} from '../src/execution-protection.ts';
import type {ProtectedExecutionInput} from '../src/execution-policy.ts';
import {ProtectedCheckout} from '../src/platform/protected-checkout.ts';

const roots: string[] = [];
afterEach(() => {for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});});
function input(): ProtectedExecutionInput {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'boite-cleanup-regression-'))); roots.push(root);
  const checkout = join(root, 'project'); mkdirSync(checkout); writeFileSync(join(checkout, 'ordinary.txt'), 'project data');
  return {scope: {kind: 'job', id: 'job', associationId: 'shared', grantRevision: 1}, checkout,
    executables: [], credentialPaths: [], expiresAt: Date.now() + 60000};
}

test('revocation waits for every stop and removes the private checkout even when a stop fails, then permits cleanup retry', async () => {
  const descriptor = input(), stopError = new Error('captured stop failed'), held = Promise.withResolvers<void>();
  let checkout!: ProtectedCheckout, closes = 0, fail = true;
  const stops: string[] = [];
  const protection = new ExecutionProtections({open: async policy => {
    checkout = new ProtectedCheckout(policy);
    return {launch() {throw new Error('not used');}, flush() {}, close() {closes++; checkout.close();}};
  }}, async () => {throw new Error('not used');}, async id => {
    stops.push(id);
    if (id === 'child') await held.promise;
    if (id === 'root' && fail) throw stopError;
  }, () => 0);
  try {
    await protection.install('root', descriptor, () => {}); protection.inherit('root', 'child');
    const result = protection.revoke('root').catch(error => error);
    expect(() => protection.launch('child', 'unused', [], {})).toThrow('revoked');
    await Promise.resolve(); expect(closes).toBe(0);
    held.resolve();
    const error = await result;
    expect(closes).toBe(1); expect(existsSync(checkout.scratch)).toBe(false);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toContain(stopError);
    expect(protection.policy('root')).not.toBeNull();
    fail = false; await protection.release('root');
    expect(protection.policy('root')).toBeNull(); expect(protection.policy('child')).toBeNull();
    expect(stops).toEqual(['root', 'child', 'root', 'child']);
  } finally {held.resolve(); fail = false; await protection.close().catch(() => {}); checkout?.close();}
});

test('revocation keeps both stop and session errors visible and retries the captured session', async () => {
  const stopError = new Error('stop failed'), closeError = new Error('cleanup failed');
  let fail = true, closes = 0;
  const protection = new ExecutionProtections({open: async () => ({launch() {throw new Error('unused');}, flush() {},
    close() {closes++; if (fail) throw closeError;}})}, async () => {throw new Error('unused');},
  async () => {if (fail) throw stopError;}, () => 0);
  try {
    await protection.install('root', input(), () => {});
    const error = await protection.release('root').catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([stopError, closeError]);
    expect(protection.policy('root')).not.toBeNull();
    fail = false; await protection.release('root');
    expect(closes).toBe(2); expect(protection.policy('root')).toBeNull();
  } finally {fail = false; await protection.close().catch(() => {});}
});

test('shared workflow options normalize absent values without accepting host-owned values or malformed types', () => {
  const compute = {sharedProjectId: 'shared', host: {ownerCoreId: 'a'.repeat(64), coreId: 'b'.repeat(64), projectId: 'project'}, profileId: 'conversation', baseCommit: 'c'.repeat(40)};
  const plan = (extra: Record<string, unknown>) => ({name: 'Shared', steps: [{id: 'remote', task: 'Review', compute, ...extra}]});
  const checked = checkPlan(plan({model: null, profile: null, effort: null, context: null, worktree: false}), {profiles: []});
  expect(checked.steps[0]).toEqual({id: 'remote', task: 'Review', compute, deps: []});
  for (const extra of [{model: 'echo'}, {profile: 'conversation'}, {effort: 'high'}, {context: 'light'}, {worktree: true}, {worktree: 'false'}, {model: false}]) {
    expect(() => checkPlan(plan(extra), {profiles: []})).toThrow();
  }
});

test('an attested human letter without contact enrichment appears only in the human section', () => {
  const letter: AgentLetter = {id: 'human-only', origin: 'contact-human',
    from: {coreId: 'peer', threadId: 'sender', title: 'External human', machine: 'Remote', status: 'idle', mode: 'brief', resources: ''},
    to: {coreId: 'local', threadId: 'recipient'}, toTitle: 'Recipient', text: 'Human project request', replyTo: null,
    createdAt: 1, expiresAt: 100, status: 'delivered', error: null};
  const prompt = letterPrompt([letter]);
  expect(prompt).toContain('HUMAN CONTACT');
  expect(prompt).not.toContain('OTHER AGENTS');
  expect(prompt.split('human-only')).toHaveLength(2);
});
