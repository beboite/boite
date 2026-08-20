import type { MessageKey } from "$lib/i18n/index.svelte";
import type { CliRow } from "$lib/backend";

/**
 * Why a row cannot be installed right now, or `null` when it can.
 *
 * A rule rather than a condition inside the component, for two reasons. It is
 * testable in Node, which the row is not; and it is one answer, so the sentence
 * the row prints and the button it disables can never disagree — which is the
 * failure mode of "needs gh" written under a button that is still clickable.
 *
 * The message key travels on the data rather than being written at a `t()` call
 * that varies, which is what `AGENTS.md` asks for: a key that has to vary goes on
 * the data instead.
 */
export type CliBlocker = {
  key: MessageKey;
  /** The command that is missing, for the sentence and for the link. */
  tool?: string;
  /** Where to get it, when there is somewhere to send the user. */
  url?: string;
};

/** What stops this row, in the order the user should hear about it. */
export function blocker(row: CliRow): CliBlocker | null {
  // Nothing Boite can run: the vendor's own instructions are the whole answer.
  if (row.source === "manual") return { key: "cli.manualOnly", url: undefined };
  // A vendor that builds for other platforms and not this one.
  if (!row.installable) return { key: "cli.noBuild" };
  // The manager that would do the work is not here. Probed on the machine that
  // would run it, so a remote boite answers for the server.
  if (row.source === "managed" && row.requiresPresent === false) {
    return {
      key: "cli.needs",
      tool: row.requires ?? "",
      url: row.requiresUrl ?? undefined,
    };
  }
  return null;
}

export type CliAction = "install" | "update" | "reinstall";

/**
 * What the primary button does, which is also what it is allowed to be called.
 *
 * The row used to read "Update" for anything installed, so ten CLIs that were
 * all current offered ten updates. Reinstalling and updating are the same call
 * here — fetch what the vendor publishes and put it in the managed bin — but
 * they are not the same sentence, and the one the user acts on has to be the
 * true one.
 *
 * `latest` is what the vendor publishes right now, `undefined` while nobody has
 * asked yet and `null` when asking failed. Both mean the same thing here:
 * nothing knows of an update, so nothing claims one.
 */
export function action(row: CliRow, latest?: string | null): CliAction {
  if (!row.installed) return "install";
  // A package manager keeps its own idea of what is current and will not say
  // without being run, and running it *is* the update. So the button keeps the
  // name of the command behind it rather than guessing.
  if (row.source === "managed") return "update";
  return behind(row.version, latest) ? "update" : "reinstall";
}

/**
 * Whether the row may say it is current, rather than merely not known to be behind.
 *
 * Being *ahead* counts. Claude's stable pointer said 2.1.227 while the binary on
 * the machine was 2.1.235, because the two came off different channels — and a
 * row that read "different" as "newer" offered a downgrade under the word
 * Update.
 */
export function upToDate(row: CliRow, latest?: string | null): boolean {
  if (!row.installed) return false;
  const here = normalise(row.version);
  const there = normalise(latest);
  if (here === null || there === null) return false;
  if (here === there) return true;
  const order = compare(there, here);
  // Neither ahead nor behind can be claimed of two versions nothing can order,
  // and "up to date" is a claim.
  return order !== null && order < 0;
}

/** Whether what is installed is older than what the vendor publishes. */
function behind(installed: string | null | undefined, published: string | null | undefined): boolean {
  const here = normalise(installed);
  const there = normalise(published);
  if (here === null || there === null || here === there) return false;
  const order = compare(there, here);
  // Not orderable and not identical: something changed and nothing here can say
  // in which direction, so the row claims nothing rather than claiming wrongly.
  if (order === null) return false;
  // Same numbers and a different string is the vendor rebuilding the same
  // version, which is still something newer than what is on the machine.
  return order >= 0;
}

/**
 * Two spellings of one version.
 *
 * A vendor's pointer says `v1.1.15` and its own `--version` says `1.1.15`, and a
 * row that read those as different offered an update to the version already on
 * the machine.
 */
function normalise(version: string | null | undefined): string | null {
  if (!version) return null;
  const trimmed = version.trim().replace(/^v/i, "");
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * `a` against `b` by their leading numbers, or `null` when neither has any.
 *
 * The numbers only, stopping at the first part that is not one: cursor publishes
 * `2026.08.11-e8db854`, where the build hash orders nothing and comparing it as
 * text would order `1.9.0` above `1.10.0`.
 */
function compare(a: string, b: string): number | null {
  const left = numbers(a);
  const right = numbers(b);
  if (left === null || right === null) return null;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function numbers(version: string): number[] | null {
  const parts: number[] = [];
  for (const part of version.split(/[.\-+_]/)) {
    if (!/^\d+$/.test(part)) break;
    parts.push(Number(part));
  }
  return parts.length > 0 ? parts : null;
}

/**
 * Whether removing is offered.
 *
 * Not simply "is it installed": an extension whose host tool has gone cannot be
 * removed by the command that would remove it, and offering the button would run
 * `gh extension remove` against a `gh` that is not there. What Boite installed
 * itself is always removable, host tool or not.
 */
export function removable(row: CliRow): boolean {
  if (!row.installed) return false;
  if (row.managed) return true;
  if (row.source === "manual") return false;
  if (row.source === "managed") return row.requiresPresent !== false;
  // A download-source CLI installed by somebody else: the binary is not Boite's
  // to take back, but its data is still the user's to delete.
  return true;
}
