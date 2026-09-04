/**
 * The name a human reads for a model id, and the two lists the picker draws.
 *
 * `pilot.catalog` answers ids and nothing else: `boite_pilot::claude::NATIVE_MODELS`
 * is four aliases followed by the full ids, newest family first, with no display
 * name, no family and no "this one is new" flag on any of them. A menu built
 * straight off that list reads `claude-fable-5-1` above `claude-fable-5` above
 * `fable`, which is the same weights named three ways. So the names and the
 * grouping are derived here, on the webview side, with no Rust change: the
 * catalog stays a list of ids and this file decides what a reader sees.
 *
 * Two rules it is built on.
 *
 * **The alias is what a row sends.** `fable` follows the account onto the next
 * release and `claude-fable-5-1` does not, so the four alias rows lead the menu
 * and every full id folds under them. The label comes from the id the alias
 * resolves to, which is how a row reads "Claude Fable 5.1" while sending
 * `fable`.
 *
 * **An id nobody here recognises is drawn as itself.** A driver added later,
 * or a fastpick route naming a model this file never heard of, gets its own id
 * rather than a guess at a brand name.
 */

import { shortModel } from "./present";

/** The four aliases the CLI documents, newest family first. */
export const MODEL_ALIASES = ["fable", "opus", "sonnet", "haiku"] as const;

export type ModelAlias = (typeof MODEL_ALIASES)[number];

/** What each family is called, as Anthropic writes it. Never translated. */
const FAMILY_NAME: Record<ModelAlias, string> = {
  fable: "Claude Fable",
  opus: "Claude Opus",
  sonnet: "Claude Sonnet",
  haiku: "Claude Haiku",
};

/** `claude-opus-4-5`: a family, a major, and an optional minor. */
const FULL_ID = /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?$/;

/** Whether this id is one of the four aliases rather than a pinned version. */
export function isAlias(id: string): id is ModelAlias {
  return (MODEL_ALIASES as readonly string[]).includes(id);
}

/**
 * The display name of a model id, or the id itself.
 *
 * A route id carries its provider (`anthropic/claude-fable-5-1`) and the
 * segment after the last slash is the half worth naming, which is what
 * `shortModel` already trims for the chip.
 */
export function modelLabel(id: string | null): string | null {
  if (!id) return null;
  const name = shortModel(id) ?? id;
  if (isAlias(name)) return FAMILY_NAME[name];
  const parsed = FULL_ID.exec(name);
  if (!parsed) return name;
  const family = parsed[1] as ModelAlias;
  const version = parsed[3] ? `${parsed[2]}.${parsed[3]}` : parsed[2];
  return `${FAMILY_NAME[family]} ${version}`;
}

/**
 * The full id an alias answers on today.
 *
 * The first id of that family in the catalog's own order, which
 * `NATIVE_MODELS` documents as newest family first and newest version first
 * inside a family. Reading the order rather than comparing version numbers is
 * deliberate: the crate is where the release order is known, and a comparison
 * here would disagree with it the first time a version scheme moves.
 */
export function resolveAlias(alias: string, models: readonly string[]): string | null {
  const prefix = `claude-${alias}-`;
  return models.find((id) => id.startsWith(prefix)) ?? null;
}

/** The alias of the family the catalog lists first, which is the newest one. */
export function newestAlias(models: readonly string[]): ModelAlias | null {
  const first = models.find((id) => !isAlias(id));
  if (!first) return null;
  const parsed = FULL_ID.exec(first);
  return parsed ? (parsed[1] as ModelAlias) : null;
}

/** One line of the model list, whatever list it ended up in. */
export interface ModelRow {
  /** What a click sends. An alias wherever the catalog offers one. */
  id: string;
  /** What the row reads. */
  label: string;
  /** The full id an alias row answers on, null for a row that is already one. */
  resolved: string | null;
}

/** The menu, split into the rows it leads with and the ones it folds. */
export interface ModelGroups {
  primary: ModelRow[];
  legacy: ModelRow[];
}

/**
 * The four aliases in front, every pinned id behind a fold.
 *
 * A driver whose list carries no alias at all keeps every id in front: the fold
 * exists to remove a duplicate, and with nothing duplicated it would only hide
 * the whole menu.
 */
export function groupModels(models: readonly string[]): ModelGroups {
  const primary: ModelRow[] = [];
  for (const alias of MODEL_ALIASES) {
    if (!models.includes(alias)) continue;
    const resolved = resolveAlias(alias, models);
    primary.push({ id: alias, label: modelLabel(resolved ?? alias) ?? alias, resolved });
  }
  const rest = models.filter((id) => !isAlias(id));
  if (primary.length === 0) {
    return {
      primary: rest.map((id) => ({ id, label: modelLabel(id) ?? id, resolved: null })),
      legacy: [],
    };
  }
  const taken = new Set(primary.map((row) => row.resolved).filter((id): id is string => !!id));
  return {
    primary,
    legacy: rest
      .filter((id) => !taken.has(id))
      .map((id) => ({ id, label: modelLabel(id) ?? id, resolved: null })),
  };
}

/**
 * Whether this row is the one the thread is running on.
 *
 * A thread pinned to `claude-opus-5` is on the same weights as the `opus` row,
 * so the alias row wears the mark: the alternative is a menu where nothing is
 * selected and the reader cannot tell what is answering.
 */
export function isCurrentModel(row: ModelRow, model: string | null): boolean {
  if (!model) return false;
  return model === row.id || (row.resolved !== null && model === row.resolved);
}
