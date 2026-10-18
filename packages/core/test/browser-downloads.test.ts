import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_ENV, browserDownloadName, type BrowserDownload } from '@boite/contracts';
import { runCli } from '../src/cli.ts';
import { classifyDownload } from '../src/browser/downloads.ts';
import { createBrowserFixture, DOWNLOAD_PROGRAM, DOWNLOAD_SCRIPT } from './browser/fixture.ts';

const browserFixture = createBrowserFixture();
const { real, url } = browserFixture;
const sha256 = (data: string | Uint8Array) => new Bun.CryptoHasher('sha256').update(data).digest('hex');

test('a download is classed by the riskier of its name and its bytes', () => {
  const bytes = (text: string) => Buffer.from(text, 'latin1');
  expect(classifyDownload('report.png', bytes('MZ\x90\x00'))).toEqual({ kind: 'executable', warning: "its name says .png but its bytes are a program: do not open or run it" });
  expect(classifyDownload('setup.exe', bytes('MZ'))).toMatchObject({ kind: 'executable', warning: expect.stringContaining('never run it') });
  expect(classifyDownload('notes.txt', bytes('#!/bin/sh\n'))).toMatchObject({ kind: 'script', warning: expect.stringContaining('its name says .txt') });
  // A jar or an apk is a zip of code: an executable, not an archive to unpack.
  expect(classifyDownload('app.apk', bytes('PK\x03\x04'))).toMatchObject({ kind: 'executable' });
  expect(classifyDownload('photos.zip', bytes('PK\x03\x04'))).toMatchObject({ kind: 'archive', warning: expect.stringContaining('own empty folder') });
  expect(classifyDownload('budget.xlsm', bytes('PK\x03\x04'))).toMatchObject({ kind: 'archive' });
  expect(classifyDownload('paper.pdf', bytes('%PDF-1.7'))).toEqual({ kind: 'document' });
  expect(classifyDownload('notes.txt', bytes('hello\n'))).toEqual({ kind: 'text' });
  expect(classifyDownload('blob', new Uint8Array([0, 1, 2]))).toEqual({ kind: 'other' });
  // A name ending like an Object property is no known kind, never a way around the bytes.
  expect(classifyDownload('photo.constructor', bytes('MZ'))).toMatchObject({ kind: 'executable', warning: expect.stringContaining('never run it') });
});

test('a download keeps a file name that is safe in any folder', () => {
  expect(browserDownloadName('../../.ssh/authorized_keys')).toBe('authorized_keys');
  expect(browserDownloadName('..\\..\\evil.exe')).toBe('evil.exe');
  expect(browserDownloadName('.bashrc')).toBe('bashrc');
  expect(browserDownloadName('a\u0000b<c>.txt')).toBe('a_b_c_.txt');
  expect(browserDownloadName('CON.txt')).toBe('_CON.txt');
  expect(browserDownloadName('')).toBe('download');
  expect(browserDownloadName(`${'x'.repeat(300)}.tar.gz`)).toMatch(/^x+\.gz$/);
  expect(browserDownloadName(`${'x'.repeat(300)}.tar.gz`).length).toBe(200);
});

