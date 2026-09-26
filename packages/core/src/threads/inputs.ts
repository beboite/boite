import { mkdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { attachmentError } from '@boite/contracts';
import type { Attachment, Project, ProviderDescriptor } from '@boite/contracts';
import { messageOf, refused } from '../errors.ts';

export function titleOf(title: string | undefined): string {
  return title !== undefined && title.length > 0 ? title : 'New thread';
}

/** What a folder name cannot hold on Windows, the strictest of the three. */
const UNSAFE_NAME = /[<>:"/\\|?*\u0000-\u001f]/g;

/**
 * A draft's folder name: the local date, then the first words of its title,
 * `2026-09-23 Plan the trip to Lisbon`. The date comes first so the folder
 * sorts by day and a title can never make a reserved name like `CON`.
 */
export function draftFolderName(title: string, at: Date): string {
  const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
  const words = title.replace(UNSAFE_NAME, ' ').split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
  const cut = words.slice(0, 60).replace(/[. ]+$/, '');
  return cut.length > 0 ? `${day} ${cut}` : day;
}

/**
 * A new folder for a draft in the drafts directory, never an existing one:
 * two drafts with the same title on the same day get `name 2`, `name 3`.
 */
export function makeDraftFolder(root: string, name: string): string {
  mkdirSync(root, { recursive: true });
  for (let index = 1; index < 1000; index += 1) {
    const path = join(root, index === 1 ? name : `${name} ${index}`);
    try {
      mkdirSync(path);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw refused(`the draft's folder cannot be made: ${messageOf(error)}`, { path });
      }
    }
  }
  throw refused('every folder name for this draft is taken', { root, name });
}

/**
 * The working directory a client asked for, resolved and kept inside the
 * project. The agent runs there, so an unchecked string is a way to point any
 * process at any directory on the machine: the worktree path the core builds
 * itself is the one exception, and it never comes through `params.cwd`.
 */
export function checkCwd(project: Project, cwd: string): string {
  const resolved = resolve(cwd);
  const inside = relative(resolve(project.path), resolved);
  if (inside.startsWith('..') || resolve(inside) === inside) {
    throw refused('the working directory must be inside the project', {
      cwd: resolved,
      projectPath: project.path,
    });
  }
  let stat;
  try {
    stat = statSync(resolved);
  } catch (error) {
    throw refused(`the working directory cannot be read: ${messageOf(error)}`, { cwd: resolved });
  }
  if (!stat.isDirectory()) throw refused('the working directory is not a directory', { cwd: resolved });
  return resolved;
}

/**
 * The attachments of a turn, or the refusal: the provider takes none, too
 * many, a format no agent reads, a body that is not base64, one over the cap.
 * Each refusal names the attachment by its index and what was expected.
 */
export function checkAttachmentArray(attachments: Attachment[]): void {
  if (!Array.isArray(attachments)) throw refused('attachments must be an array');
  attachments.forEach((attachment, index) => {
    if (!attachment || typeof attachment !== 'object') throw refused(`attachment ${index + 1}: expected an object`);
  });
}

export function checkAttachments(attachments: Attachment[], provider: ProviderDescriptor): void {
  const error = attachmentError(attachments, provider);
  if (error) throw refused(error.message, error.data);
}
