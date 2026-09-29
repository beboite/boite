export type PaletteDetails = Partial<Record<'surfaceLow' | 'surfaceHigh' | 'muted' | 'subtle' | 'border' | 'edge' | 'frameEdge' | 'hover' | 'active' | 'selection' | 'accentSoft' | 'codeBackground' | 'codeForeground' | 'success' | 'danger' | 'live', string>>;
export type Palette = { background: string; frame: string; surface: string; foreground: string; accent: string; details?: PaletteDetails };
export type ColorRole = Exclude<keyof Palette, 'details'>;
export type SavedPalette = Omit<Palette, 'accent'> & { accent?: string };
export type ColorState = { version: 1; dark?: SavedPalette; light?: SavedPalette };

// Self-contained so the prepaint script uses the same math as the mounted app.
export function colorTools() {
  const detailTokens = {
    surfaceLow: '--color-surface', surfaceHigh: '--color-surface-3',
    muted: '--color-muted-foreground', subtle: '--color-subtle',
    border: '--color-border', edge: '--color-edge', frameEdge: '--color-frame-edge',
    hover: '--color-hover', active: '--color-active', selection: '--color-selection',
    accentSoft: '--color-accent-soft', codeBackground: '--color-code-background', codeForeground: '--color-code-foreground',
    success: '--color-success', danger: '--color-danger', live: '--color-live'
  } as const satisfies Record<keyof PaletteDetails, string>;
  // The mounted app and prepaint script accept the same bounded colour data.
  function parseColorState(value: unknown): ColorState {
    const empty: ColorState = { version: 1 };
    if (!value || typeof value !== 'object' || (value as ColorState).version !== 1) return empty;
    for (const mode of ['dark', 'light'] as const) {
      const p = (value as ColorState)[mode];
      if (!p || typeof p !== 'object') continue;
      const keys = ['background', 'frame', 'surface', 'foreground'] as const;
      const valid = (color: unknown): color is string => typeof color === 'string' && /^#[\da-f]{6}$/i.test(color);
      if (!keys.every(key => valid(p[key])) || (p.accent !== undefined && !valid(p.accent))) continue;
      const saved: SavedPalette = {
        background: p.background.toLowerCase(), frame: p.frame.toLowerCase(),
        surface: p.surface.toLowerCase(), foreground: p.foreground.toLowerCase(),
        ...(p.accent ? { accent: p.accent.toLowerCase() } : {})
      };
      if (p.details && typeof p.details === 'object') {
        const details: PaletteDetails = {};
        for (const key of Object.keys(detailTokens) as (keyof PaletteDetails)[]) {
          if (valid(p.details[key])) details[key] = p.details[key]!.toLowerCase();
        }
        if (Object.keys(details).length) saved.details = details;
      }
      empty[mode] = saved;
    }
    return empty;
  }
  function normalizeHex(value: string): string | undefined {
    const hex = value.trim().replace(/^#?([\da-f]{3}|[\da-f]{6})$/i, '#$1').toLowerCase();
    if (/^#[\da-f]{6}$/.test(hex)) return hex;
    if (/^#[\da-f]{3}$/.test(hex)) return '#' + [...hex.slice(1)].map(c => c + c).join('');
    return undefined;
  }
  function rgb(hex: string): number[] { return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); }
  function hex(channels: number[]): string { return '#' + channels.map(c => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join(''); }
  function mixColor(a: string, b: string, amount: number): string {
    const to = rgb(b);
    return hex(rgb(a).map((c, i) => c * (1 - amount) + to[i]! * amount));
  }
  function luminance(color: string): number {
    const channels = rgb(color).map(c => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  }
  function contrast(a: string, b: string): number {
    const x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  function readable(color: string, grounds: string[], minimum = 4.5): string {
    const score = (candidate: string) => Math.min(...grounds.map(ground => contrast(candidate, ground)));
    if (score(color) >= minimum) return color;
    const black = '#000000', white = '#ffffff';
    const target = score(black) > score(white) ? black : white;
    for (let i = 1; i <= 100; i++) {
      const candidate = mixColor(color, target, i / 100);
      if (score(candidate) >= minimum) return candidate;
    }
    return target;
  }
  function hexToHsv(color: string): { h: number; s: number; v: number } {
    const [r, g, b] = rgb(color).map(c => c / 255) as [number, number, number];
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    const h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: (h * 60 + 360) % 360, s: max === 0 ? 0 : d / max * 100, v: max * 100 };
  }
  function hsvToHex(h: number, s: number, v: number): string {
    const chroma = v / 100 * s / 100, x = chroma * (1 - Math.abs((h / 60) % 2 - 1)), m = v / 100 - chroma;
    const channels = h < 60 ? [chroma, x, 0] : h < 120 ? [x, chroma, 0] : h < 180 ? [0, chroma, x] : h < 240 ? [0, x, chroma] : h < 300 ? [x, 0, chroma] : [chroma, 0, x];
    return hex(channels.map(c => (c + m) * 255));
  }
  function accentHex(hue: number): string {
    const angle = hue * Math.PI / 180, a = .19 * Math.cos(angle), b = .19 * Math.sin(angle);
    const l = (.68 + .3963377774 * a + .2158037573 * b) ** 3;
    const m = (.68 - .1055613458 * a - .0638541728 * b) ** 3;
    const s = (.68 - .0894841775 * a - 1.291485548 * b) ** 3;
    return hex([4.0767416621 * l - 3.3077115913 * m + .2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - .3413193965 * s, -.0041960863 * l - .7034186147 * m + 1.707614701 * s].map(c => (c <= .0031308 ? 12.92 * c : 1.055 * Math.max(c, 0) ** (1 / 2.4) - .055) * 255));
  }
  function accentHue(color: string): number {
    const [r, g, b] = rgb(color).map(c => { const v = c / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }) as [number, number, number];
    const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b);
    const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b);
    const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
    const a = 1.9779984951 * l - 2.428592205 * m + .4505937099 * s;
    const blue = .0259040371 * l + .7827717662 * m - .808675766 * s;
    return (Math.atan2(blue, a) * 180 / Math.PI + 360) % 360;
  }
  function paletteTokens(p: SavedPalette): Record<string, string> {
    const d = p.details ?? {};
    const surface = d.surfaceLow ?? mixColor(p.background, p.surface, .45);
    const surface3 = d.surfaceHigh ?? mixColor(p.surface, p.foreground, .055);
    const grounds = [p.background, p.frame, surface, p.surface, surface3];
    const muted = readable(d.muted ?? mixColor(p.foreground, p.background, .3), grounds);
    const subtle = readable(d.subtle ?? mixColor(p.foreground, p.background, .45), grounds);
    const tokens: Record<string, string> = {
      '--color-background': p.background, '--color-frame': p.frame,
      '--color-surface': surface, '--color-surface-2': p.surface,
      '--color-surface-3': surface3, '--color-foreground': p.foreground,
      '--color-muted-foreground': muted, '--color-subtle': subtle,
      '--color-on-foreground': readable(p.background, [p.foreground]),
      '--color-border': d.border ?? mixColor(p.background, p.foreground, .12),
      '--color-edge': d.edge ?? mixColor(p.background, p.foreground, .24),
      '--color-frame-edge': d.frameEdge ?? mixColor(p.background, p.foreground, .18),
      '--color-hover': d.hover ?? mixColor(p.frame, p.foreground, .06),
      '--color-active': d.active ?? mixColor(p.frame, p.foreground, .11),
      '--color-selection': d.selection ?? mixColor(p.background, p.foreground, .22),
      '--color-code-background': d.codeBackground ?? p.surface,
      '--color-code-foreground': readable(d.codeForeground ?? p.foreground, [d.codeBackground ?? p.surface])
    };
    if (d.accentSoft) tokens['--color-accent-soft'] = d.accentSoft;
    for (const key of ['success', 'danger', 'live'] as const) {
      if (!d[key]) continue;
      const original = d[key]!;
      const score = (candidate: string) => Math.min(...grounds.map(ground => contrast(candidate, ground)));
      const target = score('#000000') > score('#ffffff') ? '#000000' : '#ffffff';
      for (let step = 0; step <= 100; step++) {
        const candidate = mixColor(original, target, step / 100);
        tokens[detailTokens[key]] = candidate;
        if (grounds.every(ground => contrast(candidate, ground) >= 4.5 && contrast(candidate, mixColor(ground, candidate, .14)) >= 4.5)) break;
      }
    }
    if (tokens['--color-danger']) {
      const danger = tokens['--color-danger']!;
      const hover = mixColor(danger, p.foreground, .1);
      tokens['--color-danger-hover'] = hover;
      tokens['--color-on-danger'] = readable(p.background, [danger, hover]);
    }
    if (p.accent) {
      tokens['--color-accent'] = p.accent;
      tokens['--accent-hue'] = String(accentHue(p.accent));
      tokens['--color-accent-ink'] = readable(p.background, [p.accent]);
      tokens['--color-reasoning-on'] = tokens['--color-accent-ink']!;
    }
    return tokens;
  }
  return { detailTokens, parseColorState, normalizeHex, mixColor, luminance, contrast, readable, hexToHsv, hsvToHex, accentHex, paletteTokens };
}

export const { detailTokens, parseColorState, normalizeHex, mixColor, luminance, contrast, readable, hexToHsv, hsvToHex, accentHex, paletteTokens } = colorTools();

/** Editing a main role lets its dependent colours follow it again. */
export function editPalette(palette: Palette, role: ColorRole, value: string): Palette {
  const details = { ...palette.details };
  const dependencies: Record<ColorRole, (keyof PaletteDetails)[]> = {
    background: ['surfaceLow', 'border', 'edge', 'frameEdge', 'selection'],
    frame: ['frameEdge', 'hover', 'active'],
    surface: ['surfaceLow', 'surfaceHigh', 'codeBackground'],
    foreground: ['muted', 'subtle', 'border', 'edge', 'frameEdge', 'hover', 'active', 'selection', 'codeForeground'],
    accent: ['accentSoft']
  };
  for (const key of dependencies[role]) delete details[key];
  return { ...palette, [role]: value, ...(palette.details ? { details } : {}) };
}

export function improvePaletteContrast(palette: Palette): Palette {
  const foreground = readable(palette.foreground, [palette.background], 7);
  const next = editPalette(palette, 'foreground', foreground);
  for (const key of ['frame', 'surface'] as const) {
    for (let step = 0; step <= 100; step++) {
      const candidate = mixColor(palette[key], palette.background, step / 100);
      const raised = key === 'surface' ? mixColor(candidate, foreground, .055) : candidate;
      if (contrast(foreground, raised) >= 5) { next[key] = candidate; break; }
    }
  }
  if (next.details) {
    for (const key of ['surfaceLow', 'surfaceHigh'] as const) {
      const ground = next.details[key];
      if (!ground) continue;
      for (let step = 0; step <= 100; step++) {
        const candidate = mixColor(ground, palette.background, step / 100);
        if (contrast(foreground, candidate) >= 5) { next.details[key] = candidate; break; }
      }
    }
  }
  return next;
}
