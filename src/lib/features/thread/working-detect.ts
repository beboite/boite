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
  // Grok's OSC title cycles a braille spinner plus an activity word
  // (Waiting / Running: <tool> / Compacting / Retrying).
  grok: [
    /esc\s+to\s+(?:interrupt|cancel|stop)/i,
    /\brunning:/i,
    /\bcompacting\b/i,
    /\bretrying\b/i,
    /\(\d+s\s*[·•]/,
  ],
  // Hermes marks busy with a leading ⏳ in the title (✓ idle, ⚠ waiting for
  // approval). On Windows it uses SetConsoleTitle instead of OSC, so text
  // patterns carry local detection there.
  hermes: [
    /esc\s+to\s+(?:interrupt|cancel|stop)/i,
    /\bthinking\b/i,
    /\bworking\b/i,
    /\bgenerating\b/i,
  ],
};

// Includes the full braille spinner block (grok cycles frames beyond the
// common ⠋…⠏ set) and hermes's ⏳ busy marker. ⚠ is deliberately absent:
// it means "action required", which should read as ready, not running.
const TITLE_GLYPHS = /[✱✻✦✺✧✨✳❖✷✴✵◐◓◑◒⏳⠁-⣿]/;
const HAS_LETTER = /[a-zA-Z]/;

export function detectWorking(text: string, iconKey: IconKey): boolean {
  // Spinner glyphs only signal "working" for known AI CLIs. Plain terminals
  // print braille spinners too (npm, vite), which flipped a vanilla shell to
  // running and fired a ghost "Ready for input" notification afterwards.
  const isKnownAgent = !!iconKey && iconKey in WORKING_BY_KEY;
  if (isKnownAgent && TITLE_GLYPHS.test(text)) return true;
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
