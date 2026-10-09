/*
 * What the companion's agent is given again: the role when the conversation
 * holds another, the memory when it changed since the agent saw it.
 */
import { afterEach, expect, test } from 'vitest';
import { COMPANION_ROLE, MEMORY_AGAIN, promptFor } from './brain';
import { doubtPrimed, hashText, parsePrimed, primingFor, PRIMED_KEY, readPrimed, writePrimed, type Primed } from './priming';

afterEach(() => window.localStorage.clear());

const MEMORY = 'What you remember about the user:\n- Is called Chris';
const record = (memory = MEMORY, role = COMPANION_ROLE): Primed => ({ threadId: 't1', role: hashText(role), memory: hashText(memory), check: false });

test('a new thread gets everything, a thread the record does not know gets the role again', () => {
  expect(primingFor(null, { id: 't1', fresh: true }, COMPANION_ROLE, MEMORY)).toBe('new');
  // Primed before the record existed, maybe with an older role, and its facts maybe lost.
  expect(primingFor(null, { id: 't1', fresh: false }, COMPANION_ROLE, MEMORY)).toBe('role');
  expect(primingFor(record(), { id: 't2', fresh: false }, COMPANION_ROLE, MEMORY)).toBe('role');
  expect(primingFor(record(), { id: 't2', fresh: true }, COMPANION_ROLE, MEMORY)).toBe('new');
  expect(primingFor(record(MEMORY, 'an older role'), { id: 't1', fresh: false }, COMPANION_ROLE, MEMORY)).toBe('role');
});

test('the memory goes again once it changed, or once a reply could not be read', () => {
  // A thread the record knows is not fresh, whatever a late thread list says.
  expect(primingFor(record(), { id: 't1', fresh: true }, COMPANION_ROLE, MEMORY)).toBeNull();
  expect(primingFor(record(), { id: 't1', fresh: false }, COMPANION_ROLE, `${MEMORY}\n- Plays Overwatch`)).toBe('memory');
  expect(primingFor({ ...record(), check: true }, { id: 't1', fresh: false }, COMPANION_ROLE, MEMORY)).toBe('memory');
});

test('the record is stored, read field by field and doubted for its own thread only', () => {
  writePrimed(record());
  expect(readPrimed()).toEqual(record());
  doubtPrimed('t2');
  expect(readPrimed()?.check).toBe(false);
  doubtPrimed('t1');
  expect(readPrimed()?.check).toBe(true);
  expect(parsePrimed({ threadId: 't1', role: 'a' })).toBeNull();
  expect(parsePrimed({ threadId: 't1', role: 'a', memory: 'b', check: 'yes' })).toEqual({ threadId: 't1', role: 'a', memory: 'b', check: false });
  window.localStorage.setItem(PRIMED_KEY, '{broken');
  expect(readPrimed()).toBeNull();
  expect(hashText(COMPANION_ROLE)).toBe(hashText(COMPANION_ROLE));
  expect(hashText('a')).not.toBe(hashText('b'));
});

test('a request carries the role again, or the memory alone, as the priming says', () => {
  const context = { memory: MEMORY, now: new Date(2026, 9, 9, 20, 45), seen: null, projects: ['boite'] };
  const role = promptFor('Hi', { ...context, prime: 'role' });
  expect(role.startsWith(COMPANION_ROLE)).toBe(true);
  expect(role).toContain('This role replaces the one given earlier');
  expect(role).toContain(`${MEMORY}\n\n[Boite's projects: boite.]\n\n---\n\n[Friday 2026-10-09 20:45]\nHi`);
  const memory = promptFor('Hi', { ...context, prime: 'memory' });
  expect(memory).toBe(`${MEMORY_AGAIN}\n${MEMORY}\n\n---\n\n[Friday 2026-10-09 20:45]\nHi`);
  expect(promptFor('Hi', { ...context, prime: 'new' })).not.toContain('This role replaces');
});
