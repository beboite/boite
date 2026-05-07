import { languages as cmLanguages } from "@codemirror/language-data";
import type { Extension } from "@codemirror/state";
import type { LanguageDescription } from "@codemirror/language";

export function detectLanguage(filename: string): LanguageDescription | null {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot + 1) : "";
  for (const lang of cmLanguages) {
    if (ext && lang.extensions.includes(ext)) return lang;
    if (lang.filename && lang.filename.test(filename)) return lang;
  }
  for (const lang of cmLanguages) {
    if (lang.alias.includes(lower)) return lang;
  }
  return null;
}

export async function loadLanguageExtension(
  filename: string,
): Promise<{ name: string; extension: Extension } | null> {
  const desc = detectLanguage(filename);
  if (!desc) return null;
  try {
    const support = await desc.load();
    return { name: desc.name, extension: support };
  } catch {
    return null;
  }
}
