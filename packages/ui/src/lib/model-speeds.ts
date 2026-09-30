import type { ModelInfo } from '@boite/contracts';
import type { Choice, PickPatch } from './store.svelte';
import { strings } from './strings';

type Speed = NonNullable<ModelInfo['speeds']>[number];
const rank = (id: string) => id === 'fast' || id === 'priority' ? 0 : id === 'ultrafast' ? 1 : 2;

/** Native tiers take precedence; separate variants must share an exact model id stem. */
export function speedControl(models: ModelInfo[], choice: Choice | null): { speeds: Speed[]; speed: string | null; pick: (id: string | null) => PickPatch } {
  const model = models.find(entry => entry.id === choice?.model);
  if (model?.speeds?.length) return {
    speeds: [...model.speeds].sort((a, b) => rank(a.id) - rank(b.id)),
    speed: choice?.speed ?? null,
    pick: speed => ({ speed }),
  };
  const suffix = /[-_:](ultrafast|fast)$/i;
  const baseId = model?.id.replace(suffix, '');
  const base = models.find(entry => entry.id === baseId);
  const variants = base ? models.filter(entry => suffix.test(entry.id) && entry.id.replace(suffix, '') === base.id) : [];
  const speeds = variants.sort((a, b) => Number(/ultrafast$/i.test(a.id)) - Number(/ultrafast$/i.test(b.id)))
    .map(entry => ({ id: entry.id, label: /ultrafast$/i.test(entry.id) ? 'Ultrafast' : strings.effortLevels.fast }));
  return {
    speeds,
    speed: speeds.some(entry => entry.id === model?.id) ? model!.id : null,
    pick: id => {
      const target = id === null ? base : variants.find(entry => entry.id === id);
      if (!target) return {};
      const effort = choice?.effort ?? model?.effort?.default ?? null;
      return { model: target.id, speed: null, effort: target.effort?.levels.some(level => level.id === effort) ? effort : target.effort?.default ?? null };
    },
  };
}
