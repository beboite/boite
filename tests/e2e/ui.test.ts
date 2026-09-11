import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import corePackage from '../../packages/core/package.json';
import { connect } from '../../packages/core/src/client.ts';
import { claudeProjectFolder } from '../../packages/core/src/imports/claude.ts';
import { claudeSessionFixture, FIXTURE_SESSION_ID } from '../../packages/core/test/fixtures/claude-session.ts';
import { BrowserPage } from './lib/cdp.ts';
import { pairingUrlOf, removeDirectory, startCore, type RunningCore } from './lib/core.ts';

const TIMEOUT = 60_000;
/** The reconnect has its own budget: a backoff that needs a minute is a bug. */
const RECONNECT_TIMEOUT_MS = 30_000;
const ROOT = join(import.meta.dir, '..', '..');
const UI_INDEX = join(ROOT, 'packages', 'ui', 'dist', 'index.html');
const SCREENSHOT = join(import.meta.dir, '.artifacts', 'ui.png');
const RELOAD_SCREENSHOT = join(import.meta.dir, '.artifacts', 'ui-permission-reload.png');
const TOOL_SCREENSHOT = join(import.meta.dir, '.artifacts', 'ui-tool-input.png');
const DIFF_SCREENSHOT = join(import.meta.dir, '.artifacts', 'ui-tool-diff.png');
const QUESTION_SCREENSHOT = join(import.meta.dir, '.artifacts', 'ui-question.png');
const OFFLINE_SCREENSHOT = join(import.meta.dir, '.artifacts', 'ui-offline-shell.png');
const ATTACHMENT_SCREENSHOT = join(import.meta.dir, '.artifacts', 'ui-attachment.png');
const ATTACHMENT_SENT_SCREENSHOT = join(import.meta.dir, '.artifacts', 'ui-attachment-sent.png');
const SLASH_SCREENSHOT = join(import.meta.dir, '.artifacts', 'ui-slash-menu.png');
const MENTION_SCREENSHOT = join(import.meta.dir, '.artifacts', 'ui-mention-menu.png');
const WORKTREE_SCREENSHOT = join(import.meta.dir, '.artifacts', 'ui-worktree.png');
const KEYBOARD_SCREENSHOT = join(import.meta.dir, '.artifacts', 'ui-keyboard.png');
const RETITLE_SCREENSHOT = join(import.meta.dir, '.artifacts', 'ui-retitle.png');
const IMPORT_SCREENSHOT = join(import.meta.dir, '.artifacts', 'ui-import.png');
/** The one name `public/sw.js` opens; every other cache is deleted on activate. */
const UI_CACHE = 'boite-ui-v1';
/** What the echo provider's `[tool-stream]` directive types, one piece at a time. */
const STREAMED_TOOL_INPUT = '{"command":"echo streamed","description":"a streamed input"}';

let core: RunningCore;
let page: BrowserPage;
let projectDir: string;
/** Where the core puts the project's worktrees: beside it, under `.boite-worktrees`. */
let worktreesDir: string;

function testid(id: string): string {
  return `[data-testid=${id}]`;
}

function textOf(id: string): string {
  return `document.querySelector('${testid(id)}')?.textContent.replace(/\\s+/g, ' ').trim()`;
}

const ASSISTANT_TEXT = `Array.from(document.querySelectorAll('${testid('message')}[data-role=assistant] ${testid('text-part')}')).map((node) => node.textContent).join(' ')`;

async function clickWhenEnabled(selector: string): Promise<void> {
  await page.waitFor(`document.querySelector('${selector}') && !document.querySelector('${selector}').disabled`);
  await page.click(selector);
}

beforeAll(async () => {
  {
    const built = Bun.spawnSync({
      cmd: ['bun', 'run', '--cwd', 'packages/ui', 'build'],
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    });
    if (!built.success) throw new Error(`the ui did not build:\n${built.stderr.toString()}`);
  }
  core = await startCore();
  projectDir = mkdtempSync(join(tmpdir(), 'boite-e2e-ui-'));
  worktreesDir = join(tmpdir(), '.boite-worktrees', basename(projectDir));
  page = await BrowserPage.launch({ url: pairingUrlOf(core) });
});

afterAll(async () => {
  await page?.close();
  await core?.stop();
  if (projectDir !== undefined) await removeDirectory(projectDir);
  if (worktreesDir !== undefined) await removeDirectory(worktreesDir);
});

test(
  'a fresh core opens on the first-run card, connected to the core it was paired with',
  async () => {
    await page.waitFor(`${textOf('status-connection')} === 'Connected'`, 30_000);
    await page.waitFor(`document.querySelector('${testid('first-run')}')`);
    await page.waitFor(`document.querySelector('${testid('sidebar')}')`);
  },
  TIMEOUT,
);

