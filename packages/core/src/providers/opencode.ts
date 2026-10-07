/**
 * What the core knows about OpenCode beyond its two descriptors. OpenCode 1
 * (`opencode`) and OpenCode 2 (`opencode-v2`) are two programs with one
 * gateway, one model naming and one subscription, so what is read off a model
 * id or billed to OpenCode Go is the same for both. Where they differ is where
 * the login lives: version 1 writes `auth.json`, version 2 a `credential`
 * table in `opencode.db`.
 */
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderId } from '@boite/contracts';

export const OPENCODE_V2: ProviderId = 'opencode-v2';

export function isOpenCode(providerId: ProviderId): boolean {
  return providerId === 'opencode' || providerId === OPENCODE_V2;
}

/**
 * The API key OpenCode 2 stored for one integration (`opencode-go`), null when
 * there is none. `dataHome` is the account's `XDG_DATA_HOME`. The value column
 * is JSON, `{ "type": "key", "key": "..." }` for a key sign-in.
 */
export function openCode2Key(dataHome: string, integration: string): string | null {
  const file = join(dataHome, 'opencode', 'opencode.db');
  if (!existsSync(file)) return null;
  let db: Database | null = null;
  try {
    db = new Database(file, { readonly: true });
    const row = db
      .query('SELECT value FROM credential WHERE integration_id = ? AND active = 1 ORDER BY time_updated DESC LIMIT 1')
      .get(integration) as { value?: unknown } | null;
    if (row === null || typeof row.value !== 'string') return null;
    const value = JSON.parse(row.value) as { type?: unknown; key?: unknown };
    return value.type === 'key' && typeof value.key === 'string' && value.key.length > 0 ? value.key : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
