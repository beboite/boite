/**
 * A phone-width window until the returned function puts the window back: only
 * the layout query, `(max-width: 720px)`, answers yes.
 */
export function phoneWidth(): () => void {
  const original = window.matchMedia;
  window.matchMedia = ((media: string) => Object.assign(new EventTarget(), {
    media, matches: media.includes('max-width: 720px'), onchange: null, addListener() {}, removeListener() {}
  })) as unknown as typeof window.matchMedia;
  return () => { window.matchMedia = original; };
}
