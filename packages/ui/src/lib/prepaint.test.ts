import { expect, test } from 'vitest';
import { prepaintMinify } from '../../prepaint';

const transform = (prepaintMinify().transformIndexHtml as { handler(html: string): string }).handler;
const boot = "var pickedFace = localStorage.getItem('boite.font'); var pickedTheme = localStorage.getItem('boite.theme'); document.documentElement.dataset.theme = pickedTheme;";

test('prepaint recognizes the script closing tags the browser accepts', () => {
  const html = `<html><head><script>${boot}</script\t\n extra></head><body></body></html>`;
  const result = transform(html);
  const before = new DOMParser().parseFromString(html, 'text/html');
  const after = new DOMParser().parseFromString(result, 'text/html');
  expect(after.scripts).toHaveLength(1);
  expect(after.scripts[0]!.textContent!.length).toBeLessThan(before.scripts[0]!.textContent!.length);
  expect(result).toContain('</script\t\n extra>');
});

test('script-looking attribute values are preserved byte for byte', () => {
  const html = `<html><body><div data-example="<script>${boot}</script>"></div></body></html>`;
  expect(transform(html)).toBe(html);
});

test('prepaint leaves module, notice, locale and unfinished scripts untouched', () => {
  const notice = '<script>window.oldBrowserNotice = "<!-- The same rule as lib/theme.ts, stays in code -->";</script>';
  const locale = '<script>window.locale = "fr";</script>';
  const module = `<script type="module">${boot}</script>`;
  const unfinished = `<script>${boot}`;
  const html = `<html><head>${notice}${locale}${module}${unfinished}`;
  expect(transform(html)).toBe(html);
});
