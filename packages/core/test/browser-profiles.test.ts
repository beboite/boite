import { expect, spyOn, test } from 'bun:test';
import { AGENT_ENV, browserActionError, browserProfilesOf, checkSettingsPatch, findBrowserProfile, type BrowserAction } from '@boite/contracts';
import { runCli } from '../src/cli.ts';
import { echoThread, startTestCore } from './harness.ts';

const pro = { id: 'p-0123456789ab', name: 'Pro' };

test('settings keep user browser profiles only, with a default that exists and is never private', () => {
  expect(checkSettingsPatch({ browserProfiles: [{ ...pro, name: '  Pro  ' }], browserDefaultProfile: pro.id }))
    .toEqual({ ok: true, patch: { browserProfiles: [pro], browserDefaultProfile: pro.id } });
  const bad: unknown[] = [
    [{ id: 'default', name: 'Mine' }],
    [{ id: 'Upper', name: 'Mine' }],
    [{ id: '../up', name: 'Mine' }],
    [{ id: 'p-1', name: 'Private' }],
    [{ id: 'p-1', name: '' }],
    [{ id: 'p-1', name: 'a\nb' }],
    [{ id: 'p-1', name: 'x'.repeat(41) }],
    [pro, { id: 'p-2', name: 'pro' }],
    [pro, { ...pro, name: 'Other' }],
    Array.from({ length: 33 }, (_, i) => ({ id: `p-${i}`, name: `P${i}` })),
    'Pro'
  ];
  for (const profiles of bad) expect(checkSettingsPatch({ browserProfiles: profiles as never })).toMatchObject({ ok: false, field: 'browserProfiles' });
  expect(checkSettingsPatch({ browserDefaultProfile: 'default' }).ok).toBe(true);
  for (const wanted of ['private', 'p-missing', 'Bad id']) {
    expect(checkSettingsPatch({ browserProfiles: [pro], browserDefaultProfile: wanted })).toMatchObject({ ok: false, field: 'browserDefaultProfile' });
  }
  // A default whose profile was removed in another patch reads as the built-in one.
  expect(browserProfilesOf({ browserProfiles: [], browserDefaultProfile: pro.id })).toEqual({ profiles: [], defaultId: 'default' });
  expect(browserProfilesOf({ browserProfiles: [pro], browserDefaultProfile: pro.id }).defaultId).toBe(pro.id);
  expect(browserProfilesOf(null)).toEqual({ profiles: [], defaultId: 'default' });
});

test('an agent names a profile by keyword, id or name, and an empty or oversized one is refused', () => {
  expect(findBrowserProfile([pro], 'PRO')).toBe(pro.id);
  expect(findBrowserProfile([pro], pro.id)).toBe(pro.id);
  expect(findBrowserProfile([pro], 'private')).toBe('private');
  expect(findBrowserProfile([pro], 'Default')).toBe('default');
  expect(findBrowserProfile([pro], 'Perso')).toBeNull();
  expect(browserActionError({ kind: 'profiles' })).toBeNull();
  expect(browserActionError({ kind: 'open', url: 'https://tripo.ai', profile: 'Pro' })).toBeNull();
  for (const profile of ['', 'x'.repeat(41), 3]) {
    expect(browserActionError({ kind: 'open', url: 'https://tripo.ai', profile } as never)).toContain('profile');
  }
});

