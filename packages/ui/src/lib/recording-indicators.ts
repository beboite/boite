import { browserBridge } from './browser-bridge';
import { isExperimentEnabled } from './experiments';

interface Mark { x?: number; y?: number; key?: string; at: number }
interface InputFrame { width: number; height: number; marks: Mark[] }
export interface RecordingRect { x: number; y: number; width: number; height: number }

/** The page collector retains coordinates and navigation keys only, never typed text. */
export class RecordingIndicators {
  private key = `__boiteInput_${crypto.randomUUID().replaceAll('-', '')}`;
  private stopped = false;
  constructor(private id: string) {}
  private async evaluate(expression: string): Promise<unknown> {
    const result = await browserBridge.protocol!(this.id, 'Runtime.evaluate', { expression, returnByValue: true }) as { result?: { value?: unknown } };
    return result.result?.value;
  }
  async draw(ctx: CanvasRenderingContext2D, rect: RecordingRect): Promise<void> {
    if (this.stopped || !isExperimentEnabled('recording-indicators')) return;
    const frame = await this.evaluate(`(() => {
      const key = ${JSON.stringify(this.key)};
      if (!globalThis[key]) {
        const marks = [];
        const add = mark => { marks.push({ ...mark, at: Date.now() }); if (marks.length > 12) marks.shift(); };
        const pointer = e => add({ x: e.clientX, y: e.clientY });
        const keydown = e => {
          const path = e.composedPath();
          if (path.some(el => el?.tagName === 'IFRAME' || el?.type === 'password' || /password|cc-/.test(el?.autocomplete ?? ''))) return;
          const names = { Enter: 'Enter', Tab: 'Tab', Escape: 'Esc', Backspace: '⌫', Delete: 'Del', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn' };
          if (names[e.key]) add({ key: names[e.key] });
        };
        addEventListener('pointerdown', pointer, true); addEventListener('keydown', keydown, true);
        globalThis[key] = { marks, close: () => { removeEventListener('pointerdown', pointer, true); removeEventListener('keydown', keydown, true); delete globalThis[key]; } };
      }
      const state = globalThis[key];
      return { width: innerWidth, height: innerHeight, marks: state.marks.filter(m => Date.now() - m.at < 900) };
    })()`) as InputFrame | undefined;
    if (this.stopped) { this.dispose(); return; }
    if (!frame || !Number.isFinite(frame.width) || !frame.width || !frame.height || !Array.isArray(frame.marks)) return;
    const style = getComputedStyle(document.documentElement);
    ctx.save();
    ctx.strokeStyle = style.getPropertyValue('--color-accent').trim() || 'white';
    ctx.fillStyle = style.getPropertyValue('--color-surface').trim() || 'black';
    ctx.lineWidth = 3;
    for (const mark of frame.marks.slice(-12)) {
      const age = Date.now() - mark.at;
      if (age < 0 || age > 900) continue;
      if (typeof mark.x === 'number' && typeof mark.y === 'number' && Number.isFinite(mark.x) && Number.isFinite(mark.y)) {
        ctx.globalAlpha = 1 - age / 900;
        ctx.beginPath(); ctx.arc(rect.x + mark.x / frame.width * rect.width, rect.y + mark.y / frame.height * rect.height, 12 + age / 45, 0, Math.PI * 2); ctx.stroke();
      }
    }
    const key = frame.marks.findLast(m => typeof m.key === 'string' && m.key.length <= 8);
    if (key) {
      ctx.globalAlpha = 0.95; ctx.font = '600 18px system-ui';
      const width = ctx.measureText(key.key!).width + 30;
      ctx.fillRect(rect.x + (rect.width - width) / 2, rect.y + rect.height - 52, width, 36);
      ctx.fillStyle = style.getPropertyValue('--color-foreground').trim() || 'white';
      ctx.textAlign = 'center'; ctx.fillText(key.key!, rect.x + rect.width / 2, rect.y + rect.height - 28);
    }
    ctx.restore();
  }
  dispose(): void {
    this.stopped = true;
    void this.evaluate(`globalThis[${JSON.stringify(this.key)}]?.close()`).catch(() => {});
  }
}
