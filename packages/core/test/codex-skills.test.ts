import { expect, test } from 'bun:test';
import type { AgentCommand } from '@boite/contracts';
import { CodexSkillCommands, type CodexSkillsListed } from '../src/drivers/codex/skills.ts';
import type { CodexRpc } from '../src/drivers/codex/rpc.ts';
import type { SessionContext } from '../src/drivers/types.ts';

const listed = (name: string): CodexSkillsListed => ({ data: [{ skills: [{ name, description: name, path: `/skills/${name}/SKILL.md`, enabled: true }] }] });

test('a skills/list answer older than the newest request does not overwrite it', async () => {
  const answers: ((value: CodexSkillsListed) => void)[] = [];
  const rpc = { request: () => new Promise((resolve) => answers.push(resolve)) } as unknown as CodexRpc;
  const menus: AgentCommand[][] = [];
  const ctx = { thread: { cwd: '/work' }, commands: (list: AgentCommand[]) => menus.push(list), log: () => {} } as unknown as SessionContext;
  const skills = new CodexSkillCommands(() => rpc);

  skills.opened(rpc, ctx);
  skills.changed(ctx);
  const turn = skills.turn('/fresh go');
  answers[1]!(listed('fresh'));
  answers[0]!(listed('stale'));

  expect(await turn).toEqual([
    { type: 'text', text: '$fresh go', text_elements: [] },
    { type: 'skill', name: 'fresh', path: '/skills/fresh/SKILL.md' },
  ]);
  await Bun.sleep(0);
  expect(menus.map((menu) => menu.map((command) => command.name))).toEqual([['fresh']]);
  expect(skills.steer('/stale x')).toEqual([{ type: 'text', text: '/stale x', text_elements: [] }]);
});

test('a turn waiting on the skills list also waits for a reload asked meanwhile', async () => {
  const answers: ((value: CodexSkillsListed) => void)[] = [];
  const rpc = { request: () => new Promise((resolve) => answers.push(resolve)) } as unknown as CodexRpc;
  const ctx = { thread: { cwd: '/work' }, commands: () => {}, log: () => {} } as unknown as SessionContext;
  const skills = new CodexSkillCommands(() => rpc);

  skills.opened(rpc, ctx);
  const turn = skills.turn('/fresh go');
  skills.changed(ctx);
  answers[0]!(listed('fresh'));
  await Bun.sleep(0);
  answers[1]!(listed('fresh'));

  expect(await turn).toEqual([
    { type: 'text', text: '$fresh go', text_elements: [] },
    { type: 'skill', name: 'fresh', path: '/skills/fresh/SKILL.md' },
  ]);
});
