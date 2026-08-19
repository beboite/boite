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
