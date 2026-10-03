import type { BrowserPage } from './cdp';

/** Measure the cap-height centre, rather than the font's invisible ascent/descent box. */
export async function labelOffsets(page: BrowserPage, pairs: [string, string][]) {
  return page.evaluate<{ label: string; offset: number; inkOffset: number; inkFits: boolean }[]>(`(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    return ${JSON.stringify(pairs)}.map(([control, label]) => {
      const parent = document.querySelector(control), el = document.querySelector(label);
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) if (node.textContent.trim()) break;
      const range = document.createRange(); range.selectNodeContents(node || el);
      const text = range.getBoundingClientRect(), box = parent.getBoundingClientRect(), style = getComputedStyle(node.parentElement);
      ctx.font = style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
      const cap = ctx.measureText('H'), ink = ctx.measureText('Égj'), labelInk = ctx.measureText(node.textContent.trim()), inkBox = node.parentElement.getBoundingClientRect();
      const baseline = text.top + (text.height - cap.fontBoundingBoxAscent - cap.fontBoundingBoxDescent) / 2 + cap.fontBoundingBoxAscent;
      return {
        label, offset: baseline - cap.actualBoundingBoxAscent / 2 - box.top - box.height / 2,
        inkOffset: baseline + (labelInk.actualBoundingBoxDescent - labelInk.actualBoundingBoxAscent) / 2 - box.top - box.height / 2,
        inkFits: baseline - ink.actualBoundingBoxAscent >= inkBox.top - 0.1 && baseline + ink.actualBoundingBoxDescent <= inkBox.bottom + 0.1,
      };
    });
  })()`);
}