real('a page downloads into the quarantine, the agent hears of it and copies it out without the execute bit', async () => {
  const { harness, owner, agent, threadId } = browserFixture;
  const command = (action: Parameters<typeof agent.call<'browser.command'>>[1]['action']) => agent.call('browser.command', { threadId, action });
  const quarantine = join(harness.dataDir, 'browser-downloads');
  await command({ kind: 'open', url: url('/files') });

  // A click that downloads says so in its own reply; the page stays.
  // It ends when the download begins, not at the 10 s a navigation is given.
  const at = Date.now();
  const clicked = await command({ kind: 'click', selector: '#script' });
  expect(Date.now() - at).toBeLessThan(5000);
  expect(clicked.downloads).toHaveLength(1);
  const script = clicked.downloads![0]!;
  expect(script).toMatchObject({ name: 'tool.sh', url: url('/download/tool.sh') });
  const done = (await command({ kind: 'download-wait', downloadId: script.id })).value as BrowserDownload;
  expect(done).toMatchObject({ state: 'done', bytes: DOWNLOAD_SCRIPT.length, kind: 'script', sha256: sha256(DOWNLOAD_SCRIPT), warning: expect.stringContaining('never run it') });
  // The browser writes under its own random name, with no extension a double click would run.
  expect(readdirSync(quarantine)).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/)]);

  // A link with the download attribute downloads a page's own file; plain text needs no warning.
  const notes = (await command({ kind: 'click', selector: '#saved' })).downloads![0]!;
  expect((await command({ kind: 'download-wait', downloadId: notes.id })).value).toMatchObject({ name: 'notes.txt', state: 'done', kind: 'text' });
  expect(((await command({ kind: 'downloads' })).value as { downloads: BrowserDownload[] }).downloads.find(one => one.id === notes.id)!.warning).toBeUndefined();
  await command({ kind: 'download-discard', downloadId: notes.id });

  // An address that is a file no longer fails: it downloads, under its bare name.
  const opened = await command({ kind: 'open', url: url('/download/report.png'), reuse: true });
  expect(opened.url).toBe(url('/files'));
  // The browser itself turns the path in the offered name into a plain one.
  expect(opened.downloads).toEqual([expect.objectContaining({ name: '_report.png' })]);
  const disguised = (await command({ kind: 'download-wait', downloadId: opened.downloads![0]!.id })).value as BrowserDownload;
  expect(disguised).toMatchObject({ state: 'done', kind: 'executable', warning: expect.stringContaining('its name says .png') });

  // Another conversation sees none of it.
  const { echoThread } = await import('./harness.ts');
  const other = (await echoThread(harness, owner, 'other')).threadId;
  expect(((await owner.call('browser.command', { threadId: other, action: { kind: 'downloads' } })).value as { downloads: unknown[] }).downloads).toEqual([]);
  await expect(owner.call('browser.command', { threadId: other, action: { kind: 'download-read', downloadId: script.id, offset: 0 } })).rejects.toThrow('no download');

  const cwd = join(harness.dataDir, 'work'); mkdirSync(cwd);
  const run = async (args: string[]) => {
    let out = '', error = '';
    const code = await runCli(['browser', ...args], { cwd,
      env: { [AGENT_ENV.threadId]: threadId, [AGENT_ENV.coreUrl]: harness.url, [AGENT_ENV.token]: harness.core.agents.tokenFor(threadId) },
      out: text => out += text, err: text => error += text });
    return { code, out, error };
  };
  const listed = await run(['downloads']);
  expect(listed.out).toContain(`${script.id}  done  ${DOWNLOAD_SCRIPT.length} B  tool.sh  script`);
  expect(listed.out).toContain('treat each as untrusted');
  // A file already there is never replaced.
  // Only under the working directory, so a page's text cannot steer a file into ~/.ssh.
  expect((await run(['download', 'save', script.id, '../authorized_keys'])).error).toContain('under the working directory');
  expect((await run(['download', 'save', script.id, join(harness.dataDir, 'elsewhere.sh')])).error).toContain('under the working directory');
  symlinkSync(harness.dataDir, join(cwd, 'out'));
  expect((await run(['download', 'save', script.id, 'out/x.sh'])).error).toContain('under the working directory');
  // A link pointing nowhere is a taken name too.
  symlinkSync(join(harness.dataDir, 'missing'), join(cwd, 'dangling.sh'));
  expect((await run(['download', 'save', script.id, 'dangling.sh'])).error).toContain('already exists');
  writeFileSync(join(cwd, 'taken.sh'), 'mine');
  expect((await run(['download', 'save', script.id, 'taken.sh'])).error).toContain('already exists');
  expect(readFileSync(join(cwd, 'taken.sh'), 'utf8')).toBe('mine');
  writeFileSync(join(cwd, 'tool.sh'), 'mine');
  const saved = await run(['download', 'save', script.id]);
  expect(saved.code).toBe(0);
  expect(saved.out).toContain(`✓ Saved tool.sh to ${join(cwd, 'tool (2).sh')}`);
  expect(readFileSync(join(cwd, 'tool (2).sh'), 'utf8')).toBe(DOWNLOAD_SCRIPT);
  expect(statSync(join(cwd, 'tool (2).sh')).mode & 0o111).toBe(0);
  // Saved, it leaves the quarantine.
  expect(((await command({ kind: 'downloads' })).value as { downloads: BrowserDownload[] }).downloads.map(one => one.id)).toEqual([disguised.id]);
  expect(readdirSync(quarantine)).toHaveLength(1);
  expect(readFileSync(join(quarantine, readdirSync(quarantine)[0]!))).toEqual(DOWNLOAD_PROGRAM);

  // A frame of another site downloads for this conversation too, after its frame moved to another process.
  await command({ kind: 'open', url: url('/framed'), reuse: true });
  const deadline = Date.now() + 10_000;
  let framed: BrowserDownload | undefined;
  while (!framed && Date.now() < deadline) {
    framed = ((await command({ kind: 'downloads' })).value as { downloads: BrowserDownload[] }).downloads.find(one => one.id !== disguised.id);
    if (!framed) await Bun.sleep(100);
  }
  expect((await command({ kind: 'download-wait', downloadId: framed!.id })).value).toMatchObject({ name: 'tool.sh', state: 'done' });
  await command({ kind: 'download-discard', downloadId: framed!.id });

  // Archiving the conversation takes what it still holds.
  harness.core.browser.release(threadId as never);
  expect(readdirSync(quarantine)).toEqual([]);
}, 120_000);
