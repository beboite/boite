import { describe, expect, test } from 'vitest';
import { renderMarkdown, withCaret } from './markdown';

describe('renderMarkdown', () => {
  test('paragraphs, headings, inline marks and links, everything escaped', () => {
    expect(renderMarkdown('one\ntwo\n\nthree')).toBe('<p>one\ntwo</p><p>three</p>');
    expect(renderMarkdown('# Title\n## Sub')).toBe('<h3>Title</h3><h4>Sub</h4>');
    expect(renderMarkdown('**bold** *it* `co` ~~gone~~ [x](https://a.b/c)')).toBe(
      '<p><strong>bold</strong> <em>it</em> <code>co</code> <del>gone</del> <a href="https://a.b/c" target="_blank" rel="noopener noreferrer">x</a></p>'
    );
    expect(renderMarkdown('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  test('a fenced block keeps its language and its text verbatim', () => {
    expect(renderMarkdown('```ts\nconst a = "<b>";\n```')).toBe(
      '<pre data-language="ts"><code>const a = &quot;&lt;b&gt;&quot;;</code></pre>'
    );
  });

  test('lists nest by indentation, switch kind, and carry task boxes', () => {
    expect(renderMarkdown('- a\n  - a1\n  - a2\n- b\n1. one\n2. two')).toBe(
      '<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul><ol><li>one</li><li>two</li></ol>'
    );
    expect(renderMarkdown('- [ ] todo\n- [x] done')).toBe(
      '<ul><li class="task"><input type="checkbox" disabled> todo</li><li class="task"><input type="checkbox" disabled checked> done</li></ul>'
    );
    // Indented text under an item is that item's, not a new paragraph.
    expect(renderMarkdown('- first line\n  and its rest\n- next')).toBe('<ul><li>first line and its rest</li><li>next</li></ul>');
  });

  test('a block quote holds markdown of its own, and a rule is a rule', () => {
    expect(renderMarkdown('> quoted **bold**\n> second line\n\nafter')).toBe(
      '<blockquote><p>quoted <strong>bold</strong>\nsecond line</p></blockquote><p>after</p>'
    );
    expect(renderMarkdown('above\n\n---\n\nbelow')).toBe('<p>above</p><hr><p>below</p>');
    // Three dashes right under a paragraph are a rule too, never a list.
    expect(renderMarkdown('***')).toBe('<hr>');
  });

  test('a pipe table takes a header, alignments and rows, with escaped pipes kept', () => {
    const source = ['| Name | Count | Note |', '|:-----|------:|:----:|', '| a | 1 | x |', '| b \\| c | 22 |'].join('\n');
    expect(renderMarkdown(source)).toBe(
      '<table><thead><tr><th style="text-align:left">Name</th><th style="text-align:right">Count</th><th style="text-align:center">Note</th></tr></thead>' +
        '<tbody><tr><td style="text-align:left">a</td><td style="text-align:right">1</td><td style="text-align:center">x</td></tr>' +
        '<tr><td style="text-align:left">b | c</td><td style="text-align:right">22</td><td style="text-align:center"></td></tr></tbody></table>'
    );
    // Outer pipes optional; a line with a pipe and no delimiter under it is prose.
    expect(renderMarkdown('a | b\n--|--\n1 | 2')).toBe(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
    );
    expect(renderMarkdown('either | or')).toBe('<p>either | or</p>');
  });
});

describe('withCaret', () => {
  test('lands inside the last block whatever it is', () => {
    expect(withCaret('', 'C')).toBe('<p>C</p>');
    expect(withCaret('<p>a</p>', 'C')).toBe('<p>aC</p>');
    expect(withCaret('<ul><li>a</li></ul>', 'C')).toBe('<ul><li>aC</li></ul>');
    expect(withCaret('<pre><code>a</code></pre>', 'C')).toBe('<pre><code>aC</code></pre>');
    expect(withCaret('<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>', 'C')).toBe(
      '<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1C</td></tr></tbody></table>'
    );
    expect(withCaret('<blockquote><p>q</p></blockquote>', 'C')).toBe('<blockquote><p>qC</p></blockquote>');
    expect(withCaret('<p>a</p><hr>', 'C')).toBe('<p>a</p><hr><p>C</p>');
  });
});
