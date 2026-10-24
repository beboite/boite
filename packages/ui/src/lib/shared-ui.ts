import type { SharedBoardCard, SharedProjectRef, Todo } from '@boite/contracts';

export function sameSharedProject(a: SharedProjectRef, b: SharedProjectRef): boolean {
  return a.ownerCoreId === b.ownerCoreId && a.coreId === b.coreId && a.projectId === b.projectId;
}

/** Rendering projection only. Mutations keep the association and canonical worker ref. */
export function sharedTodo(card: SharedBoardCard, projectId: string, sharedProjectId: string): Todo {
  return { id: card.id, projectId, threadId: null, text: card.text, status: card.status, goalThreadId: card.assignment?.worker.threadId ?? null,
    ...(card.goal ? {goal: card.goal} : {}), createdAt: card.createdAt, updatedAt: card.updatedAt, shared: {sharedProjectId, card} };
}
