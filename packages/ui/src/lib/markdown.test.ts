import { describe, expect, test } from 'vitest';
import { renderBlock, renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  test('inline code keeps emphasis and links literal', () => {
    expect(renderMarkdown('`**literal**` and **bold**')).toBe('<p><code>**literal**</code> and <strong>bold</strong></p>');
    expect(renderMarkdown('`[x](https://example.test)`')).toBe('<p><code>[x](https://example.test)</code></p>');
    expect(renderMarkdown('``a ` b`` and `<tag>`')).toBe('<p><code>a ` b</code> and <code>&lt;tag&gt;</code></p>');
    expect(renderMarkdown('**`code`** and `[x](https://example.test)`')).toBe('<p><strong><code>code</code></strong> and <code>[x](https://example.test)</code></p>');
    expect(renderMarkdown('\0 `**code**`')).toBe('<p>\0 <code>**code**</code></p>');
  });
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

test('a kept block is the same markup, kept apart for plain and rich rendering', () => {
  const block = 'See `packages/ui/src/app.css` and [the notes](docs/performance.md) for **why**.';
  const plain = renderMarkdown(block, false);
  const rich = renderMarkdown(block, true);
  expect(rich).not.toBe(plain);
  // Asked in both orders and again: each flag gets its own rendering back from the cache.
  expect(renderBlock(block, true)).toBe(rich);
  expect(renderBlock(block, false)).toBe(plain);
  expect(renderBlock(block, true)).toBe(rich);
  expect(renderBlock(block, false)).toBe(plain);
});

test('links are found in linear time: a line of 32,000 brackets renders at once', () => {
  // Retrying a link regex from every `[` read to the end of the line each time: seconds per render.
  const lines = ['['.repeat(32_000), '[a'.repeat(16_000), '[a](<'.repeat(6_000), '[a](http://'.repeat(3_000)];
  const started = performance.now();
  for (const line of lines) for (const rich of [false, true]) renderMarkdown(line, rich);
  expect(performance.now() - started).toBeLessThan(500);
  expect(renderMarkdown('['.repeat(32_000))).toBe(`<p>${'['.repeat(32_000)}</p>`);
  // The leftmost `[` still opens the label, and an image's `!` stays with its link.
  expect(renderMarkdown(`${'['.repeat(100)}docs](https://a.b/c)`)).toBe(`<p><a href="https://a.b/c" target="_blank" rel="noopener noreferrer">${'['.repeat(99)}docs</a></p>`);
  expect(renderMarkdown('see ![a](<https://a.b/c d>) and [(x)](y(z)) now', true)).toBe('<p>see <a href="https://a.b/c%20d" target="_blank" rel="noopener noreferrer">a</a> and <a href="#file" data-file-path="y(z)">(x)</a> now</p>');
});

test('a thread address links to the thread, not to a file', () => {
  const thread = (address: string) => `<a href="#thread" data-thread-address="${address}">${address}</a>`;
  // `machine/thr_x` reads as a relative path, and its `/thr_x` as an absolute one.
  expect(renderMarkdown('ask boite/thr_tkw9n9qt4100rvq2jmg1 or `thr_tkw9n9qt4100rvq2jmg1`.', true))
    .toBe(`<p>ask ${thread('boite/thr_tkw9n9qt4100rvq2jmg1')} or <code>${thread('thr_tkw9n9qt4100rvq2jmg1')}</code>.</p>`);
  // Opening a thread reads no file, so a code span links it without rich links.
  expect(renderMarkdown('`boite/thr_tkw9n9qt4100rvq2jmg1`')).toBe(`<p><code>${thread('boite/thr_tkw9n9qt4100rvq2jmg1')}</code></p>`);
  expect(renderMarkdown('src/thr_tkw9n9qt4100rvq2jmg1.ts', true)).toBe('<p><a href="#file" data-file-path="src/thr_tkw9n9qt4100rvq2jmg1.ts">src/thr_tkw9n9qt4100rvq2jmg1.ts</a></p>');
  // A path that goes on around the id is no thread; a link whose destination is one is.
  for (const path of ['thr_tkw9n9qt4100rvq2jmg1.ts', 'src\\thr_tkw9n9qt4100rvq2jmg1', 'thr_tkw9n9qt4100rvq2jmg1-old']) {
    expect(renderMarkdown(path, true)).not.toContain('data-thread-address');
  }
  expect(renderMarkdown('[open it](boite/thr_tkw9n9qt4100rvq2jmg1)', true))
    .toBe('<p><a href="#thread" data-thread-address="boite/thr_tkw9n9qt4100rvq2jmg1">open it</a></p>');
});

describe('diagrams and formulas', () => {
  test('a single dollar is a price or a variable, never math', () => {
    for (const text of ['between 5 $ and 10 $', 'costs $5 to $10', 'echo $PATH and $HOME', 'a $x$ b']) {
      expect(renderMarkdown(text)).not.toContain('md-math');
    }
  });

  test('formulas: inline, display on one line, display on lines of their own, and a math block', () => {
    expect(renderMarkdown('mass \\(E = mc^2\\) here')).toBe(
      '<p>mass <span class="md-math" data-tex="E = mc^2" data-source="\\(E = mc^2\\)">\\(E = mc^2\\)</span> here</p>'
    );
    expect(renderMarkdown('so $$a*b*c$$ and \\[x\\]')).toBe(
      '<p>so <span class="md-math" data-display data-tex="a*b*c" data-source="$$a*b*c$$">$$a*b*c$$</span> and <span class="md-math" data-display data-tex="x" data-source="\\[x\\]">\\[x\\]</span></p>'
    );
    expect(renderMarkdown('Text\n$$\n\\frac{a}{b} < 1\n$$\nafter')).toBe(
      '<p>Text</p><div class="md-math" data-display data-tex="\\frac{a}{b} &lt; 1" data-source="$$\n\\frac{a}{b} &lt; 1\n$$">$$\n\\frac{a}{b} &lt; 1\n$$</div><p>after</p>'
    );
    expect(renderMarkdown('\\[\n x^2 \n\\]')).toContain('<div class="md-math" data-display data-tex="x^2"');
    expect(renderMarkdown('```math\n\\sum_i i\n```')).toBe(
      '<div class="md-math" data-display data-tex="\\sum_i i" data-source="```math\n\\sum_i i\n```">```math\n\\sum_i i\n```</div>'
    );
  });

  test('math in code stays code', () => {
    expect(renderMarkdown('`$$x$$` and `\\(y\\)`')).toBe('<p><code>$$x$$</code> and <code>\\(y\\)</code></p>');
    expect(renderMarkdown('```\n$$x$$\n```')).toBe('<pre><code>$$x$$</code></pre>');
    expect(renderMarkdown('```tex\n\\[x\\]\n```')).not.toContain('md-math');
  });

  test('a formula with no closing mark stays text', () => {
    expect(renderMarkdown('$$\nx^2 +')).toBe('<p>$$\nx^2 +</p>');
    expect(renderMarkdown('open \\( and never closed')).not.toContain('md-math');
    expect(renderMarkdown('```math\nx^2')).toBe('<pre data-language="math"><code>x^2</code></pre>');
  });

  test('a closed mermaid block is marked with its source; one still being written stays code', () => {
    expect(renderMarkdown('```mermaid\nflowchart LR\n  A["<b>x</b>"] --> B\n```')).toBe(
      '<div class="md-mermaid" data-source="flowchart LR\n  A[&quot;&lt;b&gt;x&lt;/b&gt;&quot;] --&gt; B"><pre data-language="mermaid"><code>flowchart LR\n  A[&quot;&lt;b&gt;x&lt;/b&gt;&quot;] --&gt; B</code></pre></div>'
    );
    expect(renderMarkdown('```mermaid\nflowchart LR\n  A --> B')).toBe('<pre data-language="mermaid"><code>flowchart LR\n  A --&gt; B</code></pre>');
    expect(renderMarkdown('```mermaid\n```')).toBe('<pre data-language="mermaid"><code></code></pre>');
  });

  test('a closed view block is marked with its HTML; one still being written and an html block stay code', () => {
    expect(renderMarkdown('```view\n<p class="a">Hi</p>\n```')).toBe(
      '<div class="md-view" data-source="&lt;p class=&quot;a&quot;&gt;Hi&lt;/p&gt;"><pre data-language="view"><code>&lt;p class=&quot;a&quot;&gt;Hi&lt;/p&gt;</code></pre></div>'
    );
    expect(renderMarkdown('```view\n<p>Hi')).toBe('<pre data-language="view"><code>&lt;p&gt;Hi</code></pre>');
    expect(renderMarkdown('```html\n<p>Hi</p>\n```')).toBe('<pre data-language="html"><code>&lt;p&gt;Hi&lt;/p&gt;</code></pre>');
  });
});
