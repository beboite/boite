import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createMuseDriver} from '../src/drivers/muse.ts';
import {protectedTools} from '../src/protected-tools.ts';
import type {Driver, SessionContext} from '../src/drivers/types.ts';
import {protectedProviderApi} from './fixtures/protected-provider-api.ts';
import {startTestCore, waitFor, type TestCore} from './harness.ts';
import {thrown} from './settle.ts';

let h: TestCore | undefined, driver: Driver | undefined, api: ReturnType<typeof protectedProviderApi> | undefined;
afterEach(async () => {driver?.shutdown?.(); api?.stop(); await h?.stop(); h = undefined; driver = undefined; api = undefined;});
const native = process.platform === 'linux' && process.env.BOITE_TEST_NATIVE_EXECUTION === '1' && !!process.env.BOITE_TEST_MUSE_LEGACY_CLI;

// The former unsafe 1.3.0 read probe is now a production refusal regression.
// Useful latest-native evidence lives in protected-muse.test.ts.
describe.skipIf(!native)('unsupported Muse native runtime', () => {
  test('legacy 1.3.0 cannot send a protected prompt or reopen ordinary history', async () => {
    h = await startTestCore();
    const root = join(h.dataDir, 'project'), account = join(h.dataDir, 'account');
    mkdirSync(root); mkdirSync(join(account, 'muse'), {recursive: true});
    api = protectedProviderApi('muse', []);
    writeFileSync(join(account, 'muse/auth.json'), JSON.stringify({schema_version: 1, providers: {meta: {api_key: 'synthetic-fixture-key'}}}));
    writeFileSync(join(account, 'muse/settings.json'), JSON.stringify({schema_version: 1, endpoint_transport: {base_url: api.url, auth: 'bearer'}}));
    const id = 'legacy-muse';
    await h.core.procs.protection.install(id, {scope: {kind: 'letter', id: 'fixture', associationId: 'fixture', grantRevision: 1}, route: {providerId: 'muse', accountId: 'synthetic', permissionMode: 'yolo'}, checkout: root, credentialPaths: [account], executables: [process.execPath], expiresAt: Date.now() + 30000}, () => {});
    const provider = h.core.providers.require('muse'), control = h.core.procs.protection.control(id);
    for (const profile of Object.values(provider.profiles)) if (profile) profile.executable = [{kind: 'file', value: process.env.BOITE_TEST_MUSE_LEGACY_CLI!}];
    const client = await h.connect(), project = await client.call('projects.add', {path: root});
    const echo = h.core.accounts.list().find(a => a.providerId === 'echo')!;
    const base = await client.call('threads.create', {projectId: project.id, providerId: 'echo', accountId: echo.id});
    const ctx = {provider, account: {...echo, id: 'synthetic'}, accountEnv: {XDG_CONFIG_HOME: account}, thread: {...base, id, cwd: root, model: 'default', permissionMode: 'yolo'},
      protectedExecution: protectedTools(h.core.procs, id, () => {}, () => {}), sessionId: 'ordinary-host-history', warmProcessMinutes: 1, log() {}, commands() {}, context() {},
      spawnChild: (cmd, args, opts) => h!.core.procs.spawnChild(control, cmd, args, opts), killTree: () => h!.core.procs.killTree(control),
    } as SessionContext;
    driver = createMuseDriver();
    expect(await thrown(driver.prepare!(ctx))).toThrow();
    expect(api.requests).toHaveLength(0);
    driver.shutdown?.(); await waitFor(() => h!.core.procs.liveCount(control) === 0);
    expect(h.core.procs.liveCount(control)).toBe(0);
  }, 30000);
});
