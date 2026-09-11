import { describe, expect, it } from 'vitest';
import { qrSvg } from './qr';

describe('qrSvg', () => {
  it('draws a pairing link as an inline svg with a viewBox and no fixed size', async () => {
    const svg = await qrSvg('http://192.168.1.10:7331/?grant=abcdef0123456789');
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toMatch(/viewBox="0 0 \d+ \d+"/);
    expect(svg).not.toMatch(/ width="/);
    expect(svg).toContain('stroke="#000000"');
    expect(svg).toContain('fill="#ffffff"');
    expect(svg.endsWith('</svg>')).toBe(true);
  });

  it('changes with the link', async () => {
    const a = await qrSvg('http://10.0.0.2:7331/?grant=one');
    const b = await qrSvg('http://10.0.0.2:7331/?grant=two');
    expect(a).not.toBe(b);
  });
});
