import { describe, expect, test } from 'vitest';
import { sanitizeMarkup } from './sanitize-markup';

function clean(markup: string, idPrefix = ''): string {
  const box = document.createElement('div');
  box.append(sanitizeMarkup(markup, idPrefix));
  return box.innerHTML;
}

describe('sanitizeMarkup', () => {
  test('drops scripts, foreign content, handlers and script URLs', () => {
    const out = clean(
      '<svg onload="alert(1)"><script>alert(2)</script><foreignObject><img src=x onerror="alert(3)"></foreignObject>'
      + '<a href="javascript:alert(4)"><text onclick="alert(5)">label</text></a><use href="https://evil.test/x.svg#a"/></svg>'
    );
    expect(out).toBe('<svg><text>label</text><use></use></svg>');
  });

  test('keeps references and styles inside the diagram, drops the rest', () => {
    const out = clean(
      '<svg id="d-1-root"><defs><marker id="d-1-arrow"></marker><marker id="other"></marker></defs>'
      + '<path marker-end="url(#d-1-arrow)" style="stroke: var(--pele-line)"></path>'
      + '<path style="background: url(https://evil.test/beacon)"></path><path fill="url(#elsewhere)"></path></svg>',
      'd-1-'
    );
    expect(out).toBe(
      '<svg id="d-1-root"><defs><marker id="d-1-arrow"></marker><marker></marker></defs>'
      + '<path marker-end="url(#d-1-arrow)" style="stroke: var(--pele-line)"></path><path></path><path></path></svg>'
    );
  });

  test('unwraps a link, keeps MathML and its annotation as text', () => {
    expect(clean('<math><a href="https://x.test"><mi>x</mi></a></math>')).toBe('<math><mi>x</mi></math>');
    expect(clean('<math><semantics><mi>x</mi><annotation encoding="application/x-tex">x</annotation></semantics></math>'))
      .toBe('<math><semantics><mi>x</mi><annotation encoding="application/x-tex">x</annotation></semantics></math>');
  });
});
