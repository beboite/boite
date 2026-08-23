import type { FastpickKey, FastpickModel, FastpickProvider } from "$lib/backend/types";

/**
 * A provider's credentials, whichever schema fastpick answered in.
 *
 * Schema 3 split a provider into several keys, each with its own key file, its own bindings
 * and its own model catalogue. The three fields that used to describe the provider itself
 * now describe one key, so a menu reading them straight off the provider reads `undefined`
 * on a current fastpick: the missing-key mark went out and every binding read as native,
 * which tinted a proxied thread like a stock agent.
 *
 * The older shape is folded into one key named after the provider, which is what fastpick
 * itself would have called it. Everything downstream then has one shape to handle, and a
 * remote boite on an older fastpick still draws.
 */
export function providerKeys(provider: FastpickProvider | null | undefined): FastpickKey[] {
  if (!provider) return [];
  if (provider.keys?.length) return provider.keys;
  return [
    {
      id: provider.id,
      label: null,
      needsKey: provider.needsKey ?? false,
      keyPresent: provider.keyPresent ?? false,
      harnesses: provider.harnesses,
      proxyPort: provider.proxyPort ?? null,
    },
  ];
}

/**
 * The credentials of that provider this harness can actually reach.
 *
 * A provider is listed against a harness as soon as one of its keys binds to it, and the
 * others are not launchable there: on this config `codex-everywhere` reaches pi through two
 * of its three keys, and the third one's six models are six rows that resolve to nothing.
 * fastpick refuses them; the menu has to stop offering them.
 *
 * A key declaring no bindings at all is kept rather than dropped. That is what an older
 * fastpick answers, and hiding every row on a listing that simply says less would leave an
 * empty menu with nothing to explain it.
 */
export function keysForHarness(
  provider: FastpickProvider | null | undefined,
  harnessId: string | null | undefined,
): FastpickKey[] {
  const keys = providerKeys(provider);
  if (!harnessId) return keys;
  const bound = keys.filter((k) => !k.harnesses || k.harnesses[harnessId]);
  return bound.length > 0 ? bound : keys;
}

/**
 * The credential a model is served by, out of the ones offered.
 *
 * A model with no `key` is either an older fastpick or a provider holding a single
 * credential, and both mean the same thing here: there is nothing to choose between. A key
 * the list no longer holds falls back to the first rather than to nothing, the same way a
 * thread launched before a config change still draws.
 */
export function keyForModel(
  keys: readonly FastpickKey[],
  model: Pick<FastpickModel, "key"> | null | undefined,
): FastpickKey | null {
  if (keys.length === 0) return null;
  if (!model?.key) return keys[0];
  return keys.find((k) => k.id === model.key) ?? keys[0];
}

/** That provider's credential by id, or its first one when the id names nothing. */
export function keyById(
  provider: FastpickProvider | null | undefined,
  id: string | null | undefined,
): FastpickKey | null {
  return keyForModel(providerKeys(provider), id ? { key: id } : null);
}

/** How a credential reads in the menu: fastpick's label, or the id it is named by. */
export function keyLabel(key: FastpickKey): string {
  return key.label?.trim() || key.id;
}

/** Whether one of these credentials wants a key file that is not there. */
export function missingKeyFile(keys: readonly FastpickKey[]): boolean {
  return keys.some((k) => k.needsKey && !k.keyPresent);
}
