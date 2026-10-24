import {afterEach, expect, test} from 'bun:test';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createAcpDriver} from '../src/drivers/acp.ts';
import {createPiDriver} from '../src/drivers/pi.ts';
import type {Driver, SessionContext} from '../src/drivers/types.ts';
import {startTestCore, waitFor, type TestCore} from './harness.ts';
import {thrown} from './settle.ts';

let h: TestCore | undefined, driver: Driver | undefined;
afterEach(async () => {driver?.shutdown?.(); driver = undefined; await h?.stop(); h = undefined;});

// Negative admission only. This scripted control never executes a model tool and
// cannot count as the installed-provider or native OS proof in protected-adapters.
test.each(['wrong-agent', 'unverified-acp-patch', 'missing-acp-extension', 'missing-pi-extension'] as const)('%s cannot turn native capability advertisements into protected readiness', async posture => {
  h = await startTestCore();
  const root = join(h.dataDir, 'project'), accountRoot = join(h.dataDir, 'synthetic-account'), log = join(h.dataDir, 'claims.log');
  mkdirSync(root); mkdirSync(accountRoot);
  const fixture = join(h.dataDir, 'claims.js');
  writeFileSync(fixture, `
import {appendFileSync} from 'node:fs';
for await (const line of console) {
  const request = JSON.parse(line), method = request.method ?? request.type;
  appendFileSync(process.env.FIXTURE_LOG, method + '\\n');
  if (request.type) {
    console.log(JSON.stringify({type:'response', id: request.id, command:request.type, success:true, data: request.type === 'get_commands' ? {commands:[]} : {isStreaming:false}}));
    continue;
  }
  if (request.id === undefined) continue;
  const result = method === 'initialize'
    ? {protocolVersion:1, agentInfo:{name:'OpenCode',version:process.env.FIXTURE_VERSION}, agentCapabilities:{loadSession:true, promptCapabilities:{image:true}}}
    : {sessionId:'synthetic-session', modes:{currentModeId:'build',availableModes:[{id:'build',name:'Build'},{id:'plan',name:'Plan'}]}};
  console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
}
`);
  const protocol = posture === 'missing-pi-extension' ? 'pi' : 'opencode';
  const provider = h.core.providers.require(protocol);
  for (const profile of Object.values(provider.profiles)) if (profile) profile.executable = [{kind: 'file', value: process.execPath}];
  const accountEnv = {PI_CODING_AGENT_DIR: accountRoot, XDG_CONFIG_HOME: accountRoot, XDG_DATA_HOME: accountRoot,
    FIXTURE_LOG: log, FIXTURE_VERSION: posture === 'wrong-agent' ? '9.0.0' : posture === 'unverified-acp-patch' ? '1.19.4' : '1.19.3'};
  const captured = 'synthetic-control';
  const ctx = {provider, account: {id: 'synthetic-account', isolationDir: accountRoot}, accountEnv,
    thread: {id: 'synthetic-thread', cwd: root, model: 'default', effort: null, contextMode: null, permissionMode: protocol === 'pi' ? 'yolo' : 'default'},
    protectedExecution: {fingerprint:'synthetic-capability', check() {}, async execute() {throw new Error('No tool may execute');}},
    sessionId:null, warmProcessMinutes:1, log() {}, commands() {}, context() {},
    spawnChild: (_command: string, args: string[], options: Parameters<TestCore['core']['procs']['spawnChild']>[3]) => h!.core.procs.spawnChild(captured, process.execPath, [fixture, ...args], options),
    killTree: () => h!.core.procs.killTree(captured),
  } as unknown as SessionContext;
  driver = protocol === 'pi' ? createPiDriver() : createAcpDriver({loadSdk: () => import('@agentclientprotocol/sdk')});
  expect(await thrown(driver.prepare!(ctx))).toThrow(posture === 'wrong-agent' || posture === 'unverified-acp-patch' ? 'execution.acp.agentInfo' : 'did not initialize');
  const wire = readFileSync(log, 'utf8');
  expect(wire).not.toContain('session/prompt'); expect(wire).not.toContain('\nprompt');
  driver.shutdown?.();
  await waitFor(() => h!.core.procs.liveCount(captured) === 0);
  expect(h.core.procs.liveCount(captured)).toBe(0);
}, 10000);
