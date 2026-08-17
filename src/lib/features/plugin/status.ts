import type { PluginAccount, PluginStatus } from "$lib/backend/types";

/**
 * The rows a switcher panel can draw, whatever schema the CLI printed.
 *
 * Schema 1 is the contract. Schema 0 is a tool that has no `--json` yet: no
 * rows, just the text it printed. Anything else is treated as schema 0 so a
 * field the tool grew cannot blank the panel.
 */
export function accountsOf(status: PluginStatus | null): PluginAccount[] {
  if (!status || status.schema !== 1) return [];
  return status.accounts ?? [];
}

export function statusText(status: PluginStatus | null): string | null {
  if (!status) return null;
  const text = status.text?.trim();
  return text ? text : null;
}

export function isJsonStatus(status: PluginStatus | null): boolean {
  return status !== null && status.schema === 1;
}