test(
  'opening a folder makes a project and a draft thread, and the first send creates the thread',
  async () => {
    await page.type(testid('project-path'), projectDir);
    await clickWhenEnabled(testid('project-add'));
    await page.waitFor(`${textOf('project-row')}.includes(${JSON.stringify(basename(projectDir))})`);
    await page.waitFor(`document.querySelector('${testid('draft-row')}')`);
    expect(await page.evaluate<number>(`document.querySelectorAll('${testid('thread-row')}').length`)).toBe(0);

    // The picker: the echo tile on the rail, then its one model on the right, which closes it.
    await page.click(testid('composer-picker'));
    await page.waitFor(`document.querySelector('${testid('composer-picker-menu')}')`);
    await page.click(`${testid('composer-picker-menu')} [data-provider="echo"]`);
    await page.click(`${testid('composer-picker-menu')} [data-model="echo"]`);
    await page.waitFor(`!document.querySelector('${testid('composer-picker-menu')}')`);
    await page.waitFor(`${textOf('composer-picker')}.startsWith('Echo')`);

    await page.type(testid('composer-input'), 'browser thread [permission]');
    await clickWhenEnabled(testid('composer-send'));

    await page.waitFor(`${textOf('thread-title')} === 'browser thread [permission]'`, 30_000);
    await page.waitFor(`document.querySelectorAll('${testid('thread-row')}').length === 1`);
    expect(await page.evaluate<boolean>(`!!document.querySelector('${testid('draft-row')}')`)).toBe(false);
  },
  TIMEOUT,
);

test(
  'the turn streams, the permission is allowed inline, and the thread goes back to idle',
  async () => {
    await page.waitFor(`document.querySelector('${testid('permission-card')}')`, 30_000);
    expect(await page.text(testid('permission-input'))).toContain('echo');

    await page.click(testid('permission-allow'));
    await page.waitFor(
      `document.querySelector('${testid('permission-card')}').dataset.decision === 'allow'`,
      30_000,
    );
    await page.waitFor(`document.querySelector('${testid('thread-status')}').dataset.status === 'idle'`, 30_000);

    const assistant = await page.evaluate<string>(ASSISTANT_TEXT);
    expect(assistant).toContain('browser thread');
    expect(assistant).toContain('allowed');

    await page.screenshot(SCREENSHOT);
    expect(existsSync(SCREENSHOT)).toBe(true);
  },
  TIMEOUT,
);

test(
  'the first finished turn gets the agent title, a rename keeps it, and the menu asks again',
  async () => {
    // The echo agent's rule: its prefix and the first words of the prompt, the directive cut.
    await page.waitFor(`${textOf('thread-title')} === 'Echo: browser thread'`, 30_000);
    await page.waitFor(`${textOf('thread-row')} .includes('Echo: browser thread')`);

    // A name the user gave is theirs until they ask the agent again.
    const client = await connect(core.url, core.token);
    try {
      const threads = await client.call('threads.list', {});
      const mine = threads[0];
      if (mine === undefined) throw new Error('no thread to rename');
      expect(mine.titleSource).toBe('agent');
      const renamed = await client.call('threads.update', { threadId: mine.id, title: 'my own name' });
      expect(renamed.titleSource).toBe('user');
    } finally {
      client.close();
    }
    await page.waitFor(`${textOf('thread-title')} === 'my own name'`);

    await page.evaluate<null>(
      `(() => { document.querySelector('${testid('thread-row')}').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 120 })); return null; })()`,
    );
    await page.waitFor(`document.querySelector('${testid('context-menu')} [data-value=retitle]')`);
    await page.screenshot(RETITLE_SCREENSHOT);
    await page.click(`${testid('context-menu')} [data-value=retitle]`);
    await page.waitFor(`${textOf('thread-title')} === 'Echo: browser thread'`, 30_000);
    // The echo agent answers faster than the menu's closing animation runs.
    await page.waitFor(`!document.querySelector('${testid('context-menu')}')`);
  },
  TIMEOUT,
);

