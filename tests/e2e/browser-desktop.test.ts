import { expect, test } from 'bun:test';
import { BrowserPage } from './lib/cdp.ts';
import { startBrowserSession } from './lib/browser-session.ts';
import { runCli } from '../../packages/core/src/cli.ts';
import type { BrowserReply } from '../../packages/contracts/src/index.ts';

const executable = process.env.BOITE_E2E_SHELL_EXE;
const shellTest = executable && process.platform === 'win32' ? test : test.skip;

/**
 * The desktop's own browser on a real shell: `boite browse` opens the page in
 * the conversation's panel, `boite browser` reads and drives that WebView2
 * page, and what the user does there is what the agent reads next.
 */
shellTest('the agent drives the page it opened in the desktop panel, and goes on after the user takes over', async () => {
  const html = (body: string) => new Response(`<!doctype html><meta charset="utf-8">${body}`, { headers: { 'content-type': 'text/html;charset=utf-8' } });
  const site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname === '/next') return html('<title>Signed in</title><h1>Welcome back</h1>');
    return html(`<title>Desk page</title><input id="name"><button id="hello" onclick="document.querySelector('#result').textContent='Bonjour '+document.querySelector('#name').value">Hello</button><p id="result">ready</p>`);
  } });
  const session = await startBrowserSession(executable!, 'Desktop browser');
  let view: BrowserPage | undefined;
  try {
    // The shell lends its panel's browser once it is connected to the core it started.
    let lent = false;
    for (const deadline = Date.now() + 15_000; !lent && Date.now() < deadline; await Bun.sleep(100)) {
      lent = ((await session.command({ kind: 'status' })).value as { desktop?: boolean }).desktop === true;
    }
    expect(lent).toBe(true);
    const out: string[] = [];
    expect(await runCli(['browse', site.url.href, '--thread', session.threadId, '--data-dir', session.dataDir, '--json'], {
      cwd: session.projectDir, env: { BOITE_DATA_DIR: session.dataDir }, out: text => out.push(text), err: text => { throw new Error(text); },
    })).toBe(0);
    const opened = JSON.parse(out.join('')) as BrowserReply;
    expect(opened).toMatchObject({ desktop: true, title: 'Desk page' });
    // The panel shows it: one browser tab, on that address.
    await session.page.waitFor(`document.querySelector('[data-testid=browser-slot]') && document.querySelectorAll('[data-testid=panel-tab][data-surface-id^="browser:"]').length === 1`);
    expect(await session.page.evaluate<string>(`document.querySelector('[data-testid=panel-tab][data-surface-id^="browser:"]').dataset.surfaceId`)).toBe(opened.tabId!);

    const status = (await session.command({ kind: 'status' })).value as { desktop: boolean; tabs: Array<{ tabId: string; desktop?: boolean }> };
    expect(status.desktop).toBe(true);
    expect(status.tabs).toEqual([expect.objectContaining({ tabId: opened.tabId, desktop: true })]);
    expect((await session.command({ kind: 'get', what: 'title' })).value).toBe('Desk page');
    await session.command({ kind: 'type', selector: '#name', text: 'Chris' });
    await session.command({ kind: 'click', selector: '#hello' });
    expect((await session.command({ kind: 'evaluate', expression: "document.querySelector('#result').textContent" })).value).toBe('Bonjour Chris');
    // A view off screen paints nothing: the capture is then refused by name rather than hanging.
    const shot = await session.command({ kind: 'screenshot' }).then(reply => reply.screenshot?.mime ?? 'none', (error: Error) => error.message);
    expect(shot === 'image/png' || shot.includes('not on screen')).toBe(true);

    // The user takes over on the same page; the agent reads where they went.
    view = await BrowserPage.attach(session.port, site.url.href);
    await view.evaluate(`location.href = ${JSON.stringify(new URL('/next', site.url).href)}`);
    let title: unknown = null;
    for (const deadline = Date.now() + 15_000; title !== 'Signed in' && Date.now() < deadline; await Bun.sleep(150)) {
      title = await session.command({ kind: 'get', what: 'title' }).then(reply => reply.value, () => null);
    }
    expect(title).toBe('Signed in');
    // `browser open` goes on in that tab rather than another browser.
    expect(await session.command({ kind: 'open', url: site.url.href, reuse: true })).toMatchObject({ tabId: opened.tabId, desktop: true, title: 'Desk page' });
    expect((await session.command({ kind: 'close' })).value).toEqual({ closed: true });
    await session.page.waitFor(`!document.querySelector('[data-testid=panel-tab][data-surface-id^="browser:"]')`);
  } finally {
    await view?.close();
    await session.close();
    site.stop(true);
  }
}, 120_000);
