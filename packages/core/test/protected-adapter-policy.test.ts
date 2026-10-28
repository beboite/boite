import {afterEach, expect, test} from 'bun:test';
import {thrown} from './settle.ts';
import {existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sharedExecutionProtection, sharedPermissionSupport} from '../src/contacts/compute-policy.ts';
import {protectedAcp} from '../src/drivers/acp/protected.ts';
import {protectedPi} from '../src/drivers/pi/protected.ts';
import {protectedBridge} from '../src/drivers/protected-bridge.ts';
import {sessionKey as piKey} from '../src/drivers/pi/mapping.ts';
import {sessionKey as museKey} from '../src/drivers/muse/mapping.ts';
import {sessionKey as acpKey} from '../src/drivers/acp/session.ts';
import {SessionControls} from '../src/drivers/acp/controls.ts';
import type {ClientContext, SessionConfigOption} from '@agentclientprotocol/sdk';
import {protectedMuse} from '../src/drivers/muse/protected.ts';
import type {TurnContext} from '../src/drivers/types.ts';

let bridge: ReturnType<typeof protectedBridge> | undefined;
afterEach(() => {bridge?.close(); bridge = undefined;});
function context(): TurnContext {
  return {thread: {id: 'synthetic-thread', permissionMode: 'default', cwd: '/synthetic', contextMode: null},
    provider: {id: 'opencode', protocol: 'acp', profiles: {}}, account: {id: 'synthetic-account'}, accountEnv: {},
    log() {}, protectedExecution: {fingerprint: 'synthetic-capability', check() {}, async execute() {throw new Error('must not execute');}},
  } as unknown as TurnContext;
}
test('only the implemented ACP dialect and native pi automatic permissions can be offered', () => {
  for (const id of ['antigravity', 'opencode-v2', 'custom']) {
    expect(sharedExecutionProtection('acp', true, id).supported).toBe(false);
    expect(sharedPermissionSupport('acp', 'default', id)).toBe(false);
    const ctx = context(); ctx.provider.id = id;
    expect(() => protectedAcp(ctx, () => null, ['acp'])).toThrow('verified OpenCode');
  }
  expect(sharedExecutionProtection('acp', true, 'opencode').supported).toBe(true);
  expect(sharedExecutionProtection('pi', false).supported).toBe(false);
  for (const mode of ['default', 'acceptEdits', 'plan', 'dontAsk'] as const) {
    expect(sharedPermissionSupport('pi', mode)).toBe(false);
    const ctx = context(); ctx.thread.permissionMode = mode;
    expect(() => protectedPi(ctx, () => null, ['--mode', 'rpc'])).toThrow('no native approval mode');
  }
  for (const mode of ['yolo', 'bypassPermissions'] as const) expect(sharedPermissionSupport('pi', mode)).toBe(true);
  for (const mode of ['yolo', 'bypassPermissions', 'acceptEdits', 'dontAsk'] as const) {
    const ctx = context(); ctx.thread.permissionMode = mode;
    expect(() => protectedAcp(ctx, () => null, ['acp'])).toThrow('no plain-mode fallback');
  }
  const ctx = context(); ctx.thread.permissionMode = 'yolo';
  expect(() => protectedPi(ctx, () => null, ['--mode', 'rpc', '--extension', '/untrusted'])).toThrow('launch.args');
  ctx.accountEnv['NODE_OPTIONS'] = '--require /model-edited-project/preload.js';
  expect(() => protectedPi(ctx, () => null, ['--mode', 'rpc'])).toThrow('execution.control.env.NODE_OPTIONS');
  ctx.thread.permissionMode = 'default';
  expect(() => protectedAcp(ctx, () => null, ['acp'])).toThrow('execution.control.env.NODE_OPTIONS');
});
test('Muse requires the verified native registry gate and private configuration, never an MSP capability alone', () => {
  const ctx = context(); ctx.provider.id = 'muse';
  expect(sharedExecutionProtection('muse', true, 'muse').supported).toBe(true);
  expect(sharedExecutionProtection('muse', false, 'muse').supported).toBe(false);
  expect(() => protectedMuse(ctx, () => null, ['serve', '--config', 'run.toolset=null'])).toThrow('execution.muse.launch.args');
  const session = protectedMuse(ctx, () => null, ['serve'])!;
  try {
    expect(() => session.admit({serverInfo: {name: 'muse', version: '1.3.0'}, schema: {version: 1}})).toThrow('expected verified Muse 1.4.13');
    expect(() => session.admit({serverInfo: {name: 'muse', version: '1.4.13'}, schema: {version: 1, fingerprint: 'unverified'}})).toThrow('MSP fingerprint');
  } finally {session.close();}
});
test('every adapter retires an unprotected warm process and a replaced authority or account', () => {
  for (const key of [piKey, museKey, acpKey]) {
    const ctx = context(), original = key(ctx);
    expect(key({...ctx, protectedExecution: undefined})).not.toBe(original);
    expect(key({...ctx, protectedExecution: {...ctx.protectedExecution!, fingerprint: 'replacement'}})).not.toBe(original);
    expect(key({...ctx, account: {...ctx.account, id: 'other-account'}})).not.toBe(original);
  }
});
test('native bridge authenticates every call, binds the active turn and rechecks revocation', async () => {
  const ctx = context(); let active = true, revoked = false, ran = 0;
  ctx.thread.permissionMode = 'yolo';
  ctx.protectedExecution!.check = () => {if (revoked) throw new Error('grant revoked');};
  ctx.protectedExecution!.execute = async () => {ran++; return {code: 0, stdout: 'synthetic', stderr: ''};};
  bridge = protectedBridge(ctx, () => active ? {ctx, stopped: new Promise(() => {})} : null);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(bridge!.url + path, {method: 'POST', headers: {authorization: `Bearer ${bridge!.token}`, 'content-type': 'application/json', ...headers}, body: JSON.stringify(body)});
  const input = {name: 'boite_exec', input: {command: '/bin/true', args: []}};
  expect(() => bridge!.assertReady()).toThrow('did not initialize');
  expect(JSON.stringify(await (await post('/ready', {fingerprint: 'forged'})).json())).toContain('stale native extension');
  expect(() => bridge!.assertReady()).toThrow('did not initialize');
  expect((await post('/call', input, {authorization: 'Bearer wrong'})).status).toBe(403);
  expect((await post('/call', input, {origin: 'https://untrusted.invalid'})).status).toBe(403);
  expect(await (await post('/call', input)).json()).toMatchObject({success: true});
  active = false;
  expect(JSON.stringify(await (await post('/call', input)).json())).toContain('no matching active');
  active = true;
  expect(JSON.stringify(await (await post('/call', {...input, input: {...input.input, env: {ESCAPE: 'yes'}}})).json())).toContain('no environment');
  expect(JSON.stringify(await (await post('/call', {name: 'bash', input: {command: 'unsafe'}})).json())).toContain('unprotected tool refused');
  revoked = true;
  expect(JSON.stringify(await (await post('/mcp', {jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'boite_exec', arguments: input.input}})).json())).toContain('grant revoked');
  expect(ran).toBe(1);
  const dir = bridge.directory; bridge.close();
  expect(existsSync(dir)).toBe(false);
});

