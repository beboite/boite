import { backend } from "$lib/backend";
import { settings } from "$lib/features/settings/store.svelte";
import { log } from "$lib/shared/log";
import { chatAvailable, driverOfArgv, driverOfCommand, driverOfHarness } from "./launch";
import type { PilotCatalog } from "./types";

/**
 * Which agents boite can hold a conversation with, asked once per window.
 *
 * Every launcher needs the same answer about the same shortcuts, and the host
 * already caches its own reply for a minute; asking per row would be one IPC
 * hop per button drawn. `ensure` is idempotent and the failure is silent by
 * design: a catalog that did not answer means no Chat button, which is exactly
 * what a boite with no pilot runtime should show.
 */
class CatalogStore {
  current = $state<PilotCatalog | null>(null);
  #pending: Promise<void> | null = null;

  ensure(): Promise<void> {
    this.#pending ??= backend()
      .pilot.catalog()
      .then((answer) => {
        this.current = answer;
      })
      .catch((err: unknown) => {
        // Cleared so a boite that came up after the window can still answer.
        this.#pending = null;
        log.warn("pilot.catalog", "pilot.catalog.failed", { reason: String(err) });
      });
    return this.#pending;
  }

  /** Forgets the answer, for a workspace switch. */
  reset(): void {
    this.current = null;
    this.#pending = null;
  }
}

export const pilotCatalog = new CatalogStore();

/**
 * Whether this launcher row may be started as a chat, and why not.
 *
 * One function so the four launchers agree: the experiment arms the choice at
 * all, and the catalog decides which presets it is enabled for. A row that
 * names no agent gets nothing rather than a greyed button, since "Chat" beside
 * a plain shell is a question nobody asked.
 */
export function chatChoice(command: string): {
  offered: boolean;
  enabled: boolean;
} {
  return choiceFor(driverOfCommand(command));
}

/**
 * The same answer for a launcher that holds an argv rather than a line.
 *
 * The fastpick menu is the one: it builds `fastpick --harness ... --model ...`
 * as arguments and never as a string, and joining them to split them again is
 * how a model id with a space in it stops naming a driver.
 */
export function chatChoiceArgv(
  cmd: string,
  args: readonly string[],
): { offered: boolean; enabled: boolean } {
  return choiceFor(driverOfArgv(cmd, args));
}

/**
 * The same answer for a fastpick harness, before a model has been picked.
 *
 * The fastpick menu asks this: whether a route can be a chat depends on the
 * harness alone, since the provider and the model are the account and the
 * weights and neither changes which protocol the program speaks.
 */
export function chatChoiceHarness(harness: string): {
  offered: boolean;
  enabled: boolean;
} {
  return choiceFor(driverOfHarness(harness));
}

function choiceFor(driver: string | null): { offered: boolean; enabled: boolean } {
  if (!settings.state.experimentPilot) return { offered: false, enabled: false };
  if (!driver) return { offered: false, enabled: false };
  return { offered: true, enabled: chatAvailable(pilotCatalog.current, driver) };
}