test(
  'a claude code transcript filed for the project is imported as a thread from the project menu',
  async () => {
    // An isolated claude account: its transcripts live in the core's data
    // directory, filed where the CLI would file this project's sessions.
    const client = await connect(core.url, core.token);
    try {
      const account = await client.call('accounts.add', { providerId: 'claude', label: 'imports' });
      if (account.isolationDir === null) throw new Error('the account must be isolated');
      const folder = join(account.isolationDir, 'projects', claudeProjectFolder(projectDir));
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, `${FIXTURE_SESSION_ID}.jsonl`), claudeSessionFixture(projectDir, { aiTitle: 'Folder listing' }));
    } finally {
      client.close();
    }

    await page.evaluate<null>(
      `(() => { document.querySelector('${testid('project-row')}').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 60 })); return null; })()`,
    );
    await page.waitFor(`document.querySelector('${testid('context-menu')} [data-value=import]')`);
    await page.click(`${testid('context-menu')} [data-value=import]`);
    await page.waitFor(`document.querySelectorAll('${testid('import-row')}').length === 1`);
    expect(await page.evaluate<string>(`document.querySelector('${testid('import-row')} .title').textContent`)).toBe('Folder listing');
    await page.screenshot(IMPORT_SCREENSHOT);

    await page.click(testid('import-row'));
    await page.waitFor(`!document.querySelector('${testid('import-dialog')}')`);
    await page.waitFor(`${textOf('thread-title')} === 'Folder listing'`);
    await page.waitFor(`document.querySelectorAll('${testid('message')}').length === 4`);
    expect(await page.evaluate<string>(ASSISTANT_TEXT)).toContain('Two files. Hello.');

    const reader = await connect(core.url, core.token);
    try {
      const threads = await reader.call('threads.list', {});
      const imported = threads.find((thread) => thread.sessionId === FIXTURE_SESSION_ID);
      if (imported === undefined) throw new Error('the imported thread is not listed');
      expect(imported).toMatchObject({ title: 'Folder listing', titleSource: 'agent', status: 'idle' });
      // Out of the way: the tests after this one type into the echo thread and
      // count the rows of the sidebar.
      await reader.call('threads.archive', { threadId: imported.id, archived: true });
    } finally {
      reader.close();
    }
    await page.waitFor(`!Array.from(document.querySelectorAll('${testid('thread-row')}')).some((row) => row.textContent.includes('Folder listing'))`);
    await page.evaluate<null>(
      `(() => { Array.from(document.querySelectorAll('${testid('thread-row')}')).find((row) => row.textContent.includes('Echo: browser thread')).click(); return null; })()`,
    );
    await page.waitFor(`${textOf('thread-title')} === 'Echo: browser thread'`);
    await page.waitFor(`document.querySelector('${testid('thread-status')}').dataset.status === 'idle'`);
  },
  TIMEOUT,
);

test(
  'a tool input is shown growing in the card, then replaced by the parsed one',
  async () => {
    // The card is only open while the json arrives, so the page samples it on a
    // timer of its own: polling from here would race a window of half a second.
    await page.evaluate<null>(
      `(() => {
        window.__toolSamples = [];
        window.__toolTimer = setInterval(() => {
          const card = document.querySelector('${testid('tool-card')}[data-streaming=true]');
          const pre = card?.querySelector('${testid('tool-input')}');
          if (pre) window.__toolSamples.push(pre.textContent);
        }, 10);
        return null;
      })()`,
    );

    await page.type(testid('composer-input'), 'now [tool-stream] please');
    await clickWhenEnabled(testid('composer-send'));
    await page.waitFor(`document.querySelector('${testid('tool-card')}')`, 30_000);
    await page.waitFor(`document.querySelector('${testid('thread-status')}').dataset.status === 'idle'`, 30_000);
    await page.evaluate<null>(`(() => { clearInterval(window.__toolTimer); return null; })()`);

    const samples = await page.evaluate<string[]>('window.__toolSamples');
    expect(samples.length).toBeGreaterThan(0);
    for (const text of samples) expect(STREAMED_TOOL_INPUT.startsWith(text)).toBe(true);
    // More than one distinct value is the whole point: it grew, it did not land whole.
    expect(new Set(samples).size).toBeGreaterThan(1);
    expect(samples.at(-1)).toBe(STREAMED_TOOL_INPUT);

    // The parsed input took over and the card folded back to its one line.
    expect(await page.evaluate<string>(`document.querySelector('${testid('tool-card')}').dataset.streaming`)).toBe(
      'false',
    );
    expect(await page.evaluate<string>(`document.querySelector('${testid('tool-card')} .line').textContent`)).toBe(
      'echo streamed',
    );
    await page.click(testid('tool-toggle'));
    await page.waitFor(`document.querySelector('${testid('tool-input')}')`);
    expect(await page.text(testid('tool-input'))).toContain('"command": "echo streamed"');

    await page.screenshot(TOOL_SCREENSHOT);
    expect(existsSync(TOOL_SCREENSHOT)).toBe(true);
  },
  TIMEOUT,
);

