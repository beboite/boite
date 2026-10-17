import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { ATTACHMENT_MAX_BYTES } from '@boite/contracts';
import { dropKind, mimeFor, receiveDroppedFiles, routeDrop, type DroppedEntry } from './native-drop';

const IMAGE: DroppedEntry = { path: 'C:\\Users\\me\\Pictures\\shot.png', name: 'shot.png', directory: false, size: 4 };
const FOLDER: DroppedEntry = { path: 'C:\\Dev\\app', name: 'app', directory: true, size: 0 };

function shell(entries: DroppedEntry[]) {
  invoke.mockImplementation(async (command, args) => {
    if (command === 'dropped_entries') return entries.filter((entry) => (args?.paths as string[]).includes(entry.path));
    if (command === 'dropped_file') return new Uint8Array([1, 2, 3, 4]).buffer;
    throw new Error(`unexpected ${command}`);
  });
}

describe('a drop from the system on the shell window', () => {
  let release: (() => void) | null = null;
  beforeEach(() => { invoke.mockReset(); });
  afterEach(() => { release?.(); release = null; });

  test('an image goes to the composer and never adds a project or changes machine', async () => {
    shell([IMAGE]);
    const taken: File[] = [];
    release = receiveDroppedFiles((files) => { taken.push(...files); });
    const addProjects = vi.fn(async () => undefined);
    const fail = vi.fn();

    await routeDrop([IMAGE.path], { addProjects, fail });

    expect(addProjects).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(taken.map((file) => [file.name, file.type, file.size])).toEqual([['shot.png', 'image/png', 4]]);
    expect(invoke).toHaveBeenCalledWith('dropped_file', { path: IMAGE.path });
  });

  test('a folder still becomes a project, and files dropped with it are attached', async () => {
    shell([IMAGE, FOLDER]);
    const taken: File[] = [];
    release = receiveDroppedFiles((files) => { taken.push(...files); });
    const addProjects = vi.fn(async () => undefined);

    await routeDrop([IMAGE.path, FOLDER.path], { addProjects, fail: vi.fn() });

    expect(addProjects).toHaveBeenCalledWith([FOLDER.path]);
    expect(taken).toHaveLength(1);
  });

  test('with no conversation open, the files are refused with a reason and nothing else happens', async () => {
    shell([IMAGE]);
    const addProjects = vi.fn(async () => undefined);
    const fail = vi.fn();

    await routeDrop([IMAGE.path], { addProjects, fail });

    expect(fail).toHaveBeenCalledWith(expect.stringMatching(/conversation/i));
    expect(addProjects).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('dropped_file', expect.anything());
  });

  test('an oversized file is refused before its bytes are read', async () => {
    const big = { ...IMAGE, size: ATTACHMENT_MAX_BYTES + 1 };
    shell([big]);
    const take = vi.fn();
    release = receiveDroppedFiles(take);
    const fail = vi.fn();

    await routeDrop([big.path], { addProjects: vi.fn(async () => undefined), fail });

    expect(fail).toHaveBeenCalledWith(expect.stringContaining('shot.png'));
    expect(take).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('dropped_file', expect.anything());
  });

  test('the overlay offers a project only when a folder is dragged', () => {
    expect(dropKind([IMAGE])).toBe('attach');
    expect(dropKind([IMAGE, FOLDER])).toBe('project');
    expect(dropKind([])).toBeNull();
    expect(mimeFor('A.JPG')).toBe('image/jpeg');
    expect(mimeFor('notes')).toBe('');
  });
});
