import type { Extension } from "@codemirror/state";
import type { LanguageDescription } from "@codemirror/language";

// The descriptor table pulls in LanguageDescription machinery for every mode
// CodeMirror knows about. The modes themselves are already split behind
// desc.load(); keeping the table lazy too means opening the editor shell costs
// nothing until an actual file needs highlighting.
let tablePromise: Promise<readonly LanguageDescription[]> | null = null;

function languageTable(): Promise<readonly LanguageDescription[]> {
  tablePromise ??= import("@codemirror/language-data").then((m) => m.languages);
  return tablePromise;
}

export async function detectLanguage(
  filename: string,
): Promise<LanguageDescription | null> {
  const cmLanguages = await languageTable();
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
  const desc = await detectLanguage(filename);
  if (!desc) return null;
  try {
    const support = await desc.load();
    return { name: desc.name, extension: support };
  } catch {
    return null;
  }
}
