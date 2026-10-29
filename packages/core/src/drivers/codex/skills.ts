import type { AgentCommand } from '@boite/contracts';
import { messageOf } from '../../errors.ts';
import type { SessionContext } from '../types.ts';
import type { CodexRpc } from './rpc.ts';

/** A turn that opens on `/name` waits this long at most for the skills it may name. */
const LIST_MS = 5_000;

/** `skills/list`: one entry per folder asked for, each with the skills Codex loads there. */
export interface CodexSkillsListed {
  data?: {
    skills?: {
      name?: string;
      description?: string;
      shortDescription?: string | null;
      interface?: { shortDescription?: string | null } | null;
      path?: string;
      enabled?: boolean;
    }[];
  }[];
}

/** The skills Codex listed, by name: what the menu shows and where each one's `SKILL.md` is. */
export interface CodexSkills {
  commands: AgentCommand[];
  paths: Map<string, string>;
}

/** A name Boite can send as `/name`: one token, the way `nativeCommandPrompt` reads it. */
const NAME = /^[\w:-]+$/;
const LEADING = /^(\s*)\/([\w:-]+)(?=\s|$)/;

/** Enabled skills only, the first of a name winning, as the slash menu lists them. */
export function skillsOf(listed: CodexSkillsListed): CodexSkills {
  const commands: AgentCommand[] = [];
  const paths = new Map<string, string>();
  for (const entry of listed.data ?? []) {
    for (const skill of entry.skills ?? []) {
      const name = skill.name ?? '';
      if (skill.enabled === false || !NAME.test(name) || !skill.path || paths.has(name)) continue;
      paths.set(name, skill.path);
      const description = skill.interface?.shortDescription || skill.shortDescription || skill.description || null;
      commands.push({ name, description, hint: null });
    }
  }
  return { commands, paths };
}

/**
 * The input of a prompt. A leading `/name` of a listed skill goes the way
 * Codex's own composer sends one: the text names it `$name`, and a skill item
 * points at its file so Codex loads it. Anything else is the text alone.
 */
export function promptInput(prompt: string, skills: ReadonlyMap<string, string>): ({ type: 'text'; text: string; text_elements: [] } | { type: 'skill'; name: string; path: string })[] {
  const match = LEADING.exec(prompt);
  const name = match?.[2];
  const path = name === undefined ? undefined : skills.get(name);
  if (match === null || name === undefined || path === undefined) return [{ type: 'text', text: prompt, text_elements: [] }];
  return [{ type: 'text', text: `${match[1]}$${name}${prompt.slice(match[0].length)}`, text_elements: [] }, { type: 'skill', name, path }];
}

type Input = ReturnType<typeof promptInput>;

/**
 * One process's skills as the thread's `/name` commands, asked when it opens
 * and again when `skills/changed` says a skill file moved. An older Codex
 * without `skills/list` is one line in the log and an empty menu.
 */
export class CodexSkillCommands {
  private paths: ReadonlyMap<string, string> = new Map();
  /** The newest list asked for: an older answer arriving after it is dropped. */
  private latest: Promise<void> = Promise.resolve();
  private generation = 0;

  /** `rpc` is the process the answer must still belong to when it arrives. */
  constructor(private readonly current: () => CodexRpc | null) { }

  opened(rpc: CodexRpc, ctx: SessionContext): void { this.latest = this.list(rpc, ctx, false); }

  changed(ctx: SessionContext | null): void {
    const rpc = this.current();
    if (rpc !== null && ctx !== null) this.latest = this.list(rpc, ctx, true);
  }

  /** A turn's input: a prompt that opens on `/name` waits for the newest list. */
  async turn(prompt: string): Promise<Input> {
    if (LEADING.test(prompt)) await this.latest;
    return promptInput(prompt, this.paths);
  }

  /** A steer goes out at once, with the skills known by then. */
  steer(prompt: string): Input { return promptInput(prompt, this.paths); }

  private async list(rpc: CodexRpc, ctx: SessionContext, forceReload: boolean): Promise<void> {
    const generation = ++this.generation;
    try {
      const listed = await rpc.request<CodexSkillsListed>('skills/list', { cwds: [ctx.thread.cwd], ...(forceReload ? { forceReload } : {}) }, { timeoutMs: LIST_MS });
      if (this.current() !== rpc || generation !== this.generation) return;
      const { commands, paths } = skillsOf(listed);
      this.paths = paths;
      ctx.commands(commands);
    } catch (error) {
      ctx.log('info', `codex: skills/list failed: ${messageOf(error)}`);
    }
  }
}
