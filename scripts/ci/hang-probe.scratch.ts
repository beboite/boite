// Scratch for the PR proof, reverted before merge: a test that opens a page and never ends.
import { describe, test } from 'bun:test';
import { BrowserPage } from '../../tests/e2e/lib/cdp.ts';

describe('hang probe', () => {
  test('passes first', () => {});
  test('opens a page and waits forever', async () => {
    const page = await BrowserPage.launch({ url: 'about:blank' });
    void page.evaluate('new Promise(() => {})', 600_000).catch(() => undefined);
    await new Promise(() => {});
  }, 600_000);
});