test('selected account data cannot execute native config commands or import arbitrary SDK code', () => {
  const root = mkdtempSync(join(tmpdir(), 'boite-native-config-'));
  try {
    const ctx = context(); ctx.thread.permissionMode = 'yolo';
    ctx.accountEnv = {PI_CODING_AGENT_DIR: root};
    writeFileSync(join(root, 'models.json'), JSON.stringify({providers: {custom: {apiKey: '!touch /synthetic-marker'}}}));
    expect(() => {const protectedSession = protectedPi(ctx, () => null, ['--mode', 'rpc']); protectedSession?.close();}).toThrow('execution.pi.config');
    writeFileSync(join(root, 'models.json'), JSON.stringify({providers: {custom: {headers: {Authorization: '!touch /synthetic-marker'}}}}));
    expect(() => {const protectedSession = protectedPi(ctx, () => null, ['--mode', 'rpc']); protectedSession?.close();}).toThrow('execution.pi.config');
    writeFileSync(join(root, 'models.json'), '{}');
    writeFileSync(join(root, 'auth.json'), JSON.stringify({custom: {type: 'api_key', key: '!touch /synthetic-marker'}}));
    expect(() => {const protectedSession = protectedPi(ctx, () => null, ['--mode', 'rpc']); protectedSession?.close();}).toThrow('execution.pi.config');
    mkdirSync(join(root, 'opencode'));
    ctx.thread.permissionMode = 'default'; ctx.accountEnv = {XDG_CONFIG_HOME: root, XDG_DATA_HOME: root};
    writeFileSync(join(root, 'opencode/opencode.json'), JSON.stringify({provider: {custom: {npm: 'file:///model-editable/escape.mjs'}}}));
    expect(() => {const protectedSession = protectedAcp(ctx, () => null, ['acp']); protectedSession?.close();}).toThrow('execution.acp.provider.custom.npm');
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('protected ACP rejects absent, refused and falsely acknowledged native modes', async () => {
  const ctx = context(); ctx.thread.permissionMode = 'plan';
  let refused = false;
  const controls = new SessionControls(() => ({sessionId: 'synthetic-session', agent: {async request() {
    if (refused) throw new Error('synthetic mode refusal');
    return {configOptions: [option('build')]};
  }} as unknown as ClientContext}));
  function option(currentValue: string): SessionConfigOption {
    return {type: 'select', id: 'mode', name: 'Mode', category: 'mode', currentValue, options: [{value: 'build', name: 'Build'}, {value: 'plan', name: 'Plan'}]};
  }
  expect(await thrown(controls.applyMode(ctx))).toThrow('offers no exact mode');
  controls.noteSession(null, [option('build')], {}); refused = true;
  expect(await thrown(controls.applyMode(ctx))).toThrow('native agent refused');
  refused = false;
  expect(await thrown(controls.applyMode(ctx))).toThrow('did not confirm plan');
});

test('protected ACP confirms the selected model before fresh and warm prompts', async () => {
  const ctx = context(); ctx.thread.model = 'fixture/selected'; ctx.thread.effort = null;
  const option = (currentValue: string): SessionConfigOption => ({type: 'select', id: 'model', name: 'Model', category: 'model', currentValue,
    options: ['fixture/selected', 'fixture/default'].map(value => ({value, name: value}))});
  let answer: unknown = {}, refusal = false, requests = 0;
  const controls = new SessionControls(() => ({sessionId: 'synthetic-session', agent: {async request() {
    requests++;
    if (refusal) throw new Error('synthetic model refusal');
    return answer;
  }} as unknown as ClientContext}));
  expect(await thrown(controls.applyConfig(ctx))).toThrow('execution.acp.model');
  controls.noteSession(null, [option('fixture/default')], {});
  controls.noteOwnModel([option('fixture/default')]);
  ctx.thread.model = 'fixture/missing';
  expect(await thrown(controls.applyConfig(ctx))).toThrow('execution.acp.model');
  ctx.thread.model = 'fixture/selected'; refusal = true;
  expect(await thrown(controls.applyConfig(ctx))).toThrow('native agent refused');
  refusal = false;
  expect(await thrown(controls.applyConfig(ctx))).toThrow('did not confirm');
  answer = {configOptions: [option('fixture/default')]};
  expect(await thrown(controls.applyConfig(ctx))).toThrow('did not confirm');
  answer = {configOptions: [option('fixture/selected')]};
  await controls.applyConfig(ctx);
  const admitted = requests;
  await controls.applyConfig(ctx); expect(requests).toBe(admitted);
  controls.noteOptionUpdate([option('fixture/default')]);
  await controls.applyConfig(ctx); expect(requests).toBe(admitted + 1);
  controls.noteOptionUpdate([option('fixture/default')]); refusal = true;
  expect(await thrown(controls.applyConfig(ctx))).toThrow('native agent refused');
  refusal = false; ctx.thread.model = 'default';
  answer = {configOptions: [option('fixture/default')]};
  await controls.applyConfig(ctx);
});

test('Grok refusing the selected model fails admission, while a refused effort alone stays a warning', async () => {
  const ctx = context(); ctx.protectedExecution = undefined;
  ctx.provider = {...ctx.provider, name: 'Grok', quirks: ['grok']} as TurnContext['provider'];
  const logs: string[] = []; ctx.log = (_level, message) => { logs.push(message); };
  const controls = new SessionControls(() => ({agent: {async request() {throw new Error('model unavailable');}} as unknown as ClientContext, sessionId: 'synthetic-session'}));
  ctx.thread.model = 'grok-next'; ctx.thread.effort = null;
  expect(await thrown(controls.applyModel(ctx))).toThrow('thread.model: Grok refused the model grok-next: model unavailable');
  ctx.thread.model = 'default'; ctx.thread.effort = 'high';
  controls.noteSession(null, null, {models: {currentModelId: 'grok-4.5', availableModels: [{modelId: 'grok-4.5', name: 'Grok 4.5'}]}});
  await controls.applyModel(ctx);
  expect(logs).toEqual(['acp: the agent refused the effort high on grok-4.5: model unavailable']);
});

test('native-default selection stays explicit and an ordinary ACP model the agent refuses fails admission', async () => {
  const ctx = context(); ctx.thread.model = 'default'; ctx.thread.effort = null;
  const controls = new SessionControls(() => ({agent: {async request() {throw new Error('native default must not select a model');}} as unknown as ClientContext, sessionId: 'synthetic-session'}));
  await controls.applyConfig(ctx);
  ctx.protectedExecution = undefined; ctx.thread.model = 'fixture/unavailable';
  controls.noteSession(null, [{type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: 'fixture/default',
    options: [{value: 'fixture/unavailable', name: 'Unavailable'}]}], {});
  // Outside protected execution too: the prompt must not run on fixture/default.
  expect(await thrown(controls.applyConfig(ctx))).toThrow(/^thread\.model: .* refused the model fixture\/unavailable: native default must not select a model$/);
});
