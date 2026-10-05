/** A 9×20 JPEG still, for jsdom, which has no canvas. */
const FALLBACK = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABQODxIPDRQSEBIXFRQYHjIhHhwcHj0sLiQySUBMS0dARkVQWnNiUFVtVkVGZIhlbXd7gYKBTmCNl4x9lnN+gXz/2wBDARUXFx4aHjshITt8U0ZTfHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHz/wAARCAAUAAkDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDNWCI9UT6ktx09vrR9ni/6Z/r/AIVMsm3+FsdxvIz0/wAKN6/3D/32a60rGDZdWUCPPkxEjjlag3j/AJ5p+VFFHUfQ/9k=';

/** What the fake agent page shows: enough for a viewer to see its taps and text land. */
export interface FakePage { url: string; title: string; width: number; height: number; taps: number; text: string; scrollY: number }

const drawn = new Map<string, string>();

/**
 * One frame of the fake agent browser as base64 JPEG: a plain page drawn in a
 * real browser, with its address, the taps counted and the text typed so far.
 * A tiny still elsewhere. Drawn at most once per page state.
 */
export function fakeBrowserScreen(page: FakePage): string {
  if (typeof OffscreenCanvas === 'undefined') return FALLBACK;
  const key = JSON.stringify(page);
  const cached = drawn.get(key);
  if (cached) return cached;
  let frame = FALLBACK;
  try {
    // Half size: a frame is a viewer's preview, never the page's own pixels.
    const scale = 0.5, width = Math.round(page.width * scale), height = Math.round(page.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const paint = canvas.getContext('2d');
    if (paint === null) return FALLBACK;
    paint.fillStyle = 'hsl(40 33% 94%)';
    paint.fillRect(0, 0, width, height);
    const top = 24 - (page.scrollY * scale) % 48;
    paint.fillStyle = 'hsl(163 46% 16%)';
    paint.font = `600 ${Math.max(14, Math.round(width / 26))}px system-ui, sans-serif`;
    paint.fillText(page.title.slice(0, 60), 20, top + 28);
    paint.font = `${Math.max(11, Math.round(width / 48))}px system-ui, sans-serif`;
    paint.fillStyle = 'hsl(163 20% 35%)';
    paint.fillText(page.url.slice(0, 90), 20, top + 52);
    paint.fillStyle = 'hsl(163 46% 26%)';
    paint.beginPath();
    paint.roundRect(20, top + 72, Math.min(220, width - 40), 40, 8);
    paint.fill();
    paint.fillStyle = 'hsl(40 33% 96%)';
    paint.fillText(`Taps: ${page.taps}`, 34, top + 98);
    paint.strokeStyle = 'hsl(163 20% 60%)';
    paint.strokeRect(20, top + 128, width - 40, 36);
    paint.fillStyle = 'hsl(163 46% 16%)';
    paint.fillText(page.text.slice(-60) || ' ', 30, top + 152);
    paint.fillStyle = 'hsl(40 20% 84%)';
    for (let line = 0; line < 12; line++) paint.fillRect(20, top + 186 + line * 22, (width - 40) * (0.55 + ((line * 37) % 40) / 100), 10);
    frame = canvas.toDataURL('image/jpeg', 0.7).replace(/^data:image\/jpeg;base64,/, '');
  } catch {
    /* the still stays */
  }
  if (drawn.size > 64) drawn.clear();
  drawn.set(key, frame);
  return frame;
}
