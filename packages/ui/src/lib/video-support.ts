/**
 * Whether this device can play a video type, asked before loading it so an
 * iPhone without WebM shows a download at once instead of a black frame.
 * Only WebM and Ogg are judged here: Chrome answers no for QuickTime and
 * Matroska yet plays H.264 in them, so every other type goes to the player and
 * its error handler. An engine that answers no for MP4 too knows nothing about
 * video (a test DOM) and is not trusted either.
 */
export function videoPlayable(mime: string, probe: (type: string) => string = defaultProbe): boolean {
  const type = mime.split(';')[0]!.trim().toLowerCase();
  if (type !== 'video/webm' && type !== 'video/ogg') return true;
  return probe(type) !== '' || probe('video/mp4') === '';
}

let element: HTMLVideoElement | undefined;
function defaultProbe(type: string): string {
  if (typeof document === 'undefined') return '';
  element ??= document.createElement('video');
  return element.canPlayType(type);
}
