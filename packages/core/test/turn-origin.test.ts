import { expect, test } from 'bun:test';
import { autonomousSource, originAutomatic, originOperation, type TurnOrigin } from '../src/threads/turn-origin.ts';

test('a turn\'s operation, voice and autonomous source follow from its origin kind, never from its request id', () => {
  const link = { threadId: 'thr_parent', title: 'Parent' } as never;
  const rows: [TurnOrigin, ReturnType<typeof originOperation>, boolean, ReturnType<typeof autonomousSource>][] = [
    [{ kind: 'user', requestId: 'restart_trn_x' }, undefined, false, null],
    [{ kind: 'goal', activity: { kind: 'goal', iteration: 1 } }, undefined, false, 'goal'],
    [{ kind: 'spawned', startedBy: link }, undefined, false, null],
    [{ kind: 'compact', automatic: false }, 'compact', false, null],
    [{ kind: 'compact', automatic: true }, 'compact', true, null],
    [{ kind: 'keepalive' }, 'keepalive', true, null],
    [{ kind: 'resume', reason: 'limit', requestId: 'restart_trn_x' }, 'resume', false, 'resume'],
    [{ kind: 'resume', reason: 'carry-on' }, 'resume', false, 'resume'],
    [{ kind: 'resume', reason: 'handoff', requestId: 'any' }, 'resume', false, null],
    [{ kind: 'resume', reason: 'delegation-restart' }, 'resume', false, null],
    [{ kind: 'delegation' }, 'delegation', false, 'delegation'],
    [{ kind: 'goal-check' }, 'delegation', false, 'delegation'],
    [{ kind: 'coordination' }, 'coordination', false, 'coordination'],
    // A team letter with the owner's post: stored as coordination, admitted as the owner's message.
    [{ kind: 'coordination', owner: true }, 'coordination', false, null],
    [{ kind: 'background' }, 'background', false, 'background'],
    [{ kind: 'pull-request' }, 'pull-request', false, 'pull-request'],
    [{ kind: 'routine', requestId: 'r' }, 'routine', false, null],
    [{ kind: 'event', requestId: 'e' }, 'event', false, null],
  ];
  expect(rows.map(([origin]) => [origin.kind, originOperation(origin), originAutomatic(origin), autonomousSource(origin)]))
    .toEqual(rows.map(([origin, operation, automatic, source]) => [origin.kind, operation, automatic, source]));
});
