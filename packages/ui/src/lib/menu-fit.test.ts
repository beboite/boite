import { describe, expect, it } from 'vitest';
import { fitMenu, MENU_GAP, MENU_MARGIN } from './menu-fit';

describe('fitMenu', () => {
  it('keeps the full list above a composer at the bottom of a tall window', () => {
    expect(fitMenu({ top: 700, bottom: 780 }, 800, 36, 420)).toEqual({ below: false, maxHeight: 420 });
  });

  it('shortens the list above when the window is short but above still has room', () => {
    // The centred draft on a 1366x768 screen: 300 px above the composer, less below.
    const fit = fitMenu({ top: 340, bottom: 470 }, 768, 36, 420);
    expect(fit.below).toBe(false);
    expect(fit.maxHeight).toBe(340 - 36 - MENU_GAP - MENU_MARGIN);
  });

  it('opens below when above is short and below has more room', () => {
    const fit = fitMenu({ top: 150, bottom: 260 }, 720, 36, 420);
    expect(fit.below).toBe(true);
    expect(fit.maxHeight).toBe(420);
  });

  it('never returns a negative height', () => {
    expect(fitMenu({ top: 10, bottom: 790 }, 800, 36, 420).maxHeight).toBe(0);
  });
});
