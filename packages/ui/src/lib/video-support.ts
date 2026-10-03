/**
 * Whether this device can play a video type, asked before loading it so an
 * iPhone without WebM shows a download at once instead of a black frame.
 * An engine that answers no for MP4 too knows nothing about video (a test DOM)
 * and is not trusted: the player itself then reports a failure.
 */
export function videoPlayable(mime: string, probe: (type: string) => string = defaultProbe): boolean {
  const type = mime.split(';')[0]!.trim().toLowerCase();
  if (!type.startsWith('video/')) return true;
  return probe(type) !== '' || probe('video/mp4') === '';
}

let element: HTMLVideoElement | undefined;
function defaultProbe(type: string): string {
  if (typeof document === 'undefined') return '';
  element ??= document.createElement('video');
  return element.canPlayType(type);
}
