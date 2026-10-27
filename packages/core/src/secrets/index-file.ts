/**
 * Pending card locations survive a crash, never secret values. Version 1
 * metadata is retained only until its legacy vault entries can be erased.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectId, ThreadId } from '@boite/contracts';

/** Transit metadata, also used for legacy cleanup. Live values stay in SecretStore memory. */
export interface TransitEntry {
  id: string;
  threadId: ThreadId;
  projectId: ProjectId | null;
  name: string;
  createdAt: number;
  expiresAt: number;
}

/** A key the user kept for a project: under its own vault id, found by name. */
export interface KeptEntry {
  id: string;
  projectId: ProjectId;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/** Where an open card is drawn, so a core that stopped with it open closes it on the next start. */
export interface OpenCard {
  requestId: string;
  threadId: ThreadId;
  messageId: string;
  partIndex: number;
}

export interface SecretIndexData {
  version: 1 | 2;
  transit: TransitEntry[];
  kept: KeptEntry[];
  cards: OpenCard[];
}

const empty = (): SecretIndexData => ({ version: 2, transit: [], kept: [], cards: [] });

export class SecretIndex {
  readonly file: string;
  #data: SecretIndexData | null = null;

  constructor(readonly dir: string) {
    this.file = join(dir, 'index.json');
  }

  /** An old folder can contain orphaned blobs even if its index was lost. */
  exists(): boolean {
    return existsSync(this.dir);
  }

  get data(): SecretIndexData {
    if (this.#data !== null) return this.#data;
    let parsed: Partial<SecretIndexData> | null = null;
    try { parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<SecretIndexData>; } catch { parsed = null; }
    this.#data = parsed?.version === 1 || parsed?.version === 2
      ? { version: parsed.version, transit: Array.isArray(parsed.transit) ? parsed.transit : [], kept: Array.isArray(parsed.kept) ? parsed.kept : [], cards: Array.isArray(parsed.cards) ? parsed.cards : [] }
      : { ...empty(), version: this.exists() ? 1 : 2 };
    return this.#data;
  }

  /** Every change goes to disk at once, through a rename so a crash leaves the old file or the new one. */
  update(change: (data: SecretIndexData) => void): void {
    change(this.data);
    mkdirSync(this.dir, { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.file);
  }
}
