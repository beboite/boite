/** A 9×20 JPEG of the home screen, for jsdom, which has no canvas. */
const FALLBACK = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABQODxIPDRQSEBIXFRQYHjIhHhwcHj0sLiQySUBMS0dARkVQWnNiUFVtVkVGZIhlbXd7gYKBTmCNl4x9lnN+gXz/2wBDARUXFx4aHjshITt8U0ZTfHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHz/wAARCAAUAAkDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDNWCI9UT6ktx09vrR9ni/6Z/r/AIVMsm3+FsdxvIz0/wAKN6/3D/32a60rGDZdWUCPPkxEjjlag3j/AJ5p+VFFHUfQ/9k=';

let drawn: string | null = null;

/**
 * The fake-client emulator's home screen as base64 JPEG, a fifth of a
 * 1080×2400 phone: drawn once in a real browser, a tiny still elsewhere.
 */
export function fakeDeviceScreen(): string {
  if (drawn !== null) return drawn;
  drawn = FALLBACK;
  // jsdom has no canvas and says so loudly on every call; see fakePng in files.ts.
  if (typeof OffscreenCanvas === 'undefined') return drawn;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 216;
    canvas.height = 480;
    const paint = canvas.getContext('2d');
    if (paint === null) return drawn;
    const sky = paint.createLinearGradient(0, 0, 0, 480);
    sky.addColorStop(0, 'hsl(222 57% 18%)');
    sky.addColorStop(1, 'hsl(214 45% 42%)');
    paint.fillStyle = sky;
    paint.fillRect(0, 0, 216, 480);
    paint.fillStyle = 'hsl(225 50% 12%)';
    paint.fillRect(0, 0, 216, 16);
    const hues = [5, 140, 40, 212, 270, 180, 335, 230];
    const icon = (x: number, y: number, hue: number) => {
      paint.fillStyle = hue === 230 ? 'hsl(230 12% 82%)' : `hsl(${hue} 70% 62%)`;
      paint.beginPath();
      paint.roundRect(x - 15, y - 15, 30, 30, 7);
      paint.fill();
    };
    for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) icon(30 + col * 52, 70 + row * 64, hues[(row * 4 + col) % hues.length]!);
    paint.fillStyle = 'hsl(220 30% 85%)';
    paint.beginPath();
    paint.roundRect(14, 410, 188, 46, 12);
    paint.fill();
    for (let col = 0; col < 4; col++) icon(38 + col * 47, 433, hues[(col + 3) % hues.length]!);
    paint.fillStyle = 'hsl(240 15% 93%)';
    paint.fillRect(78, 466, 60, 4);
    drawn = canvas.toDataURL('image/jpeg', 0.7).replace(/^data:image\/jpeg;base64,/, '');
  } catch {
    /* the still stays */
  }
  return drawn;
}