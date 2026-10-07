import { describe, expect, test } from 'bun:test';
import { resumeAfterUpdate } from '../src/providers/update-resume.ts';

describe('the note a turn paused for an agent update resumes with', () => {
  test('names a move only when the version moved, and never claims one that did not happen', () => {
    expect(resumeAfterUpdate('Codex', '1.0.0', '1.2.0', false)).toMatchObject({
      prompt: expect.stringContaining('to update Codex from 1.0.0 to 1.2.0.'),
      label: 'Resumed after the Codex 1.2.0 update',
    });
    // An updater that found nothing newer: same version before and after.
    const unchanged = resumeAfterUpdate('Codex', '1.2.0', '1.2.0', false);
    expect(unchanged.prompt).toContain('to update Codex. Codex stays on 1.2.0.');
    expect(unchanged.prompt).not.toContain('to 1.2.0');
    expect(unchanged.label).toBe('Resumed after the Codex update');
    // A version that could not be read after the run names none.
    expect(resumeAfterUpdate('Codex', '1.0.0', null, false).label).toBe('Resumed after the Codex update');
    expect(resumeAfterUpdate('Codex', null, '1.2.0', false).prompt).toContain('to update Codex to 1.2.0.');
  });

  test('a failed update says the agent is still on its version, or says nothing of a version it could not read', () => {
    expect(resumeAfterUpdate('Codex', '1.0.0', '1.0.0', true)).toMatchObject({
      prompt: expect.stringContaining('the update failed; Codex is still 1.0.0.'),
      label: 'Resumed: the Codex update failed',
    });
    expect(resumeAfterUpdate('Codex', '1.0.0', null, true).prompt).toContain('the update failed. Continue');
  });
});
