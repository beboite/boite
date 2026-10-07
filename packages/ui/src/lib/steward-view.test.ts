import { expect, test } from 'vitest';
import type { Project, StewardGrant, ThreadSummary } from '@boite/contracts';
import { stewardOfThread, stewardsOf, stewardsWithThreads } from './steward-view';

const thread = (id: string, projectId: string | null, archived = false) => ({ id, projectId, archived, title: id } as unknown as ThreadSummary);
const grant = (threadId: string, projectIds: string[], allProjects = false) => ({ threadId, projectIds, allProjects, capabilities: [], notify: true, grantedAt: 1, updatedAt: 1 } as StewardGrant);
const projects = [{ id: 'boite' }, { id: 'site' }, { id: 'drafts', kind: 'drafts' }] as Project[];

test('a project shows the stewards that cover it, never in the drafts and never once archived', () => {
  const store = {
    projects,
    threads: [thread('night', 'boite'), thread('all', 'site'), thread('old', 'boite', true), thread('work', 'boite')],
    stewards: [grant('night', ['boite']), grant('all', [], true), grant('old', ['site'])]
  };
  expect(stewardsOf(store, 'boite').map(s => s.thread.id)).toEqual(['night', 'all']);
  expect(stewardsOf(store, 'site').map(s => s.thread.id)).toEqual(['all']);
  expect(stewardsOf(store, 'drafts')).toEqual([]);
  expect(stewardsWithThreads(store).map(s => s.thread.id)).toEqual(['night', 'all']);
  // A thread names the steward of its project, never itself.
  expect(stewardOfThread(store, thread('work', 'boite'))?.thread.id).toBe('night');
  expect(stewardOfThread(store, thread('night', 'boite'))?.thread.id).toBe('all');
  // Grants not read yet show nothing.
  expect(stewardsOf({ ...store, stewards: null }, 'boite')).toEqual([]);
});