test(
  'a diff document is drawn under the tool card that produced it',
  async () => {
    await page.type(testid('composer-input'), 'now [diff] please');
    await clickWhenEnabled(testid('composer-send'));
    await page.waitFor(`document.querySelector('${testid('tool-document-chip')}')`, 30_000);
    await page.waitFor(`document.querySelector('${testid('thread-status')}').dataset.status === 'idle'`, 30_000);

    // The folded card says what it carries, and only opening it draws the diff.
    expect(await page.text(testid('tool-document-chip'))).toBe('1 diff');
    await page.click(
      `${testid('tool-card')}:has(${testid('tool-document-chip')}) ${testid('tool-toggle')}`,
    );
    await page.waitFor(`document.querySelector('${testid('tool-document')}[data-kind=diff]')`);

    const gutters = await page.evaluate<string[]>(
      `Array.from(document.querySelectorAll('${testid('diff-row')}')).map((row) => row.querySelector('.gutter').textContent)`,
    );
    expect(gutters).toContain('-');
    expect(gutters).toContain('+');

    const removed = await page.evaluate<string>(
      `document.querySelector('${testid('diff-row')}[data-kind=remove] .text').textContent`,
    );
    expect(removed).toContain('return start();');
    const added = await page.evaluate<string>(
      `document.querySelector('${testid('diff-row')}[data-kind=add] .text').textContent`,
    );
    expect(added).toContain('warm: true');
    expect(
      await page.evaluate<string>(`document.querySelector('${testid('diff-view')}').dataset.path`),
    ).toBe('src/app.ts');

    await page.screenshot(DIFF_SCREENSHOT);
    expect(existsSync(DIFF_SCREENSHOT)).toBe(true);
  },
  TIMEOUT,
);

test(
  'a question is asked inline, answered from the card, and the answer comes back',
  async () => {
    await page.type(testid('composer-input'), 'now question please');
    await clickWhenEnabled(testid('composer-send'));
    await page.waitFor(`document.querySelector('${testid('question-card')}')`, 30_000);
    expect(await page.text(testid('question-text'))).toContain('Which shape');
    // Nothing picked yet, so there is nothing to send.
    expect(
      await page.evaluate<boolean>(`document.querySelector('${testid('question-submit')}').disabled`),
    ).toBe(true);

    await page.click(`${testid('question-option')}[data-option=short]`);
    await page.type(testid('question-text-input'), 'one line please');
    await clickWhenEnabled(testid('question-submit'));

    await page.waitFor(
      `document.querySelector('${testid('question-card')}').dataset.state === 'answered'`,
      30_000,
    );
    expect(await page.text(testid('question-answer'))).toBe('Short: one line please');
    await page.waitFor(`document.querySelector('${testid('thread-status')}').dataset.status === 'idle'`, 30_000);

    const assistant = await page.evaluate<string>(ASSISTANT_TEXT);
    expect(assistant).toContain('answered short one line please');

    await page.screenshot(QUESTION_SCREENSHOT);
    expect(existsSync(QUESTION_SCREENSHOT)).toBe(true);
  },
  TIMEOUT,
);

test(
  'an image pasted into the composer reaches the agent and is drawn under the prompt',
  async () => {
    // Chromium builds the file, the transfer and the event; the composer sees
    // exactly what a Ctrl+V of a screenshot would hand it.
    await page.evaluate<null>(
      `(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#d9773b';
        ctx.fillRect(0, 0, 64, 64);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(16, 16, 32, 32);
        return new Promise((resolve) => canvas.toBlob((blob) => {
          const file = new File([blob], 'square.png', { type: 'image/png' });
          const transfer = new DataTransfer();
          transfer.items.add(file);
          const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true });
          document.querySelector('${testid('composer-input')}').dispatchEvent(event);
          resolve(null);
        }, 'image/png'));
      })()`,
    );
    await page.waitFor(`document.querySelectorAll('${testid('composer-attachment')}').length === 1`, 10_000);
    await page.screenshot(ATTACHMENT_SCREENSHOT);

    await page.type(testid('composer-input'), 'what is this square');
    await clickWhenEnabled(testid('composer-send'));
    await page.waitFor(`${ASSISTANT_TEXT}.includes('what is this square')`, 30_000);
    await page.waitFor(`document.querySelector('${testid('thread-status')}').dataset.status === 'idle'`, 30_000);

    // The strip is empty again, the echo names the image it was given, and the
    // user bubble carries the thumbnail as a part of the journalled message.
    expect(await page.evaluate<number>(`document.querySelectorAll('${testid('composer-attachment')}').length`)).toBe(0);
    const assistant = await page.evaluate<string>(ASSISTANT_TEXT);
    expect(assistant).toMatch(/\[image image\/png, \d+ bytes, square\.png\] what is this square/);
    const images = await page.evaluate<string[]>(
      `Array.from(document.querySelectorAll('${testid('message')}[data-role=user] ${testid('image-part')}')).map((img) => img.getAttribute('src').slice(0, 22))`,
    );
    expect(images).toEqual(['data:image/png;base64,']);
    await page.screenshot(ATTACHMENT_SENT_SCREENSHOT);
    expect(existsSync(ATTACHMENT_SENT_SCREENSHOT)).toBe(true);
  },
  TIMEOUT,
);

