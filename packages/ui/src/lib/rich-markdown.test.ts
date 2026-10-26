import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderMarkdown } from './markdown';
import { richMarkdown, type RichMarkdownOptions } from './rich-markdown';
import { selectedSource } from './rich-markdown-draw';

let mounted: { destroy(): void } | null = null;

function show(markdown: string, options?: RichMarkdownOptions): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderMarkdown(markdown);
  document.body.append(host);
  mounted = richMarkdown(host, options);
  return host;
}

afterEach(() => {
  mounted?.destroy();
  mounted = null;
  document.body.replaceChildren();
});

describe('richMarkdown', () => {
  test('a diagram with a trapped label is drawn with nothing that runs or loads', async () => {
    const host = show([
      '```mermaid',
      'flowchart LR',
      '  A["<img src=x onerror=alert(1)><script>alert(2)</script>"] --> B["javascript:alert(3)"]',
      '  click A "javascript:alert(4)"',
      '```'
    ].join('\n'));
    const figure = await vi.waitFor(() => {
      const found = host.querySelector('[data-testid="diagram"]');
      if (!found) throw new Error(host.querySelector('[data-testid="diagram-error"]')?.textContent ?? 'not drawn yet');
      return found;
    }, { timeout: 10_000 });
    expect(figure.querySelector('svg')).not.toBeNull();
    expect(figure.querySelector('script, img, image, foreignObject, a')).toBeNull();
    for (const element of figure.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        expect(attribute.name.startsWith('on'), `${element.localName} ${attribute.name}`).toBe(false);
        expect(attribute.value).not.toMatch(/javascript:/i);
      }
    }
    // Markup in a label is dropped to its text; an address is only words.
    expect(figure.textContent).toBe('alert(2)javascript:alert(3)');
  });

  test('a diagram that does not parse keeps its code and says why in one line', async () => {
    const host = show('```mermaid\nflowchart LR\n  A --> \n```');
    const error = await vi.waitFor(() => {
      const found = host.querySelector('[data-testid="diagram-error"]');
      if (!found) throw new Error('not drawn yet');
      return found;
    });
    expect(error.textContent).toBe("This diagram could not be drawn: Parse error on line 3: Expecting 'NODE_STRING', got 'EOF'");
    expect(host.querySelector('.md-mermaid pre code')?.textContent).toBe('flowchart LR\n  A --> ');
    expect(host.querySelector('[data-testid="diagram"]')).toBeNull();
  });

  test('a formula is drawn, and one Temml cannot read keeps its source', async () => {
    const host = show('Energy \\(E = mc^2\\) and \\(\\frac{a}{\\)');
    const [good, bad] = [...host.querySelectorAll<HTMLElement>('.md-math')];
    await vi.waitFor(() => {
      if (!good!.classList.contains('md-drawn') || !bad!.classList.contains('md-math-failed')) throw new Error('not drawn yet');
    });
    expect(good!.querySelector('math msup')).not.toBeNull();
    expect(bad!.textContent).toBe('\\(\\frac{a}{\\)');
    expect(bad!.title).toMatch(/^This formula could not be read: Unexpected end of input/);
  });

  test('copying a selection gives the formula and the diagram back as written', async () => {
    const host = show('Energy \\(E = mc^2\\) here.\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nEnd.');
    await vi.waitFor(() => {
      if (host.querySelectorAll('.md-drawn').length < 2) throw new Error('not drawn yet');
    });
    const range = document.createRange();
    range.selectNodeContents(host);
    expect(selectedSource(range)).toBe('Energy \\(E = mc^2\\) here.\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nEnd.');

    // A selection that starts inside a drawn formula takes the whole formula.
    const inside = document.createRange();
    inside.setStart(host.querySelector('math')!, 0);
    inside.setEndAfter(host.querySelector('p')!.lastChild!);
    expect(selectedSource(inside)).toBe('\\(E = mc^2\\) here.');
  });

  test('the copy button copies a diagram on a page without the clipboard API', async () => {
    const host = show('```mermaid\nflowchart LR\n  A --> B\n```');
    const copy = await vi.waitFor(() => {
      const found = host.querySelector<HTMLButtonElement>('[data-testid="diagram-copy"]');
      if (!found) throw new Error('not drawn yet');
      return found;
    });
    // Plain HTTP: no navigator.clipboard, only the copy command, which copies the selection.
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    let selected = '';
    let readOnly = false;
    document.execCommand = vi.fn(() => {
      const field = document.activeElement as HTMLTextAreaElement;
      readOnly = field.readOnly;
      selected = field.value.slice(field.selectionStart, field.selectionEnd);
      return true;
    });
    try {
      copy.focus();
      copy.click();
      expect(selected).toBe('flowchart LR\n  A --> B');
      // Read-only: a phone opens no keyboard for it.
      expect(readOnly).toBe(true);
      expect(copy.textContent).toBe('Copied');
      // The field goes, and focus comes back to the button.
      expect(document.querySelector('.md-copy-field')).toBeNull();
      expect(document.activeElement).toBe(copy);
    } finally {
      vi.unstubAllGlobals();
      Reflect.deleteProperty(document, 'execCommand');
    }
  });

  test('a view block opens its page from the machine and shows it only once the page is up', async () => {
    const asked: string[] = [];
    const host = show('```view\n<p>Hi</p>\n```', { viewBlock: async (html) => { asked.push(html); return { ok: true, value: 'about:blank' }; } });
    const block = host.querySelector<HTMLElement>('.md-view')!;
    const frame = await vi.waitFor(() => {
      const found = block.querySelector<HTMLIFrameElement>('[data-testid="view-block-frame"]');
      if (!found) throw new Error('not mounted yet');
      return found;
    });
    expect(asked).toEqual(['<p>Hi</p>']);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('src')).toMatch(/^about:blank#boite-view=/);
    // Loading under the placeholder: neither drawn nor its source.
    expect(block.matches('.md-drawn, .md-source')).toBe(false);
    const post = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data, source: frame.contentWindow }));
    post({ boiteView: 1, type: 'size', height: 180 });
    post({ boiteView: 1, type: 'ready' });
    expect(frame.style.height).toBe('180px');
    expect(block.classList.contains('md-drawn')).toBe(true);
    expect(block.dataset.view).toBe('diagram');
    const toggle = block.querySelector<HTMLButtonElement>('[data-testid="diagram-toggle"]')!;
    toggle.click();
    expect(block.dataset.view).toBe('code');
    expect(toggle.textContent).toBe('View');
    // Hidden behind its code the page has no width: what it measures then is not kept.
    post({ boiteView: 1, type: 'size', height: 900 });
    expect(frame.style.height).toBe('180px');
  });

  test('a view block whose page cannot show keeps its code and says why', async () => {
    const refused = show('```view\n<p>A</p>\n```', { viewBlock: async () => ({ ok: false, error: 'the machine is offline' }) });
    await vi.waitFor(() => { if (!refused.querySelector('[data-testid="diagram-error"]')) throw new Error('not shown yet'); });
    expect(refused.querySelector('[data-testid="diagram-error"]')?.textContent).toBe('This view could not be shown: the machine is offline');
    expect(refused.querySelector('.md-view')?.classList.contains('md-source')).toBe(true);
    expect(refused.querySelector('.md-view pre code')?.textContent).toBe('<p>A</p>');
    mounted?.destroy();
    document.body.replaceChildren();

    // A page that loads a second time has left its own address: it is closed, even after it showed.
    const host = show('```view\n<p>B</p>\n```', { viewBlock: async () => ({ ok: true, value: 'about:blank' }) });
    const frame = await vi.waitFor(() => {
      const found = host.querySelector<HTMLIFrameElement>('[data-testid="view-block-frame"]');
      if (!found) throw new Error('not mounted yet');
      return found;
    });
    window.dispatchEvent(new MessageEvent('message', { data: { boiteView: 1, type: 'ready' }, source: frame.contentWindow }));
    frame.dispatchEvent(new Event('load'));
    frame.dispatchEvent(new Event('load'));
    expect(host.querySelector('[data-testid="view-block-frame"]')).toBeNull();
    expect(host.querySelector('[data-testid="diagram-toggle"]')).toBeNull();
    expect(host.querySelector('[data-testid="diagram-error"]')?.textContent).toBe('This view could not be shown: it left its own page');
    mounted?.destroy();
    document.body.replaceChildren();

    // Where no machine serves it, as in a file preview, it stays code.
    const plain = show('```view\n<p>C</p>\n```');
    await vi.waitFor(() => { if (!plain.querySelector('[data-testid="diagram-error"]')) throw new Error('not shown yet'); });
    expect(plain.querySelector('[data-testid="diagram-error"]')?.textContent).toBe('The view could not be shown here.');
    expect(plain.querySelector('[data-testid="diagram-copy"]')).not.toBeNull();
  });

  test('copying across a view gives back its fenced HTML', async () => {
    const host = show('Look.\n\n```view\n<p>Hi</p>\n```', { viewBlock: async () => ({ ok: true, value: 'about:blank' }) });
    const frame = await vi.waitFor(() => {
      const found = host.querySelector<HTMLIFrameElement>('[data-testid="view-block-frame"]');
      if (!found) throw new Error('not mounted yet');
      return found;
    });
    window.dispatchEvent(new MessageEvent('message', { data: { boiteView: 1, type: 'ready' }, source: frame.contentWindow }));
    const range = document.createRange();
    range.selectNodeContents(host);
    expect(selectedSource(range)).toBe('Look.\n\n```view\n<p>Hi</p>\n```');
  });
});