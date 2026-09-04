/**
 * What a model change will do, decided before the click.
 *
 * `docs/pilot.md` promises the picker says which of the three happens: nothing
 * stops, the session reopens on the same native conversation, or the driver
 * cannot do it at all. The host answers the same question after the fact with
 * `SwitchKind`; this answers it in front of the user, off the catalog, so a row
 * that would restart says so instead of going quiet for a second.
 *
 * Pure and free of Svelte, so the three cases are a test rather than a click.
 */

import type {
  PilotCapabilities,
  PilotInstanceEntry,
  PilotRequestAnswer,
  PilotRequestOption,
  PilotSwitchKind,
} from "./types";

/** What the picker is about to do, and why. */
export interface SwitchOutcome {
  kind: PilotSwitchKind;
  /** The message key describing it, so the component holds no literal. */
  key:
    | "pilot.switchInPlace"
    | "pilot.switchRestart"
    | "pilot.switchLater";
  /** Whether the row may be clicked at all. */
  enabled: boolean;
}

const IN_PLACE: SwitchOutcome = {
  kind: "in_session",
  key: "pilot.switchInPlace",
  enabled: true,
};
const RESTART: SwitchOutcome = {
  kind: "restart",
  key: "pilot.switchRestart",
  enabled: true,
};
const LATER: SwitchOutcome = {
  kind: "unsupported",
  key: "pilot.switchLater",
  enabled: false,
};

/**
 * The three rows of "Model selection, instances, fastpick".
 *
 * Another driver is a graft and is phase 4, so it is disabled and says "later"
 * rather than being hidden: a menu that hides what it cannot do yet teaches the
 * user the driver does not exist.
 *
 * Same driver and same instance is in-session only where the driver declares
 * it. Claude does; a driver that declares `restart` restarts even for a plain
 * model change, and the picker must not promise otherwise.
 */
export function switchOutcome(
  current: { driver: string; instance: string | null },
  target: { driver: string; instance: string },
  capabilities: PilotCapabilities | null,
): SwitchOutcome {
  if (target.driver !== current.driver) return LATER;
  if (capabilities?.model_switch === "unsupported") return LATER;
  if (current.instance !== null && target.instance !== current.instance) return RESTART;
  return capabilities?.model_switch === "restart" ? RESTART : IN_PLACE;
}

/** The instances of one driver, which is all a thread's picker may offer. */
export function instancesOf(
  instances: readonly PilotInstanceEntry[],
  driver: string,
): PilotInstanceEntry[] {
  return instances.filter((entry) => entry.driver === driver);
}

/**
 * The answer sent for a chosen option.
 *
 * The wire takes the driver's own opaque value and the machine holding the
 * process maps it (`boite_core::pilot::answer_of_option`), so this is the one
 * check made here: an option the request never offered is not sent at all. A
 * card that could send a value the driver did not name would be a tool running
 * on a string nobody recognised, which is exactly what the closed vocabulary on
 * the other side exists to refuse.
 */
export function answerFor(
  options: readonly PilotRequestOption[] | undefined,
  value: string,
): PilotRequestAnswer | null {
  if (!options || options.length === 0) return null;
  return options.some((option) => option.value === value) ? value : null;
}

/**
 * Whether an option means "allow, and remember it".
 *
 * The driver names it, boite does not: claude offers `allow_always` beside
 * `allow`, and the suggestions the request carries are what the host echoes
 * back as `updated_permissions`. Read off the value rather than the label,
 * which is the half a locale changes.
 */
export function isAlwaysAllow(value: string): boolean {
  return value === "allow_always" || value === "always_allow";
}
