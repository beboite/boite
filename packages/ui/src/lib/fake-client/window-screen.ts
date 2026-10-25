import { fakeDeviceScreen } from './device-screen';

let last: { key: string; base64: string } | null = null;

/**
 * A fake desktop window as base64 JPEG: an editor's frame with a scene whose
 * cube turns one step per `tick`, so the Window panel sees the picture change.
 * `hue` tells two apps apart. jsdom has no canvas: it gets the device's still.
 */
export function fakeWindowPicture(width: number, height: number, tick: number, hue = 210): string {
  const key = `${width}x${height}:${tick}:${hue}`;
  if (last?.key === key) return last.base64;
  if (typeof OffscreenCanvas === 'undefined') return fakeDeviceScreen();
  let base64 = fakeDeviceScreen();
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const paint = canvas.getContext('2d');
    if (paint !== null) {
      const u = width / 100, v = height / 100;
      paint.fillStyle = 'hsl(220 10% 16%)';
      paint.fillRect(0, 0, width, height);
      // Title bar and toolbar.
      paint.fillStyle = 'hsl(220 10% 10%)';
      paint.fillRect(0, 0, width, 4 * v);
      paint.fillStyle = 'hsl(220 8% 22%)';
      paint.fillRect(0, 4 * v, width, 5 * v);
      for (let at = 0; at < 3; at++) {
        paint.fillStyle = at === 0 ? `hsl(${hue} 60% 55%)` : 'hsl(220 8% 35%)';
        paint.fillRect(44 * u + at * 4.5 * u, 5 * v, 3.5 * u, 3 * v);
      }
      // Hierarchy and inspector.
      paint.fillStyle = 'hsl(220 9% 19%)';
      paint.fillRect(0, 9 * v, 18 * u, 91 * v);
      paint.fillRect(80 * u, 9 * v, 20 * u, 91 * v);
      paint.fillStyle = 'hsl(220 8% 42%)';
      for (let row = 0; row < 9; row++) paint.fillRect((2 + (row % 3) * 1.5) * u, (12 + row * 4) * v, (10 - (row % 3)) * u, 1.6 * v);
      for (let row = 0; row < 7; row++) paint.fillRect(82 * u, (12 + row * 5) * v, (row % 2 ? 9 : 15) * u, 1.8 * v);
      // The scene: sky, ground and a cube that turns.
      const sky = paint.createLinearGradient(0, 9 * v, 0, 75 * v);
      sky.addColorStop(0, `hsl(${hue} 45% 62%)`);
      sky.addColorStop(1, `hsl(${hue} 35% 82%)`);
      paint.fillStyle = sky;
      paint.fillRect(18 * u, 9 * v, 62 * u, 66 * v);
      paint.fillStyle = 'hsl(110 25% 38%)';
      paint.fillRect(18 * u, 52 * v, 62 * u, 23 * v);
      const angle = (tick % 24) * Math.PI / 12, cx = 49 * u, cy = 46 * v, r = Math.min(u, v) * 11;
      paint.fillStyle = `hsl(${(hue + 160) % 360} 55% 52%)`;
      paint.beginPath();
      for (let corner = 0; corner < 4; corner++) {
        const a = angle + corner * Math.PI / 2;
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * 0.55;
        if (corner === 0) paint.moveTo(x, y); else paint.lineTo(x, y);
      }
      paint.closePath();
      paint.fill();
      paint.fillRect(cx - r * 0.7, cy, r * 1.4, r * 0.9);
      // Console.
      paint.fillStyle = 'hsl(220 10% 13%)';
      paint.fillRect(18 * u, 75 * v, 62 * u, 25 * v);
      paint.fillStyle = 'hsl(220 8% 48%)';
      for (let row = 0; row < 4; row++) paint.fillRect(20 * u, (79 + row * 5) * v, (30 + ((row * 7 + tick) % 20)) * u, 1.4 * v);
      base64 = canvas.toDataURL('image/jpeg', 0.72).replace(/^data:image\/jpeg;base64,/, '');
    }
  } catch {
    /* the still stays */
  }
  last = { key, base64 };
  return base64;
}
