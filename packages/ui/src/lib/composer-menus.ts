/**
 * What the composer's two menus list and how their keys behave. The slash menu
 * opens on `/` at the start of an empty box; the mention menu on `@` at the
 * start of a word, wherever the caret is. The component owns the state (the
 * dismissals, the row the keyboard is on, the page in flight); these are the
 * pure pieces it derives from.
 */
import type { AgentCommand, PreviewReference } from '@boite/contracts';
import { AGENT_PREFIX, isAgentCommand } from './commands.svelte';
import { experimentOn } from './experiments.svelte';
import type { PaletteItem } from './palette';
import { strings } from './strings';

/** A command the composer runs itself: the testid of the chip whose menu it opens, and its line. */
export type ChipCommand = { testid: string; description: string };
export const SKILL_PREFIX = 'skill:';
const PROMPT_COMMANDS = ['goal', 'goal2', 'loop', 'btw'];

/** Prompt rows insert their token; control rows return null to open their picker. */
export function slashCompletion(item: PaletteItem): string | null {
  if (item.id.startsWith(SKILL_PREFIX)) return `${item.label} `;
  if (isAgentCommand(item)) return `/${item.id.slice(AGENT_PREFIX.length)} `;
  return PROMPT_COMMANDS.includes(item.id) ? `/${item.id} ` : null;
}

/** Global manual skills are prompt text, with native and Boite commands taking name collisions. */
export function skillSlashItems(skills: AgentCommand[], commands: AgentCommand[], reserved: readonly string[] = []): PaletteItem[] {
  const seen = new Set([...commands.map(command => command.name), ...PROMPT_COMMANDS, ...reserved]);
  return skills.filter(skill => {
    if (!skill.name || /\s/.test(skill.name) || seen.has(skill.name)) return false;
    seen.add(skill.name);
    return true;
  }).map(skill => ({ id: `${SKILL_PREFIX}${skill.name}`, kind: 'command', label: `/${skill.name}`, description: skill.description ?? undefined }));
}

/** What was typed after the slash, or null while the box is not a bare `/word`. */
export function slashQueryOf(text: string): string | null {
  const match = /^\/(\S*)$/.exec(text);
  return match ? (match[1] ?? '') : null;
}

/** The word being typed after an `@`, or null while the caret is not on one. */
export function mentionQueryOf(text: string, caret: number, previewReferences: PreviewReference[]): string | null {
  if (previewReferences.some(reference => reference.mention && caret > reference.mention.start && caret <= reference.mention.end)) return null;
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  return match ? (match[1] ?? '') : null;
}

/** The agent's own, in the order it reported them. Never on a draft: there is no agent yet. */
export function agentSlashItems(commands: AgentCommand[]): PaletteItem[] {
  return commands.filter((command) => !PROMPT_COMMANDS.includes(command.name)).map((command) => ({
    id: `${AGENT_PREFIX}${command.name}`,
    kind: 'command' as const,
    label: `/${command.name}`,
    hint: command.hint ?? undefined,
    description: command.description ?? undefined
  }));
}

/**
 * Only actions for the current prompt. Application navigation stays in the
 * command palette rather than competing with the agent's slash commands.
 */
export function boiteSlashItems(chips: Record<string, ChipCommand>, sideQuestions = false): PaletteItem[] {
  return [
    ...(sideQuestions ? [{ id: 'btw', kind: 'command' as const, label: '/btw', hint: '<question>', description: strings.btw.description }] : []),
    { id: 'goal', kind: 'command', label: '/goal', description: strings.activity.goalDescription },
    // Read inside the composer's derived list, so the Experiments switch adds or removes it live.
    ...(experimentOn('goal2') ? [{ id: 'goal2', kind: 'command' as const, label: '/goal2', description: strings.activity.goal2Description }] : []),
    { id: 'loop', kind: 'command', label: '/loop', description: strings.activity.loopDescription },
    ...Object.entries(chips).map(([name, chip]) => ({
      id: name,
      kind: 'command' as const,
      label: `/${name}`,
      description: chip.description
    }))
  ];
}

/** A page of project files as mention rows: the file name, its directory under it. */
export function mentionRows(files: string[]): PaletteItem[] {
  return files.map((path) => {
    const cut = path.lastIndexOf('/');
    return {
      id: path,
      kind: 'command' as const,
      label: cut < 0 ? path : path.slice(cut + 1),
      description: cut < 0 ? undefined : path.slice(0, cut)
    };
  });
}

/**
 * The keys of an open menu. True when the key was the menu's: Escape shuts it
 * on the text as typed, Enter and Tab take the row, the arrows move.
 */
export function listKey(
  event: KeyboardEvent,
  items: PaletteItem[],
  at: number,
  move: (index: number) => void,
  dismiss: () => void,
  pick: (item: PaletteItem) => void
): boolean {
  if (event.key === 'Escape') {
    dismiss();
    return true;
  }
  if (event.key === 'Enter' || event.key === 'Tab') {
    const item = items[at];
    if (!item) return false;
    pick(item);
    return true;
  }
  if (items.length === 0) return false;
  if (event.key === 'ArrowDown') move((at + 1) % items.length);
  else if (event.key === 'ArrowUp') move((at - 1 + items.length) % items.length);
  else return false;
  return true;
}
