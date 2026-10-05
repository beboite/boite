import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserPage, freePort } from './cdp.ts';
import { killProcessTreeAsync, removeDirectory } from './cleanup.ts';
import { connect } from '../../../packages/core/src/client.ts';
import type { BrowserAction } from '../../../packages/contracts/src/index.ts';

/** Isolated Echo desktop. Visible mode is only for an explicitly requested manual review. */
export async function startBrowserSession(executable: string, title = 'Boite · validation des nouveautés', experiments: string[] = [], options: { visible?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-parity-'));
  const projectDir = join(dataDir, 'project'); mkdirSync(projectDir);
  const port = await freePort();
  // Do not reveal a hidden session with Win32 ShowWindow: Tao would still
  // remember it as hidden and hide it again when a video enters fullscreen.
  const hidden = options.visible !== true;
  const shell = Bun.spawn([executable], { windowsHide: hidden, stdout: 'ignore', stderr: Bun.file(join(dataDir, 'shell.log')), env: {
    ...process.env, BOITE_DATA_DIR: dataDir, BOITE_DRAFTS_DIR: join(dataDir, 'drafts'), BOITE_SHELL_HIDDEN: hidden ? '1' : '0', BOITE_CORE_RESIDENT: '0', BOITE_ECHO: '1', BOITE_HOST_AGENTS: '0', BOITE_TELEMETRY_URL: '', BOITE_SHELL_DEBUG_PORT: String(port),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-allow-origins=* --mute-audio --use-angle=d3d11`,
  }});
  let page: BrowserPage | undefined, client: Awaited<ReturnType<typeof connect>> | undefined;
  let url = '';
  const close = async () => {
    client?.close(); await page?.close();
    if (shell.exitCode === null) await killProcessTreeAsync(shell.pid);
    await shell.exited; await removeDirectory(dataDir);
  };
  try {
    for (let i = 0; i < 200; i++) {
      try { const state = JSON.parse(readFileSync(join(dataDir, 'core.json'), 'utf8')); url = `http://127.0.0.1:${state.port}`; client = await connect(url, state.token); break; }
      catch { await Bun.sleep(100); }
    }
    if (!client) throw new Error('test core did not start');
    await client.call('telemetry.configure', { mode: 'off' });
    const project = await client.call('projects.add', { path: projectDir, name: 'Boite · nouveautés à valider' });
    const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title });
    page = await BrowserPage.attach(port);
    await page.waitFor("typeof window.__TAURI_INTERNALS__?.invoke === 'function'");
    await page.evaluate(`localStorage.setItem('boite.onboarding', JSON.stringify({version:6,at:Date.now()})); localStorage.setItem('boite.locale', 'fr'); localStorage.setItem('boite.experiments', ${JSON.stringify(JSON.stringify(experiments))}); location.reload();`);
    await page.waitFor("document.querySelector('[data-testid=thread-row]')");
    await page.click('[data-testid=thread-row]');
    await page.waitFor("document.querySelector('[data-testid=timeline]')");
    for (let i = 0; i < 150; i++) {
      try { await client.call('browser.command', { threadId: thread.id, action: { kind: 'status' } }); break; }
      catch (error) { if (i === 149) throw error; await Bun.sleep(100); }
    }
    const owner = client, main = page;
    const command = (action: BrowserAction, tabId?: string) => owner.call('browser.command', { threadId: thread.id, action, ...(tabId ? { tabId } : {}) });
    return { page: main, client: owner, url, threadId: thread.id, projectDir, dataDir, port, shellPid: shell.pid, command, close };
  } catch (error) { await close(); throw error; }
}
