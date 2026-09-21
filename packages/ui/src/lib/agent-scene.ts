import type { AgentsSnapshot, AgentWork } from '@boite/contracts';
import type { AgentSelection } from './agents.svelte';

export interface AgentSceneNode extends AgentSelection { x: number; y: number; label: string; state: AgentWork['status'] | 'idle'; }
export interface AgentSceneLayout { width: number; height: number; nodes: AgentSceneNode[]; }

/** Pure projection: characters follow current work, never invent work for an animation. */
export function agentScene(snapshot: AgentsSnapshot): AgentSceneLayout {
  const width = 960;
  const nodes: AgentSceneNode[] = [];
  const teams = snapshot.teams;
  const groups = snapshot.groups;
  const rowHeight = Math.max(280, 160 + Math.ceil(Math.max(0, ...teams.map(t => t.members.length), ...groups.map(g => g.memberIds.length)) / 3) * 90);
  for (const [index, team] of teams.entries()) nodes.push({ kind: 'team', id: team.id, label: team.name, state: 'idle', x: 240 + index % 2 * 480, y: 50 + Math.floor(index / 2) * rowHeight });
  const groupTop = Math.ceil(teams.length / 2) * rowHeight + 50;
  for (const [index, group] of groups.entries()) nodes.push({ kind: 'group', id: group.id, label: group.name, state: 'idle', x: 240 + index % 2 * 480, y: groupTop + Math.floor(index / 2) * rowHeight });
  const lobbyTop = groupTop + Math.ceil(groups.length / 2) * rowHeight;
  const seats = new Map<string, number>();
  let idle = 0;
  for (const agent of snapshot.profiles.filter(a => a.status !== 'archived')) {
    const work = snapshot.work.find(w => w.agentId === agent.id && ['running', 'waiting', 'interrupted'].includes(w.status)) ?? snapshot.work.find(w => w.agentId === agent.id && w.status === 'pending');
    const mission = work?.scope.kind === 'mission' ? snapshot.missions.find(m => m.id === work.scope.id) : null;
    const targetId = work?.scope.kind === 'group' ? work.scope.id : mission?.teamId ?? teams.find(t => t.members.some(m => m.agentId === agent.id))?.id;
    const target = nodes.find(n => n.id === targetId);
    const seat = seats.get(targetId ?? '') ?? 0;
    if (targetId) seats.set(targetId, seat + 1);
    const x = target ? target.x + (seat % 3 - 1) * 115 : 90 + idle % 6 * 155;
    const y = target ? target.y + 85 + Math.floor(seat / 3) * 90 : lobbyTop + Math.floor(idle++ / 6) * 90;
    nodes.push({ kind: 'profile', id: agent.id, label: agent.name, x, y, state: agent.status === 'paused' ? 'paused' : work?.status ?? 'idle' });
  }
  return { width, height: Math.max(400, Math.max(0, ...nodes.map(n => n.y)) + 125), nodes };
}
