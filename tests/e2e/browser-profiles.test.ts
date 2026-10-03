import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, expect } from 'bun:test';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { killProcessTreeAsync, removeDirectory } from './lib/cleanup.ts';
import { connect } from '../../packages/core/src/client.ts';
import type { BrowserAction } from '../../packages/contracts/src/index.ts';

const executable = process.env.BOITE_E2E_SHELL_EXE;
const pro = { id: 'p-e2e0profile', name: 'Pro' };

/**
 * Each profile is a WebView2 profile in the shell's data folder: a cookie set in
 * one is absent from the others, survives a restart of the shell, and goes with
 * the profile when Settings deletes it. A private tab keeps nothing.
 */
test.skipIf(process.platform !== 'win32' || !executable)('browser profiles keep their own cookies across a restart until one is deleted', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-e2e-browser-profiles-'));
  const projectDir = join(dataDir, 'project'); mkdirSync(projectDir);
  const captures = join(import.meta.dir, '.artifacts'); mkdirSync(captures, { recursive: true });
  const site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const url = new URL(request.url);
    const who = url.searchParams.get('who');
    const headers: Record<string, string> = { 'content-type': 'text/html;charset=utf-8' };
    if (who) headers['set-cookie'] = `who=${who}; Max-Age=86400; Path=/; SameSite=Lax`;
    // A sign-in popup: it answers its opener with what it sees, then closes.
    if (url.pathname === '/answer') return new Response(`<!doctype html><script>opener.postMessage({ cookie: document.cookie, bridge: [typeof window.__TAURI_INTERNALS__, typeof window.ipc, typeof window.chrome?.webview] }, '*'); close()</script>`, { headers });
    return new Response(`<!doctype html><html lang="fr"><meta charset="utf-8"><title>Cookie ${who ?? ''}</title><style>body{font:20px system-ui;padding:40px}</style><h1>Profil</h1><p id="who"></p><script>document.querySelector('#who').textContent=document.cookie||'aucun cookie'</script></html>`, { headers });
  } });
  let shell: ReturnType<typeof Bun.spawn> | undefined;
  let page: BrowserPage | undefined, client: Awaited<ReturnType<typeof connect>> | undefined;
  const launch = async () => {
    const port = await freePort();
    shell = Bun.spawn([executable!], { windowsHide: true, stdout: 'ignore', stderr: Bun.file(join(dataDir, `shell-${port}.log`)), env: {
      ...process.env, BOITE_DATA_DIR: dataDir, BOITE_DRAFTS_DIR: join(dataDir, 'drafts'), BOITE_SHELL_HIDDEN: '1', BOITE_CORE_RESIDENT: '0', BOITE_ECHO: '1', BOITE_HOST_AGENTS: '0', BOITE_TELEMETRY_URL: '', BOITE_SHELL_DEBUG_PORT: String(port),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-allow-origins=* --mute-audio --use-angle=d3d11`,
    }});
    writeFileSync(join(dataDir, 'spawn.json'), JSON.stringify({ shell: shell.pid, port }));
    client = undefined;
    for (let i = 0; i < 300 && !client; i++) {
      try { const state = JSON.parse(readFileSync(join(dataDir, 'core.json'), 'utf8')); client = await connect(`http://127.0.0.1:${state.port}`, state.token); } catch { await Bun.sleep(100); }
    }
    if (!client) throw new Error('core did not start');
    page = await BrowserPage.attach(port);
    await page.waitFor("typeof window.__TAURI_INTERNALS__?.invoke === 'function'");
  };
  const openThread = async (threadId: string) => {
    await page!.waitFor("document.querySelector('[data-testid=thread-row]')");
    await page!.click('[data-testid=thread-row]');
    await page!.waitFor("document.querySelector('[data-testid=timeline]')");
    for (let i = 0; i < 120; i++) { try { await client!.call('browser.command', { threadId, action: { kind: 'status' } }); return; } catch (e) { if (i === 119) throw e; await Bun.sleep(100); } }
  };
  // Clean quit, as the tray does: the browser process writes its cookies out as it exits.
  const quit = async () => {
    const pid = shell!.pid;
    client?.close(); client = undefined;
    await page!.evaluate(`(() => { window.__TAURI_INTERNALS__.invoke('quit_shell'); return null; })()`).catch(() => undefined);
    await page!.close().catch(() => undefined); page = undefined;
    await Promise.race([shell!.exited, Bun.sleep(15000)]);
    if (shell!.exitCode === null) throw new Error(`shell ${pid} did not quit`);
    await Bun.sleep(3000);
  };
  const profileFolders = () => (readdirSync(dataDir, { recursive: true }) as string[]).filter(path => path.endsWith(pro.id));
  try {
    await launch();
    await client!.call('telemetry.configure', { mode: 'off' });
    await client!.call('settings.set', { browserProfiles: [pro] });
    const project = await client!.call('projects.add', { path: projectDir, name: 'Browser profiles' });
    const account = (await client!.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    const thread = await client!.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'Browser profiles' });
    await page!.evaluate(`localStorage.setItem('boite.experiments', JSON.stringify(['agent-browser-control'])); location.reload();`);
    await openThread(thread.id);
    const command = (tabId: string, action: BrowserAction) => client!.call('browser.command', { threadId: thread.id, tabId, action });
    const open = async (path: string, profile?: string) => {
      const reply = await client!.call('browser.command', { threadId: thread.id, action: { kind: 'open', url: new URL(path, site.url).href, ...(profile ? { profile } : {}) } });
      return { tabId: reply.tabId!, profile: reply.profile };
    };
    const cookie = async (tabId: string) => (await command(tabId, { kind: 'evaluate', expression: 'document.cookie' })).value;

    const listed = await client!.call('browser.command', { threadId: thread.id, action: { kind: 'profiles' } });
    expect((listed.value as { profiles: { id: string }[] }).profiles.map(one => one.id)).toEqual(['default', pro.id, 'private']);
    const mine = await open('/?who=perso');
    expect(mine.profile).toBe('default');
    expect(await cookie(mine.tabId)).toBe('who=perso');
    const work = await open('/', 'pro');
    expect(work.profile).toBe(pro.id);
    expect(await cookie(work.tabId)).toBe('');
    await command(work.tabId, { kind: 'navigate', url: new URL('/?who=pro', site.url).href });
    expect(await cookie(work.tabId)).toBe('who=pro');
    const hidden = await open('/', 'private');
    expect(await cookie(hidden.tabId)).toBe('');
    await command(hidden.tabId, { kind: 'navigate', url: new URL('/?who=private', site.url).href });
    expect(await cookie(hidden.tabId)).toBe('who=private');
    await command(mine.tabId, { kind: 'navigate', url: site.url.href });
    expect(await cookie(mine.tabId)).toBe('who=perso');
    await expect(open('/', 'Perso')).rejects.toThrow('no browser profile is named Perso');
    // The panel reopens its tabs after the restart: none of them may set a cookie again.
    for (const tab of [work, hidden]) await command(tab.tabId, { kind: 'navigate', url: site.url.href });
    console.log('Three profiles hold three cookies');

    // "Sign in with Google" opens a sized window and waits for it to answer
    // through `window.opener`: the popup shares the tab's profile, and neither
    // finds the app's bridge. A `target="_blank"` link opens a tab.
    const bare = ['undefined', 'undefined', 'undefined'];
    expect((await command(work.tabId, { kind: 'evaluate', expression: '[typeof window.__TAURI_INTERNALS__, typeof window.ipc, typeof window.chrome?.webview]' })).value).toEqual(bare);
    await command(work.tabId, { kind: 'evaluate', expression: `window.answer = null; addEventListener('message', event => { window.answer = event.data; }); window.signin = open('/answer', 'signin', 'width=480,height=600'); true` });
    let answer: unknown = null;
    for (let i = 0; i < 100 && !answer; i++) { await Bun.sleep(100); answer = (await command(work.tabId, { kind: 'evaluate', expression: 'window.answer' })).value; }
    expect(answer).toEqual({ cookie: 'who=pro', bridge: bare });
    for (let i = 0; i < 50 && !(await command(work.tabId, { kind: 'evaluate', expression: 'window.signin.closed' })).value; i++) await Bun.sleep(100);
    expect((await command(work.tabId, { kind: 'evaluate', expression: 'window.signin.closed' })).value).toBe(true);
    const tabs = async () => ((await client!.call('browser.command', { threadId: thread.id, action: { kind: 'status' } })).value as { tabs: { tabId: string; profile: string; url?: string }[] }).tabs;
    const before = (await tabs()).length;
    await command(work.tabId, { kind: 'evaluate', expression: `const link = Object.assign(document.createElement('a'), { id: 'blank', target: '_blank', href: '/blank', textContent: 'blank' }); document.body.append(link); true` });
    await command(work.tabId, { kind: 'click', selector: '#blank' });
    for (let i = 0; i < 50 && (await tabs()).length === before; i++) await Bun.sleep(100);
    const blank = (await tabs()).at(-1)!;
    expect((await tabs()).length).toBe(before + 1);
    expect(blank.profile).toBe(pro.id);
    await command(blank.tabId, { kind: 'close' });
    console.log('A sign-in popup answered its opener in the same profile');

    await page!.click(`[data-surface-id="${work.tabId}"][role=tab]`);
    await page!.waitFor(`document.querySelector('[data-testid=browser-profile]')?.dataset.profile === ${JSON.stringify(pro.id)}`);
    await page!.screenshot(join(captures, 'browser-profiles-tab-desktop.png'));
    await page!.click('[data-testid=browser-profile-menu]');
    await page!.waitFor("document.querySelector('[data-testid=browser-profile-menu-menu] [data-value=manage]')");
    await page!.screenshot(join(captures, 'browser-profiles-menu-desktop.png'));
    await page!.click('[data-testid=browser-profile-menu-menu] [data-value=manage]');
    await page!.waitFor("document.querySelector('[data-testid=browser-profiles-card] [data-testid=browser-profile-row]')");
    await page!.evaluate("document.querySelector('[data-testid=browser-profiles-card]').scrollIntoView({ block: 'center' }); true");
    await page!.screenshot(join(captures, 'browser-profiles-settings-desktop.png'));
    await page!.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await page!.waitFor('innerWidth === 390');
    await page!.evaluate("document.querySelector('[data-testid=browser-profiles-card]')?.scrollIntoView({ block: 'start' }); true");
    await Bun.sleep(200);
    expect(await page!.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    await page!.screenshot(join(captures, 'browser-profiles-settings-phone.png'));
    await page!.send('Emulation.clearDeviceMetricsOverride', {});
    expect(profileFolders().length).toBeGreaterThan(0);

    await quit();
    await launch();
    await openThread(thread.id);
    // The panel reopens the tabs it kept, each in its own profile.
    const reopened = (await client!.call('browser.command', { threadId: thread.id, action: { kind: 'status' } })).value as { tabs: { tabId: string; profile: string }[] };
    expect(reopened.tabs.map(tab => tab.profile)).toEqual(['default', pro.id, 'private']);
    const again = { mine: await open('/'), work: await open('/', 'Pro'), hidden: await open('/', 'private') };
    expect(await cookie(again.mine.tabId)).toBe('who=perso');
    expect(await cookie(again.work.tabId)).toBe('who=pro');
    // The private session ended with the shell that held it.
    expect(await cookie(again.hidden.tabId)).toBe('');
    console.log('Cookies survived the restart in their own profiles');

    await page!.click(`[data-surface-id="${again.work.tabId}"][role=tab]`);
    await page!.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await page!.waitFor(`innerWidth === 390 && document.querySelector('[data-testid=browser-profile]')?.dataset.profile === ${JSON.stringify(pro.id)}`);
    await Bun.sleep(200);
    expect(await page!.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    await page!.screenshot(join(captures, 'browser-profiles-tab-phone.png'));
    await page!.send('Emulation.clearDeviceMetricsOverride', {});
    await page!.waitFor('innerWidth > 390');
    await page!.click('[data-testid=browser-profile-menu]');
    await page!.waitFor("document.querySelector('[data-testid=browser-profile-menu-menu] [data-value=manage]')");
    await page!.click('[data-testid=browser-profile-menu-menu] [data-value=manage]');
    await page!.waitFor(`document.querySelector('[data-testid=browser-profile-row][data-profile=${pro.id}] [data-testid=browser-profile-delete]')`);
    await page!.click(`[data-testid=browser-profile-row][data-profile=${pro.id}] [data-testid=browser-profile-delete]`);
    await page!.waitFor("document.querySelector('[data-testid=confirm-ok]')");
    await page!.waitFor("document.getAnimations().every(animation => animation.playState !== 'running')");
    await page!.screenshot(join(captures, 'browser-profiles-delete-desktop.png'));
    await page!.click('[data-testid=confirm-ok]');
    for (let i = 0; i < 300; i++) {
      if (!(await client!.call('settings.get', {})).browserProfiles?.length) break;
      if (i === 299) throw new Error('the profile stayed in the settings');
      await Bun.sleep(100);
    }
    expect(await page!.evaluate("document.querySelector('[data-testid=browser-profile-error]')?.textContent ?? ''")).toBe('');
    const left = (await client!.call('browser.command', { threadId: thread.id, action: { kind: 'status' } })).value as { tabs: { profile: string }[] };
    expect(left.tabs.map(tab => tab.profile).sort()).toEqual(['default', 'default', 'private', 'private']);
    await expect(open('/', 'Pro')).rejects.toThrow('no browser profile is named Pro');
    console.log('Deleting the profile closed its tabs and forgot it');

    // WebView2 removes a deleted profile's folder when its browser process exits.
    await quit();
    expect(profileFolders()).toEqual([]);
    console.log('PASS', dataDir);
  } finally {
    client?.close(); await page?.close().catch(() => undefined); site.stop(true);
    if (shell && shell.exitCode === null) await killProcessTreeAsync(shell.pid);
    if (existsSync(dataDir)) await removeDirectory(dataDir);
  }
}, 180000);
