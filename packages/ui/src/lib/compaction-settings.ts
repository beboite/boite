import type { CompactionPolicy, CompactionTarget, Settings } from '@boite/contracts';

/** Absent types follow the common defaults, including later changes. */
export function compactionPolicy(settings: Partial<Settings> | null | undefined, target?: CompactionTarget): CompactionPolicy {
  return (target ? settings?.compactionByType?.[target] : undefined) ?? {
    autoCompact: settings?.autoCompact ?? null,
    backgroundCompaction: settings?.backgroundCompaction === true,
    ...(settings?.compactionSummary === undefined ? {} : { compactionSummary: settings.compactionSummary }),
  };
}

/** Settings patches replace the map, so keep every other type and parameter. */
export function compactionPatch(settings: Partial<Settings> | null | undefined, target: CompactionTarget | undefined, patch: Partial<CompactionPolicy>): Partial<Settings> {
  return target ? { compactionByType: { ...settings?.compactionByType, [target]: { ...compactionPolicy(settings, target), ...patch } } } : patch;
}
