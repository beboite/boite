/*
 * The reactive face of `features.ts`, as `experiments.svelte.ts` is for the
 * experiments: a component reading `featureOn(id)` inside a rune follows the
 * switch in Settings without a reload.
 */

import { readFeatures, subscribeFeatures, type FeatureId } from './features';

const mirror = $state<{ features: Record<FeatureId, boolean> }>({ features: readFeatures() });

subscribeFeatures((features) => {
  mirror.features = features;
});

export function featureOn(id: FeatureId): boolean {
  return mirror.features[id];
}
