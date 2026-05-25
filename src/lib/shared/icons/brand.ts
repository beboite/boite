import {
  siClaude,
  siGithubcopilot,
  siCursor,
} from "simple-icons";
import type { IconKey } from "$lib/types";

export interface BrandGlyph {
  path: string;
  hex: string;
  title: string;
}

const HEX_OVERRIDES: Partial<Record<NonNullable<IconKey>, string>> = {
  cursor: "ffffff",
  copilot: "ffffff",
};

const REGISTRY: Partial<Record<NonNullable<IconKey>, BrandGlyph>> = {
  claude: { path: siClaude.path, hex: siClaude.hex, title: siClaude.title },
  copilot: {
    path: siGithubcopilot.path,
    hex: HEX_OVERRIDES.copilot ?? siGithubcopilot.hex,
    title: siGithubcopilot.title,
  },
  cursor: {
    path: siCursor.path,
    hex: HEX_OVERRIDES.cursor ?? siCursor.hex,
    title: siCursor.title,
  },
};

export function getBrandGlyph(key: NonNullable<IconKey>): BrandGlyph | null {
  return REGISTRY[key] ?? null;
}
