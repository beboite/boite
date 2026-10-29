import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

test('the minified browser kit runs in a page without the bundler globals', async () => {
  const outdir = await mkdtemp(join(tmpdir(), 'boite-page-kit-'));
  try {
    const built = Bun.spawnSync([process.execPath, 'build',
      join(import.meta.dir, '../src/browser/page-kit.ts'),
      '--outdir', outdir, '--target=bun', '--minify',
    ]);
    expect(built.exitCode).toBe(0);
    const { kit } = await import(join(outdir, 'page-kit.js'));
    const page = { window: {}, addEventListener() {}, location: { href: 'https://example.test/docs/a' } };
    expect(await runInNewContext(kit("return K.met({url: 'https://example.test/docs/**'})"), page)).toBe(true);
    // The second command reuses the state that the first command left in this page.
    expect(await runInNewContext(kit('return K.refs.size'), page)).toBe(0);
  } finally {
    await rm(outdir, { recursive: true, force: true });
  }
});
