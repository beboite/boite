import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {SharedNativeExecution} from '../src/contacts/native-execution.ts';
import type {AccessBinding} from '../src/contacts/access-scopes.ts';
import {startTestCore, type TestCore} from './harness.ts';

let h: TestCore | undefined;
afterEach(async () => {await h?.stop(); h = undefined;});
describe.skipIf(process.platform !== 'linux' || process.env.BOITE_TEST_NATIVE_EXECUTION !== '1')('configured native account files', () => {
  test.each(['pi', 'opencode-file', 'opencode-data', 'muse-config', 'muse-data', 'muse-state'] as const)('%s cannot expose custom credential/model configuration inside the checkout', async route => {
    h = await startTestCore();
    const root = join(h.dataDir, 'project'); mkdirSync(root);
    const client = await h.connect(), project = await client.call('projects.add', {path: root});
    const echo = h.core.accounts.list().find(a => a.providerId === 'echo')!;
    const base = await client.call('threads.create', {projectId: project.id, providerId: 'echo', accountId: echo.id});
    const providerId = route === 'pi' ? 'pi' : route.startsWith('muse-') ? 'muse' : 'opencode', provider = h.core.providers.require(providerId);
    const account = {...echo, id:'synthetic-native-account', providerId, isolationDir:null};
    h.core.journal.putAccount(account);
    h.core.journal.putThread({...base, providerId, accountId: account.id, permissionMode: route === 'pi' ? 'yolo' : 'default'});
    const relative = route === 'pi' ? 'native/models.json' : route === 'opencode-file' ? 'provider-route.json' : providerId === 'muse' ? 'native/muse/auth.json' : 'native/opencode/auth.json';
    mkdirSync(dirname(join(root, relative)), {recursive:true});
    writeFileSync(join(root, relative), 'Synthetic native account selection');
    const env: Record<string, string> = route === 'pi' ? {PI_CODING_AGENT_DIR: join(root, 'native')} : route === 'opencode-file' ? {OPENCODE_CONFIG: join(root, relative)}
      : {[route === 'muse-config' ? 'XDG_CONFIG_HOME' : route === 'muse-state' ? 'XDG_STATE_HOME' : 'XDG_DATA_HOME']: join(root, 'native')};
    for (const profile of Object.values(provider.profiles)) if (profile) profile.env = {...profile.env, ...env};
    const binding = {threadId:base.id, checkoutPath:root, job:{id:null, sharedProjectId:'synthetic-association', grantRevision:1}} as AccessBinding;
    // Capture uses the production service and actual account/profile environment.
    // This synthetic binding is not a full board/job/contact-transport scenario.
    const protection = new SharedNativeExecution(h.core, () => binding, () => {});
    await protection.prepare(base.id);
    const result = await protection.context(base.id)!.execute('/bin/cat', [relative]);
    expect(result.stdout).not.toContain('Synthetic native account selection');
    expect(result.code).not.toBe(0);
    expect(readFileSync(join(root, relative), 'utf8')).toBe('Synthetic native account selection');
    await h.core.procs.protection.revoke(base.id);
  }, 15000);
});
