/**
 * What the core knows about stored secrets, never their values: which vault
 * entry is which name, whose it is and when it goes. Written before a value
 * goes into the vault and after it leaves, so every vault entry has a line
 * here and the startup sweep can erase the ones that lost theirs.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectId, ThreadId } from '@boite/contracts';

/** A transit copy: one thread's, erased at the first of archive, removal, 24 h or a restart that lost it. */
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
  version: 1;
  transit: TransitEntry[];
  kept: KeptEntry[];
  cards: OpenCard[];
}

const empty = (): SecretIndexData => ({ version: 1, transit: [], kept: [], cards: [] });

export class SecretIndex {
  readonly file: string;
  #data: SecretIndexData | null = null;

  constructor(readonly dir: string) {
    this.file = join(dir, 'index.json');
  }

  /** Nothing was ever stored: the startup sweep has nothing to read and opens no vault. */
  exists(): boolean {
    return existsSync(this.file);
  }

  get data(): SecretIndexData {
    if (this.#data !== null) return this.#data;
    let parsed: Partial<SecretIndexData> | null = null;
    try { parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<SecretIndexData>; } catch { parsed = null; }
    this.#data = parsed?.version === 1
      ? { version: 1, transit: Array.isArray(parsed.transit) ? parsed.transit : [], kept: Array.isArray(parsed.kept) ? parsed.kept : [], cards: Array.isArray(parsed.cards) ? parsed.cards : [] }
      : empty();
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

  transit(id: string): TransitEntry | undefined {
    return this.data.transit.find(entry => entry.id === id);
  }

  kept(projectId: string, name: string): KeptEntry | undefined {
    return this.data.kept.find(entry => entry.projectId === projectId && entry.name === name);
  }
}