test(
  'a slash at the start of the composer lists the agent commands, and the picked one reaches the agent',
  async () => {
    // The echo listed its commands on the first turn of this thread, so the
    // menu has an agent group to show before Boite's own commands.
    await page.type(testid('composer-input'), '/');
    await page.waitFor(`document.querySelector('${testid('slash-menu')}')`, 10_000);
    const names = await page.evaluate<string[]>(
      `Array.from(document.querySelectorAll('${testid('slash-row')}')).map((row) => row.dataset.name)`,
    );
    expect(names.slice(0, 2)).toEqual(['shout', 'whisper']);
    expect(names.length).toBeGreaterThan(2);
    await page.screenshot(SLASH_SCREENSHOT);

    await page.type(testid('composer-input'), '/sh');
    await page.waitFor(`document.querySelectorAll('${testid('slash-row')}').length === 1`, 10_000);
    await page.evaluate<null>(
      `(() => {
        const box = document.querySelector('${testid('composer-input')}');
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        return null;
      })()`,
    );
    await page.waitFor(`!document.querySelector('${testid('slash-menu')}')`, 10_000);
    expect(await page.evaluate<string>(`document.querySelector('${testid('composer-input')}').value`)).toBe('/shout ');

    await page.type(testid('composer-input'), '/shout the square again');
    await clickWhenEnabled(testid('composer-send'));
    await page.waitFor(`${ASSISTANT_TEXT}.includes('THE SQUARE AGAIN')`, 30_000);
    await page.waitFor(`document.querySelector('${testid('thread-status')}').dataset.status === 'idle'`, 30_000);
  },
  TIMEOUT,
);

test(
  'an at sign lists the project files the core walked, and the picked one is written in as a path',
  async () => {
    // The project directory was empty until now: a few files, one of them
    // under a directory the root .gitignore names, so the walk is the real one.
    mkdirSync(join(projectDir, 'src', 'lib'), { recursive: true });
    mkdirSync(join(projectDir, 'dist'), { recursive: true });
    writeFileSync(join(projectDir, 'README.md'), '# e2e\n');
    writeFileSync(join(projectDir, 'src', 'app.ts'), 'export {};\n');
    writeFileSync(join(projectDir, 'src', 'lib', 'store.ts'), 'export {};\n');
    writeFileSync(join(projectDir, 'dist', 'app.js'), '');
    writeFileSync(join(projectDir, '.gitignore'), 'dist/\n');

    await page.type(testid('composer-input'), 'look at @');
    await page.waitFor(`document.querySelectorAll('${testid('mention-row')}').length >= 4`, 10_000);
    const names = await page.evaluate<string[]>(
      `Array.from(document.querySelectorAll('${testid('mention-row')}')).map((row) => row.dataset.name)`,
    );
    expect(names).toContain('src/lib/store.ts');
    expect(names).not.toContain('dist/app.js');
    await page.screenshot(MENTION_SCREENSHOT);

    await page.type(testid('composer-input'), 'look at @sto');
    await page.waitFor(
      `document.querySelectorAll('${testid('mention-row')}').length === 1 && document.querySelector('${testid('mention-row')}').dataset.name === 'src/lib/store.ts'`,
      10_000,
    );
    await page.evaluate<null>(
      `(() => {
        const box = document.querySelector('${testid('composer-input')}');
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        return null;
      })()`,
    );
    await page.waitFor(`!document.querySelector('${testid('mention-menu')}')`, 10_000);
    expect(await page.evaluate<string>(`document.querySelector('${testid('composer-input')}').value`)).toBe(
      'look at @src/lib/store.ts ',
    );
    await page.type(testid('composer-input'), '');
  },
  TIMEOUT,
);

test(
  'the trace panel lists what the turn launched, or says it launched nothing',
  async () => {
    await page.click(testid('tab-trace'));
    await page.waitFor(`document.querySelector('${testid('trace-panel')}')`);
    await page.waitFor(
      `document.querySelector('${testid('trace-row')}') || document.querySelector('${testid('trace-empty')}')`,
    );
    await page.click(testid('tab-trace'));
    await page.waitFor(`!document.querySelector('${testid('trace-panel')}')`);
  },
  TIMEOUT,
);

