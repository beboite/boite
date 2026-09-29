import { describe, expect, it } from 'vitest';
import { describeTool, fileName, partialSummaryOf, permissionSentence, summaryOf } from './tool-summary';

describe('describeTool', () => {
  it('reads Claude tools by name', () => {
    expect(describeTool('Bash', { command: 'bun test\nextra', description: 'Run tests' })).toEqual({
      family: 'command',
      subject: 'bun test\nextra',
      change: null
    });
    expect(describeTool('Edit', { file_path: 'C:/repo/src/run.ts', old_string: 'a', new_string: 'b' })).toEqual({
      family: 'edit',
      subject: 'C:/repo/src/run.ts',
      change: { path: 'C:/repo/src/run.ts', oldText: 'a', newText: 'b' }
    });
    expect(describeTool('Write', { file_path: '/tmp/notes.md', content: '# Notes' }).change).toEqual({
      path: '/tmp/notes.md',
      oldText: '',
      newText: '# Notes'
    });
    expect(describeTool('WebFetch', { url: 'https://example.com/a', prompt: 'read' })).toMatchObject({ family: 'fetch', subject: 'https://example.com/a' });
    expect(describeTool('Task', { description: 'Find the bug', prompt: 'long\nbrief' })).toMatchObject({ family: 'agent', subject: 'Find the bug' });
  });

  it('reads the two Codex approvals', () => {
    expect(describeTool('Bash', { command: ['git', 'status'], cwd: '/repo' })).toMatchObject({ family: 'command', subject: 'git status' });
    expect(describeTool('ApplyPatch', { grantRoot: '/repo/src' })).toMatchObject({ family: 'edit', subject: '/repo/src', change: null });
    expect(describeTool('ApplyPatch', {})).toMatchObject({ family: 'edit', subject: '', change: null });
  });

  it('falls back on the input shape for an ACP title', () => {
    expect(describeTool('Run `ls -la`', { command: 'ls -la' }).family).toBe('command');
    expect(describeTool('Edit src/app.ts', { path: 'src/app.ts', old_string: 'x', new_string: 'y' }).family).toBe('edit');
    expect(describeTool('Writing notes.md', { path: 'notes.md', contents: 'hi' })).toMatchObject({
      family: 'write',
      change: { path: 'notes.md', oldText: '', newText: 'hi' }
    });
    expect(describeTool('Fetching docs', { url: 'https://docs.example.org' }).family).toBe('fetch');
    expect(describeTool('Searching', { pattern: 'TODO' })).toMatchObject({ family: 'search', subject: 'TODO' });
  });

  it('names an unknown tool as other', () => {
    expect(describeTool('mcp__weather__forecast', { city: 'Lyon' })).toMatchObject({ family: 'other', subject: 'Lyon' });
    expect(describeTool('Mystery', null)).toEqual({ family: 'other', subject: '', change: null });
  });
});

describe('permissionSentence', () => {
  it('says what the agent will do', () => {
    expect(permissionSentence('Bash', { command: 'rm -rf dist' })).toBe('Run a command');
    expect(permissionSentence('Edit', { file_path: 'C:\\repo\\src\\run.ts', old_string: 'a', new_string: 'b' })).toBe('Change run.ts');
    expect(permissionSentence('Write', { file_path: '/tmp/notes.md', content: '' })).toBe('Create or replace notes.md');
    expect(permissionSentence('Read', { file_path: '/repo/.env' })).toBe('Read .env');
    expect(permissionSentence('WebFetch', { url: 'https://example.com/page?q=1' })).toBe('Open example.com');
    expect(permissionSentence('WebSearch', { query: 'bun ffi' })).toBe('Search the web for bun ffi');
    expect(permissionSentence('Grep', { pattern: 'TODO' })).toBe('Search the files for TODO');
    expect(permissionSentence('Task', { description: 'x' })).toBe('Start a helper agent');
  });

  it('reads the Codex file change with and without a root', () => {
    expect(permissionSentence('ApplyPatch', { grantRoot: '/repo/src' })).toBe('Write files in /repo/src from now on');
    expect(permissionSentence('ApplyPatch', {})).toBe('Change files');
  });

  it('names the tool when it cannot tell', () => {
    expect(permissionSentence('mcp__weather__forecast', { city: 'Lyon' })).toBe('Use its mcp__weather__forecast tool');
  });
});

describe('summaries', () => {
  it('keeps the first line of the first known key', () => {
    expect(summaryOf({ description: 'later', command: 'echo hi\necho there' })).toBe('echo hi');
    expect(summaryOf('plain')).toBe('plain');
    expect(summaryOf(42)).toBe('');
  });

  it('reads a half-typed JSON object', () => {
    expect(partialSummaryOf('{"command": "bun run te')).toBe('bun run te');
    expect(partialSummaryOf('{"comm')).toBe('');
  });

  it('cuts a path to its file name', () => {
    expect(fileName('C:\\a\\b.ts')).toBe('b.ts');
    expect(fileName('/a/b/')).toBe('b');
  });
});
