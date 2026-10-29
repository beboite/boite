import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderMarkdown } from './markdown';
import { richMarkdown } from './rich-markdown';
import { selectedSource } from './rich-markdown-draw';

let mounted: { destroy(): void } | null = null;

function show(markdown: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderMarkdown(markdown);
  document.body.append(host);
  mounted = richMarkdown(host);
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
});
