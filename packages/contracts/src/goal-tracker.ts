import type { ModelInfo, Protocol } from './index.ts';
import { newestModel } from './title-models.ts';

/**
 * The models a `/goal2` checklist is written and checked with when Settings
 * names none: the newest Opus at medium on Claude, else the newest Sol at high
 * on Codex. The conversation's own agent goes first when it is one of them;
 * with neither signed in, the conversation's own model keeps the list. A small
 * model is never picked by itself: on long prompts it dropped requests and
 * turned some into their opposite.
 */
export interface GoalTrackerRule {
  protocol: Protocol;
  /** Matched against model ids; the newest listed one wins. */
  family: RegExp;
  effort: string;
}

export const GOAL_TRACKER_DEFAULTS: readonly GoalTrackerRule[] = [
  { protocol: 'claude-sdk', family: /^claude-opus-\d/i, effort: 'medium' },
  { protocol: 'codex-appserver', family: /^gpt-[\d.]+-sol$/i, effort: 'high' },
];

/** The default rule's model and effort among one agent's models, or null when it lists none of them. */
export function defaultTrackerModel(protocol: Protocol, models: readonly Pick<ModelInfo, 'id'>[]): { model: string; effort: string } | null {
  for (const rule of GOAL_TRACKER_DEFAULTS) {
    if (rule.protocol !== protocol) continue;
    const model = newestModel(models, rule.family);
    if (model !== null) return { model, effort: rule.effort };
  }
  return null;
}

/** The effort a picked model starts on: the default rule's for its family, else the model's own default. */
export function trackerEffort(model: Pick<ModelInfo, 'id' | 'effort'>): string | null {
  const levels = model.effort?.levels.map((level) => level.id) ?? [];
  const rule = GOAL_TRACKER_DEFAULTS.find((entry) => entry.family.test(model.id));
  if (rule && levels.includes(rule.effort)) return rule.effort;
  return model.effort?.default ?? null;
}

/** Items a checklist keeps; a longer list is cut, its last items dropped. */
export const GOAL_CHECKLIST_MAX_ITEMS = 80;
export const GOAL_CHECKLIST_TEXT_MAX = 160;
export const GOAL_CHECKLIST_SOURCE_MAX = 300;
