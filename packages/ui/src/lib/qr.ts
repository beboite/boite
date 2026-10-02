import { create, toString as render } from 'qrcode';

/**
 * A pairing link as an inline SVG: black modules on white, no margin of its
 * own (the card pads it), sized by the CSS around it. Black on white on
 * purpose, a phone camera reads that in either theme.
 */
export async function qrSvg(text: string): Promise<string> {
  const svg = await render(text, {
    type: 'svg',
    margin: 0,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#ffffff' }
  });
  return svg.replace(/ width="\d+" height="\d+"/, '').trim();
}

/** The same code as rows of modules, dark being true: what a test draws to show a camera. */
export function qrMatrix(text: string): boolean[][] {
  const { modules } = create(text, { errorCorrectionLevel: 'M' });
  return Array.from({ length: modules.size }, (_, row) => Array.from({ length: modules.size }, (_, column) => modules.get(row, column) === 1));
}
