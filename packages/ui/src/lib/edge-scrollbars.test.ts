import { afterEach, describe, expect, it, vi } from 'vitest';
import { dragScroll, edgeOpacity, FULL_DISTANCE, MIN_THUMB, REVEAL_DISTANCE, startEdgeScrollbars, thumbSpan } from './edge-scrollbars';

describe('edgeOpacity', () => {
  it('is hidden past the reveal distance, full near the edge and rises in between', () => {
    expect(edgeOpacity(REVEAL_DISTANCE)).toBe(0);
    expect(edgeOpacity(400)).toBe(0);
    expect(edgeOpacity(FULL_DISTANCE)).toBe(1);
    expect(edgeOpacity(0)).toBe(1);
    const samples = [120, 100, 80, 60, 40].map((distance) => edgeOpacity(distance));
    for (let i = 1; i < samples.length; i++) expect(samples[i]).toBeGreaterThan(samples[i - 1]!);
    expect(samples[0]).toBeGreaterThan(0);
    expect(samples.at(-1)).toBeLessThan(1);
  });
});

describe('thumbSpan', () => {
  it('sizes the thumb by the share in view and places it by the scroll position', () => {
    expect(thumbSpan(0, 2000, 500, 400)).toEqual({ length: 100, offset: 0 });
    expect(thumbSpan(1500, 2000, 500, 400)).toEqual({ length: 100, offset: 300 });
    expect(thumbSpan(750, 2000, 500, 400)).toEqual({ length: 100, offset: 150 });
  });

  it('keeps a grabbable length on a very long list and stays inside its track', () => {
    const span = thumbSpan(1e6, 1e6, 500, 400)!;
    expect(span.length).toBe(MIN_THUMB);
    expect(span.offset + span.length).toBeLessThanOrEqual(400);
  });

  it('draws nothing when there is nothing to scroll', () => {
    expect(thumbSpan(0, 500, 500, 400)).toBeNull();
  });
});

describe('dragScroll', () => {
  it('moves the content in proportion and stops at both ends', () => {
    // 300 px of track room for 1500 px of scroll: one track pixel is five content pixels.
    expect(dragScroll(0, 60, 2000, 500, 400, 100)).toBe(300);
    expect(dragScroll(0, -60, 2000, 500, 400, 100)).toBe(0);
    expect(dragScroll(1000, 500, 2000, 500, 400, 100)).toBe(1500);
  });
});

describe('startEdgeScrollbars', () => {
  type Query = EventTarget & { media: string; matches: boolean };
  const original = window.matchMedia;
  afterEach(() => { window.matchMedia = original; document.documentElement.className = ''; });

  function media(fine: boolean) {
    const queries = new Map<string, Query>();
    window.matchMedia = vi.fn((text: string) => {
      const query = queries.get(text) ?? Object.assign(new EventTarget(), { media: text, matches: text.includes('pointer: fine') ? fine : false });
      queries.set(text, query);
      return query as unknown as MediaQueryList;
    });
    return (text: string, matches: boolean) => {
      const query = [...queries.values()].find((entry) => entry.media.includes(text))!;
      query.matches = matches;
      query.dispatchEvent(new Event('change'));
    };
  }

  const on = () => document.documentElement.classList.contains('edge-scrollbars') && document.querySelector('.edge-scrollbar-layer') !== null;

  it('follows the pointer and forced colours, and leaves nothing behind when stopped', () => {
    const change = media(true);
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    const stop = startEdgeScrollbars();
    expect(on()).toBe(true);
    change('forced-colors', true);
    expect(on()).toBe(false);
    change('forced-colors', false);
    change('pointer: fine', false);
    expect(on()).toBe(false);
    change('pointer: fine', true);
    expect(on()).toBe(true);
    stop();
    expect(on()).toBe(false);
    expect(document.querySelector('.edge-scrollbar-layer')).toBeNull();
    const count = (calls: unknown[][]) => calls.map(([type, listener]) => `${String(type)}:${String(listener)}`).sort();
    expect(count(removed.mock.calls)).toEqual(count(added.mock.calls));
    // The display changing after stop starts nothing again.
    change('pointer: fine', false);
    change('pointer: fine', true);
    expect(on()).toBe(false);
    added.mockRestore();
    removed.mockRestore();
  });

  it('leaves a touch-only display alone', () => {
    media(false);
    const stop = startEdgeScrollbars();
    expect(on()).toBe(false);
    stop();
  });
});
