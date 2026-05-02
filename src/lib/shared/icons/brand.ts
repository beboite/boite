import {
  siClaude,
  siGooglegemini,
  siGithubcopilot,
  siCursor,
} from "simple-icons";
import type { IconKey } from "$lib/types";

export interface BrandGlyph {
  path: string;
  hex: string;
  title: string;
}

const REGISTRY: Partial<Record<NonNullable<IconKey>, BrandGlyph>> = {
  claude: { path: siClaude.path, hex: siClaude.hex, title: siClaude.title },
  gemini: {
    path: siGooglegemini.path,
    hex: siGooglegemini.hex,
    title: siGooglegemini.title,
  },
  copilot: {
    path: siGithubcopilot.path,
    hex: siGithubcopilot.hex,
    title: siGithubcopilot.title,
  },
  cursor: { path: siCursor.path, hex: siCursor.hex, title: siCursor.title },
};

export function getBrandGlyph(key: NonNullable<IconKey>): BrandGlyph | null {
  return REGISTRY[key] ?? null;
}

export const BRAND_KEYS: NonNullable<IconKey>[] = [
  "claude",
  "codex",
  "opencode",
  "cursor",
  "gemini",
  "copilot",
  "terminal",
];
