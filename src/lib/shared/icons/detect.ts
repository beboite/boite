import type { IconKey } from "$lib/types";

interface DetectionRule {
  key: NonNullable<IconKey>;
  patterns: RegExp[];
}

const RULES: DetectionRule[] = [
  { key: "claude", patterns: [/\bclaude\b/i, /\banthropic\b/i, /\bcc\b/i] },
  { key: "codex", patterns: [/\bcodex\b/i, /\bchatgpt\b/i, /\bopenai\b/i, /\bgpt\b/i] },
  { key: "opencode", patterns: [/\bopencode\b/i] },
  { key: "cursor", patterns: [/\bcursor\b/i, /cursor-agent/i] },
  { key: "antigravity", patterns: [/\bantigravity\b/i, /\bagy\b/i] },
  { key: "copilot", patterns: [/\bcopilot\b/i, /\bgh\s+copilot\b/i] },
  { key: "grok", patterns: [/\bgrok\b/i, /\bxai\b/i] },
  { key: "hermes", patterns: [/\bhermes\b/i, /\bnous[- ]?research\b/i] },
  {
    key: "terminal",
    patterns: [
      /\bpwsh\b/i,
      /\bpowershell\b/i,
      /\bbash\b/i,
      /\bzsh\b/i,
      /\bcmd\b/i,
      /\bsh\b/i,
      /\bfish\b/i,
      /\bnu\b/i,
    ],
  },
];

export function detectIconKey(...samples: (string | null | undefined)[]): IconKey {
  const haystack = samples.filter(Boolean).join(" ");
  if (!haystack) return null;
  for (const rule of RULES) {
    for (const pat of rule.patterns) {
      if (pat.test(haystack)) return rule.key;
    }
  }
  return null;
}

export function resolveIconKey(
  manual: IconKey | undefined,
  ...samples: (string | null | undefined)[]
): IconKey {
  if (manual) return manual;
  return detectIconKey(...samples);
}
