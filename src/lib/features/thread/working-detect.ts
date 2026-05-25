import type { IconKey } from "$lib/types";

const COMMON_PATTERNS: RegExp[] = [
  /esc\s+to\s+(?:interrupt|cancel|stop)/i,
  /ctrl\s*\+\s*c\s+to\s+(?:cancel|stop|interrupt)/i,
];

const WORKING_BY_KEY: Partial<Record<NonNullable<IconKey>, RegExp[]>> = {
  claude: [
    /esc\s+to\s+interrupt/i,
    /\(\d+s\s*[·•]/,
    /[↑↓]\s*[\d.]+\s*k?\s*tokens?/i,
  ],
  codex: [
    /esc\s+to\s+(?:interrupt|cancel|stop)/i,
    /\(\d+s\s*[·•]/,
  ],
  opencode: [
    /esc\s+to\s+(?:interrupt|cancel|stop)/i,
    /\bgenerating\b/i,
    /\bthinking\b/i,
    /\bworking\b/i,
    /\bprocessing\b/i,
    /\(\d+s\s*[·•]/,
  ],
  cursor: [
    /esc\s+to\s+(?:interrupt|cancel|stop)/i,
    /\bgenerating\b/i,
    /\bthinking\b/i,
  ],
  antigravity: [
    /esc\s+to\s+(?:interrupt|cancel|stop)/i,
    /\bgenerating\b/i,
    /\bthinking\b/i,
    /\bworking\b/i,
    /✨\s*generating/i,
  ],
};

const TITLE_GLYPHS = /[✱✻✦✺✧✨✳❖✷✴✵⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒]/;
const HAS_LETTER = /[a-zA-Z]/;

export function detectWorking(text: string, iconKey: IconKey): boolean {
  if (TITLE_GLYPHS.test(text)) return true;
  if (!HAS_LETTER.test(text)) return false;
  const patterns = (iconKey && WORKING_BY_KEY[iconKey]) || COMMON_PATTERNS;
  for (const pat of patterns) {
    if (pat.test(text)) return true;
  }
  return false;
}

export function titleSignalsWorking(title: string): boolean {
  return TITLE_GLYPHS.test(title);
}