test('boite browser lists profiles and asks to open a tab in a named one', async () => {
  const harness = await startTestCore();
  const owner = await harness.connect();
  try {
    const { threadId } = await echoThread(harness, owner);
    const seen: BrowserAction[] = [];
    // The CLI's parsing only: the core's own profile choice is tested in browser.test.ts.
    spyOn(harness.core.browser, 'command').mockImplementation(async request => {
      seen.push(request.action);
      return request.action.kind === 'profiles'
        ? { value: { default: 'default', profiles: [{ id: 'default', name: 'Default' }, pro] } }
        : { tabId: 'browser:test', url: 'https://tripo.ai', profile: pro.id };
    });
    const run = async (args: string[]) => {
      let out = '', error = '';
      const code = await runCli(['browser', ...args, '--json'], { cwd: harness.dataDir,
        env: { [AGENT_ENV.threadId]: threadId, [AGENT_ENV.coreUrl]: harness.url, [AGENT_ENV.token]: harness.core.agents.tokenFor(threadId) },
        out: text => out += text, err: text => error += text });
      return { code, out, error };
    };
    const listed = await run(['profiles']);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.out).value.profiles).toContainEqual(pro);
    const opened = await run(['open', 'https://tripo.ai', '--profile', 'Pro']);
    expect(opened.code).toBe(0);
    expect(JSON.parse(opened.out).profile).toBe(pro.id);
    expect((await run(['open', 'https://tripo.ai'])).code).toBe(0);
    // agent-browser's open: the current tab when there is one; a named profile has its own tab. Each open then looks up the site's recipes.
    expect(seen.filter(action => action.kind !== 'recipes')).toEqual([{ kind: 'profiles' }, { kind: 'open', url: 'https://tripo.ai', reuse: true, profile: 'Pro' }, { kind: 'open', url: 'https://tripo.ai', reuse: true }]);
    for (const args of [['open', 'https://tripo.ai', '--profile'], ['open', 'https://tripo.ai', '--profile', 'a', '--profile', 'b']]) {
      expect((await run(args)).code).not.toBe(0);
    }
    expect(seen.filter(action => action.kind !== 'recipes')).toHaveLength(3);
    expect((await run(['help'])).out).toContain('--profile');
    await owner.call('settings.set', { browserProfiles: [pro], browserDefaultProfile: pro.id });
    expect(await owner.call('settings.set', { browserDefaultProfile: 'private' }).catch((error: Error) => error.message)).toContain('never private');
  } finally { owner.close(); await harness.stop(); }
});

test('an agent adds a kept profile for a second account, once per name', async () => {
  const harness = await startTestCore();
  const owner = await harness.connect();
  try {
    const { threadId } = await echoThread(harness, owner);
    const run = async (args: string[]) => {
      let out = '', error = '';
      const code = await runCli(['browser', ...args], { cwd: harness.dataDir,
        env: { [AGENT_ENV.threadId]: threadId, [AGENT_ENV.coreUrl]: harness.url, [AGENT_ENV.token]: harness.core.agents.tokenFor(threadId) },
        out: text => out += text, err: text => error += text });
      return { code, out, error };
    };
    // `private` keeps nothing once its tabs or the core close: a second account needs a profile of its own.
    const added = await run(['profiles', 'add', 'Compte', 'B']);
    expect(added).toMatchObject({ code: 0, error: '' });
    const [made] = browserProfilesOf(harness.core.settings.get()).profiles.map(profile => ({ ...profile }));
    expect(made?.name).toBe('Compte B');
    expect(made?.id).toMatch(/^p-[0-9a-f]{12}$/);
    expect(added.out).toContain(made!.id);
    expect(findBrowserProfile(browserProfilesOf(harness.core.settings.get()).profiles, 'compte b')).toBe(made!.id);
    // A repeated command answers the same profile instead of a second one.
    expect((await run(['profiles', 'add', 'compte b'])).out).toContain(`Already listed: browser profile Compte B (${made!.id})`);
    expect(browserProfilesOf(harness.core.settings.get()).profiles).toEqual([made!]);
    for (const args of [['profiles', 'add'], ['profiles', 'add', 'Private'], ['profiles', 'add', 'x'.repeat(41)], ['profiles', 'remove', 'Compte B']]) {
      expect((await run(args)).code).not.toBe(0);
    }
    expect(browserProfilesOf(harness.core.settings.get()).profiles).toEqual([made!]);
    // A name that is another profile's id would open that profile through --profile.
    expect((await run(['profiles', 'add', made!.id])).error).toContain('already uses');
    // At the cap a listed name still answers its profile, and a new one is refused by name.
    const full = [made!, ...Array.from({ length: 31 }, (_, i) => ({ id: `p-fill${i}`, name: `Fill ${i}` }))];
    await owner.call('settings.set', { browserProfiles: full });
    expect((await run(['profiles', 'add', 'Compte B'])).out).toContain('Already listed');
    expect((await run(['profiles', 'add', 'Compte C'])).error).toContain('already has 32 browser profiles');
    expect(browserProfilesOf(harness.core.settings.get()).profiles).toHaveLength(32);
    expect((await run(['help'])).out).toContain('profiles add <name>');
  } finally { owner.close(); await harness.stop(); }
});
