import {
  siUnity,
  siUnrealengine,
  siGodotengine,
  siFlutter,
  siDart,
  siTauri,
  siElectron,
  siNextdotjs,
  siNuxt,
  siSvelte,
  siVuedotjs,
  siAngular,
  siReact,
  siAndroid,
  siSwift,
  siRust,
  siGo,
  siPython,
  siDotnet,
  siOpenjdk,
  siCplusplus,
  siNodedotjs,
} from "simple-icons";

interface SimpleIcon {
  path: string;
  hex: string;
  title: string;
}

const TECH_GLYPHS: Record<string, SimpleIcon> = {
  unity: siUnity,
  unreal: siUnrealengine,
  godot: siGodotengine,
  flutter: siFlutter,
  dart: siDart,
  tauri: siTauri,
  electron: siElectron,
  next: siNextdotjs,
  nuxt: siNuxt,
  svelte: siSvelte,
  vue: siVuedotjs,
  angular: siAngular,
  react: siReact,
  android: siAndroid,
  swift: siSwift,
  rust: siRust,
  go: siGo,
  python: siPython,
  dotnet: siDotnet,
  java: siOpenjdk,
  cpp: siCplusplus,
  node: siNodedotjs,
};

// Near-black brand marks (Next.js, Rust, Unreal…) disappear on the dark
// sidebar; lift them to a light neutral instead.
function displayHex(hex: string): string {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.25 ? "e4e4e7" : hex;
}

export function techIconDataUrl(tech: string): string | null {
  const glyph = TECH_GLYPHS[tech];
  if (!glyph) return null;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 28 28">` +
    `<path fill="#${displayHex(glyph.hex)}" d="${glyph.path}"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