test(
  'a draft with the worktree chip on starts its thread on a branch, in a worktree git made beside the project',
  async () => {
    // The project becomes a repository with one commit: what a worktree needs.
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'boite e2e',
      GIT_AUTHOR_EMAIL: 'e2e@boite.invalid',
      GIT_COMMITTER_NAME: 'boite e2e',
      GIT_COMMITTER_EMAIL: 'e2e@boite.invalid',
    };
    for (const args of [['init', '-q'], ['add', '.'], ['commit', '-q', '-m', 'init']]) {
      const run = Bun.spawnSync({ cmd: ['git', ...args], cwd: projectDir, env, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
      if (!run.success) throw new Error(`git ${args.join(' ')} failed: ${run.stderr.toString()}`);
    }

    await page.click(testid('new-thread'));
    await page.waitFor(`document.querySelector('${testid('composer-worktree')}')`);
    expect(await page.evaluate<string>(`document.querySelector('${testid('composer-worktree')}').getAttribute('aria-pressed')`)).toBe('false');
    await page.click(testid('composer-worktree'));
    await page.waitFor(`document.querySelector('${testid('composer-worktree')}').getAttribute('aria-pressed') === 'true'`);
    await page.waitFor(`${textOf('composer-picker')}.startsWith('Echo')`);
    await page.type(testid('composer-input'), 'worktree thread');
    await clickWhenEnabled(testid('composer-send'));

    await page.waitFor(`${textOf('thread-branch')} === 'boite/worktree-thread'`, 30_000);
    // The turn is over in a blink and the echo agent's title lands right behind it.
    await page.waitFor(`${textOf('thread-title')} === 'Echo: worktree thread'`);
    const worktree = join(worktreesDir, 'worktree-thread');
    expect(existsSync(join(worktree, '.git'))).toBe(true);
    expect(existsSync(join(worktree, 'src', 'lib', 'store.ts'))).toBe(true);
    expect(await page.evaluate<string>(`document.querySelector('${testid('thread-branch')}').title`)).toContain(worktree);
    await page.screenshot(WORKTREE_SCREENSHOT);
    // The chip is a draft's: the thread has no such choice left.
    expect(await page.evaluate<boolean>(`!!document.querySelector('${testid('composer-worktree')}')`)).toBe(false);

    // The tests after this one count on the first thread being the open one:
    // the worktree thread is archived and the first row opened again.
    const client = await connect(core.url, core.token);
    try {
      const threads = await client.call('threads.list', {});
      const created = threads.find((entry) => entry.branch === 'boite/worktree-thread');
      if (created === undefined) throw new Error('the worktree thread is not listed');
      await client.call('threads.archive', { threadId: created.id, archived: true });
    } finally {
      client.close();
    }
    await page.waitFor(`document.querySelectorAll('${testid('thread-row')}').length === 1`);
    await page.click(testid('thread-row'));
    await page.waitFor(`${textOf('thread-title')} === 'Echo: browser thread'`);
  },
  TIMEOUT,
);

test(
  'the keybindings file is read the moment it is saved, and the moved chord works in the page',
  async () => {
    const file = join(core.dataDir, 'keybindings.json');
    const keyOf = (id: string) =>
      `document.querySelector('${testid('keybinding-row')}[data-command=${id}] ${testid('keybinding-key')}')?.textContent.trim()`;
    const chord = (init: string) =>
      `(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { ${init}, bubbles: true, cancelable: true })); return null; })()`;

    writeFileSync(file, JSON.stringify({ 'new-thread': 'mod+shift+n', nope: 'mod+x' }));
    await page.click(testid('nav-settings'));
    await page.click(testid('settings-tab-keyboard'));
    // The core watched the write and announced it; the page redrew the row.
    await page.waitFor(`${keyOf('new-thread')} === 'Ctrl+Shift+N'`);
    expect(await page.evaluate<string>(keyOf('palette'))).toBe('Ctrl+K');
    expect(await page.evaluate<string>(textOf('keybindings-path'))).toBe(file);
    expect(await page.evaluate<string>(textOf('keybinding-error'))).toContain('"nope" is not a command Boite has');
    await page.screenshot(KEYBOARD_SCREENSHOT);

    // The old chord is nobody's now; the new one opens a draft from the settings page.
    await page.evaluate<null>(chord(`key: 'n', ctrlKey: true`));
    expect(await page.evaluate<boolean>(`!!document.querySelector('${testid('keyboard-page')}')`)).toBe(true);
    await page.evaluate<null>(chord(`key: 'N', ctrlKey: true, shiftKey: true`));
    await page.waitFor(`document.querySelector('${testid('draft-empty')}')`);
    expect(await page.evaluate<string>(`document.querySelector('${testid('new-thread')}').title`)).toEndWith('(Ctrl+Shift+N)');

    // The file goes, the default comes back, and the draft closes on the first row.
    rmSync(file);
    await page.waitFor(`document.querySelector('${testid('new-thread')}').title.endsWith('(Ctrl+N)')`);
    await page.click(testid('thread-row'));
    await page.waitFor(`${textOf('thread-title')} === 'Echo: browser thread'`);
  },
  TIMEOUT,
);

test(
  'settings show the core the UI is connected to',
  async () => {
    await page.click(testid('nav-settings'));
    await page.waitFor(`document.querySelector('${testid('settings-page')}')`);
    const url = await page.evaluate<string>(`document.querySelector('${testid('settings-core-url')}').value`);
    expect(url).toBe(core.url);
    expect(await page.evaluate<string>(textOf('settings-endpoint'))).toBe(`127.0.0.1:${core.port}`);
    expect(await page.evaluate<string>(textOf('settings-version'))).toBe(corePackage.version);

    await page.click(testid('settings-back'));
    await page.waitFor(`document.querySelector('${testid('chat')}')`);
    expect(await page.evaluate<string>(textOf('thread-title'))).toBe('Echo: browser thread');
  },
  TIMEOUT,
);

test(
  'a permission asked before the page existed is still answerable after a fresh load',
  async () => {
    const client = await connect(core.url, core.token);
    try {
      const project = await client.call('projects.add', { path: projectDir });
      const accounts = await client.call('accounts.list', {});
      const account = accounts.find((entry) => entry.providerId === 'echo');
      if (account === undefined) throw new Error('no echo account');
      const thread = await client.call('threads.create', {
        projectId: project.id,
        providerId: 'echo',
        accountId: account.id,
        title: 'reloaded permission',
      });

      // Only a subscribed socket is told; that is the whole reason for the method.
      await client.call('threads.subscribe', { threadId: thread.id });
      const requested = client.next<'permission.requested'>(
        'permission.requested',
        (request) => request.threadId === thread.id,
        TIMEOUT,
      );
      const finished = client.next<'turn.finished'>(
        'turn.finished',
        (turn) => turn.threadId === thread.id,
        TIMEOUT,
      );
      await client.call('turns.start', { threadId: thread.id, prompt: 'reloaded [permission]' });
      await requested;

      // The page is thrown away and loaded again only now: `permission.requested`
      // fired before this document existed, so the card can only come from
      // `permissions.list`.
      await page.navigate(pairingUrlOf(core));
      await page.waitFor(`${textOf('thread-title')} === 'reloaded permission'`, 30_000);
      await page.waitFor(`document.querySelector('${testid('permission-card')}')`, 30_000);
      await page.waitFor(`document.querySelector('${testid('permission-input')}')`, 30_000);
      expect(await page.text(testid('permission-input'))).toContain('echo');
      await page.screenshot(RELOAD_SCREENSHOT);

      await page.click(testid('permission-allow'));
      expect((await finished).status).toBe('done');
      await page.waitFor(
        `document.querySelector('${testid('permission-card')}').dataset.decision === 'allow'`,
        30_000,
      );
    } finally {
      client.close();
    }
  },
  TIMEOUT,
);

test(
  'a second browser pairs on the one-time link, gets a key of its own, and the desktop can revoke it',
  async () => {
    // A fresh profile, like a phone: no stored endpoint, only the grant link.
    const phone = await BrowserPage.launch({ url: core.pairingUrl });
    try {
      await phone.waitFor(`${textOf('status-connection')} === 'Connected'`, 30_000);
      const stored = await phone.evaluate<{ url: string; token: string }>(`JSON.parse(localStorage.getItem('boite.core'))`);
      expect(stored.token).toHaveLength(64);
      expect(stored.token).not.toBe(core.token);
      expect(await phone.evaluate<string>('location.search')).toBe('');

      // Same link again: refused, and the page says so instead of retrying forever.
      const again = await BrowserPage.launch({ url: core.pairingUrl });
      try {
        await again.waitFor(`document.querySelector('${testid('error-toast')}')`, 30_000);
        expect(await again.text(testid('error-toast'))).toContain('already used');
      } finally {
        await again.close();
      }

      // The desktop lists the phone and revokes it; the phone's socket closes and its key is dead.
      await page.click(testid('nav-settings'));
      await page.waitFor(`document.querySelector('${testid('paired-devices')} li[data-session-id]')`, 30_000);
      const client = await connect(core.url, core.token);
      try {
        const sessions = await client.call('sessions.list', {});
        expect(sessions.map((session) => session.client.name)).toEqual(['pwa']);
        await client.call('sessions.revoke', { sessionId: sessions[0]?.id ?? '' });
      } finally {
        client.close();
      }
      await page.waitFor(`!document.querySelector('${testid('paired-devices')}')`, 30_000);
      // The phone's reconnect is refused once, then it stops, drops its dead key and says why.
      await phone.waitFor(`${textOf('status-connection')} === 'Disconnected'`, 30_000);
      await phone.waitFor(`document.querySelector('${testid('error-toast')}')`, 30_000);
      expect(await phone.text(testid('error-toast'))).toContain('revoked');
      expect(await phone.evaluate<string | null>(`localStorage.getItem('boite.core')`)).toBeNull();
      await page.click(testid('settings-back'));
    } finally {
      await phone.close();
    }
  },
  TIMEOUT,
);

test(
  'the page reconnects on its own to a core restarted on the same port, and the next turn streams',
  async () => {
    // Survives a reconnect and nothing else: this is what tells one apart from
    // a reload, which would take the marker and the navigation entry with it.
    await page.evaluate<null>(`(() => { window.__boiteAlive = 'before the drop'; return null; })()`);
    const rows = await page.evaluate<number>(`document.querySelectorAll('${testid('thread-row')}').length`);
    expect(rows).toBe(2);

    // Same port, same data directory, so the same journal and the same token:
    // `core.json` holds the token and `main.ts` reads it back instead of
    // minting one, which is what lets the page's own `hello` land again.
    const { port, dataDir, token } = core;
    await core.stop({ keepDataDir: true });
    await page.waitFor(`${textOf('status-connection')} !== 'Connected'`, RECONNECT_TIMEOUT_MS);
    core = await startCore({ port, dataDir });
    expect(core.port).toBe(port);
    expect(core.token).toBe(token);

    // Nobody is awaiting this: the client's own backoff reopens the socket,
    // says `hello` again, resubscribes the open thread, and the store reloads
    // on `ready`.
    await page.waitFor(`${textOf('status-connection')} === 'Connected'`, RECONNECT_TIMEOUT_MS);
    expect(await page.evaluate<string>('window.__boiteAlive')).toBe('before the drop');
    expect(await page.evaluate<number>(`performance.getEntriesByType('navigation').length`)).toBe(1);

    await page.waitFor(`document.querySelectorAll('${testid('thread-row')}').length === ${rows}`);
    // The permission turn finished before the restart, so the echo agent had titled the thread.
    expect(await page.evaluate<string>(textOf('thread-title'))).toBe('Echo: reloaded');

    await page.type(testid('composer-input'), 'after the restart');
    await clickWhenEnabled(testid('composer-send'));
    await page.waitFor(`${ASSISTANT_TEXT}.includes('after the restart')`, RECONNECT_TIMEOUT_MS);
    await page.waitFor(
      `document.querySelector('${testid('thread-status')}').dataset.status === 'idle'`,
      RECONNECT_TIMEOUT_MS,
    );
  },
  RECONNECT_TIMEOUT_MS,
);

test(
  'the service worker caches the shell, and the app still paints when the core is gone',
  async () => {
    // Registered after the first paint by `lib/sw.ts`, so it is installed and
    // controlling this page long before the suite reaches this test.
    await page.waitFor('navigator.serviceWorker.controller !== null', RECONNECT_TIMEOUT_MS);
    await page.evaluate<null>('navigator.serviceWorker.ready.then(() => null)');
    expect(await page.evaluate<string[]>('caches.keys()')).toEqual([UI_CACHE]);

    // The hashed files of the first load were fetched before the worker took
    // control, so they only reach the cache on the load after it: which is
    // exactly the phone that opens Boite a second time.
    await page.navigate(`${core.url}/`);
    await page.waitFor(`${textOf('status-connection')} === 'Connected'`, RECONNECT_TIMEOUT_MS);
    const cachedPaths = `caches.open(${JSON.stringify(UI_CACHE)})
      .then((cache) => cache.keys())
      .then((keys) => keys.map((request) => new URL(request.url).pathname))`;
    await page.waitFor(`${cachedPaths}.then((paths) => paths.some((path) => path.startsWith('/assets/')))`, 30_000);
    const entries = await page.evaluate<string[]>(cachedPaths);
    expect(entries).toContain('/');
    expect(entries.filter((path) => path.startsWith('/assets/')).length).toBeGreaterThan(0);

    // The core goes away, and the reload has nothing but that cache to load from.
    const { port, dataDir, token } = core;
    await core.stop({ keepDataDir: true });
    await page.waitFor(`${textOf('status-connection')} !== 'Connected'`, RECONNECT_TIMEOUT_MS);
    await page.navigate(`${core.url}/`);

    // A browser with no worker gets its own error page here: no shell, no title.
    await page.waitFor(`document.querySelector('${testid('sidebar')}')`, RECONNECT_TIMEOUT_MS);
    expect(await page.evaluate<string>('document.title')).toBe('Boite');
    // The threads are the core's, so with no answer the shell opens on its
    // first-run card: the point is that it is the app drawing it, not Chromium.
    expect(
      await page.evaluate<boolean>(
        `!!document.querySelector('${testid('first-run')}') || !!document.querySelector('${testid('chat')}')`,
      ),
    ).toBe(true);
    const offline = await page.evaluate<string>(textOf('status-connection'));
    expect(offline).not.toBe('Connected');
    expect(['Connecting', 'Disconnected', 'Not connected']).toContain(offline);
    await page.screenshot(OFFLINE_SCREENSHOT);
    expect(existsSync(OFFLINE_SCREENSHOT)).toBe(true);

    // Back on the same port: the page finds the core again with no help.
    core = await startCore({ port, dataDir });
    expect(core.token).toBe(token);
    await page.waitFor(`${textOf('status-connection')} === 'Connected'`, RECONNECT_TIMEOUT_MS);
  },
  TIMEOUT,
);
