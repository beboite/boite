import {afterEach, describe, expect, test} from 'bun:test';
import {rejection, thrown} from './settle.ts';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {MuseRpc, mintUuidV7} from '../src/drivers/muse/rpc.ts';
import {protectedBridge} from '../src/drivers/protected-bridge.ts';
import {protectedTools} from '../src/protected-tools.ts';
import type {TurnContext} from '../src/drivers/types.ts';
import {protectedProviderApi} from './fixtures/protected-provider-api.ts';
import {startTestCore, waitFor, type TestCore} from './harness.ts';

let h: TestCore | undefined, bridge: ReturnType<typeof protectedBridge> | undefined, api: ReturnType<typeof protectedProviderApi> | undefined;
afterEach(async () => {bridge?.close(); api?.stop(); await h?.stop(); h = undefined; bridge = undefined; api = undefined;});
const native = process.platform === 'linux' && process.env.BOITE_TEST_NATIVE_EXECUTION === '1';

/** Limitation probes, not an admission of Muse to protected production execution. */
describe.skipIf(!native)('Muse 1.3.0 native admission evidence', () => {
  test.each(['mcp-and-native', 'empty', 'mcp-only'] as const)('%s toolset cannot provide a verified MCP-only execution route', async posture => {
    if (!process.env.BOITE_TEST_MUSE_CLI) throw new Error('Requires task-owned BOITE_TEST_MUSE_CLI');
    h = await startTestCore();
    const root = join(h.dataDir, 'project'), config = join(h.dataDir, 'config'), credential = join(h.dataDir, 'synthetic-account-key');
    mkdirSync(root); mkdirSync(join(config, 'muse'), {recursive: true});
    writeFileSync(join(root, 'answer.js'), '41'); writeFileSync(credential, 'SYNTHETIC_MUSE_CREDENTIAL');
    const id = 'muse-native-limitation';
    await h.core.procs.protection.install(id, {scope: {kind: 'letter', id: 'fixture', associationId: 'fixture', grantRevision: 1},
      route: {providerId: 'muse', accountId: 'synthetic', permissionMode: 'yolo'}, checkout: root, credentialPaths: [credential], executables: [process.execPath], expiresAt: Date.now() + 60000}, () => {});
    const ctx = {thread: {permissionMode: 'yolo'}, protectedExecution: protectedTools(h.core.procs, id, () => {}, () => {})} as unknown as TurnContext;
    bridge = protectedBridge(ctx, () => ({ctx, stopped: new Promise(() => {})}));
    api = protectedProviderApi('muse', [
      {name: 'mcp__boite_protected.boite_exec', input: {command: process.execPath, args: ['-e', "require('fs').writeFileSync('answer.js', '42')"]}},
      {name: 'muse.read_file', input: {path: credential}},
    ]);
    writeFileSync(join(config, 'muse/auth.json'), JSON.stringify({schema_version: 1, providers: {meta: {api_key: 'synthetic-fixture-key'}}}));
    writeFileSync(join(config, 'muse/settings.json'), JSON.stringify({schema_version: 1, model: 'protected-model',
      endpoint_transport: {base_url: api.url, auth: 'bearer'},
      run: {subagent_delegation_mode: 'off', reminder_roster: {agents: []}, ...(posture === 'mcp-and-native' ? {} : {toolset: posture === 'empty' ? [] : ['mcp__boite_protected.boite_exec']})}}));
    const child = h.core.procs.spawnChild(h.core.procs.protection.control(id), process.env.BOITE_TEST_MUSE_CLI, ['serve', '--disable-write', '--disable-shell'],
      {cwd: root, env: {PATH: '/usr/bin:/bin', HOME: config, XDG_CONFIG_HOME: config, XDG_DATA_HOME: config, XDG_STATE_HOME: config, MUSE_NO_AUTO_UPDATE: '1'}});
    let stderr = '', complete = false; child.stderr.on('data', chunk => {stderr += chunk;});
    const rpc = new MuseRpc(child, {log() {}, notification(method) {if (method === 'turn/completed') complete = true;}});
    try {
      const opening = rpc.request<{serverInfo: {version: string}; grantedCapabilities: string[]}>('initialize', {clientInfo: {name: 'fixture', version: '1'}, capabilities: {requestedCapabilities: ['sessionMcp']}});
      if (posture === 'mcp-only') {
        expect(await thrown(opening)).toThrow();
        expect(stderr).toContain('unknown tool names: mcp__boite_protected.boite_exec');
        expect(api.requests).toHaveLength(0);
        return;
      }
      const init = await opening; expect(init.serverInfo.version).toBe('1.3.0'); expect(init.grantedCapabilities).toContain('sessionMcp');
      rpc.notify('initialized', {});
      const sessionId = mintUuidV7();
      await rpc.command('session/start', {sessionId, workspaceRoot: root, providerId: 'meta', modelId: 'protected-model', approvalMode: 'allowAll',
        config: {mcpServers: {boite_protected: {transport: 'streamableHttp', url: bridge.url + '/mcp', mode: 'required', headers: {Authorization: `Bearer ${bridge.token}`}}}}});
      expect((await rejection(rpc.request('hook/list', {sessionId}))).reason).toMatchObject({code: -32601});
      await rpc.command('turn/start', {sessionId, input: [{type: 'text', text: 'Synthetic fixture only.'}]});
      await waitFor(() => complete, 20000);
      const wire = JSON.stringify(api.requests);
      if (posture === 'empty') {
        expect(readFileSync(join(root, 'answer.js'), 'utf8')).toBe('41');
        expect(wire).toContain('tool unavailable'); expect(wire).not.toContain('SYNTHETIC_MUSE_CREDENTIAL');
        expect((api.requests[0] as {tools?: unknown[]}).tools ?? []).toHaveLength(0);
      } else {
        bridge.assertMcpReady();
        expect(readFileSync(join(root, 'answer.js'), 'utf8')).toBe('42');
        // The exact reason this otherwise useful MCP route is not advertised.
        expect(wire).toContain('SYNTHETIC_MUSE_CREDENTIAL');
      }
    } finally {rpc.fail('fixture closed'); await h.core.procs.stopAndWait(h.core.procs.protection.control(id));}
  }, 30000);
});
