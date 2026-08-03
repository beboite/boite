import { t } from "$lib/i18n/index.svelte";
import { isScratch } from "$lib/domain/project";

/**
 * The name to put on screen for a project.
 *
 * Scratch is the app's own row, not something the user named, so it reads in
 * the app's language. The stored `name` column stays English: it is what the
 * MCP endpoint and the logs match on, and translating a database value would
 * make a French install and an English one disagree about the same row.
 *
 * Here rather than in `lib/domain` because it needs the current locale, and a
 * domain rule that reads reactive state is not a rule any more. Here rather
 * than in the project feature because five other features draw a project's
 * name, and each import of it was a cycle.
 */
export function projectDisplayName(project: { id: string; name: string }): string {
  return isScratch(project) ? t("project.scratch") : project.name;
}
