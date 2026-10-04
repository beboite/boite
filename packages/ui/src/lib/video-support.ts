/**
 * Whether this device can play a video type, asked before loading it so an
 * iPhone without WebM shows a download at once instead of a black frame.
 * Only WebM and Ogg are judged here: Chrome answers no for QuickTime and
 * Matroska yet plays H.264 in them, so every other type goes to the player and
 * its error handler. An engine that answers no for MP4 too knows nothing about
 * video (a test DOM) and is not trusted either. An MP4 that names HEVC or AV1
 * is judged too: desktops play HEVC only with a decoder, iPhones AV1 only with
 * one in hardware (15 Pro on).
 */
export function videoPlayable(mime: string, probe: (type: string) => string = defaultProbe): boolean {
  const type = mime.split(';')[0]!.trim().toLowerCase();
  const codec = /;\s*codecs\s*=\s*"?([^";,]+)/i.exec(mime)?.[1]?.trim();
  if (type === 'video/mp4' && codec && /^(hvc1|hev1|av01)\./i.test(codec)) return probe(`video/mp4; codecs="${codec}"`) !== '' || probe('video/mp4') === '';
  if (type !== 'video/webm' && type !== 'video/ogg') return true;
  return probe(type) !== '' || probe('video/mp4') === '';
}

let element: HTMLVideoElement | undefined;
function defaultProbe(type: string): string {
  if (typeof document === 'undefined') return '';
  element ??= document.createElement('video');
  return element.canPlayType(type);
}
