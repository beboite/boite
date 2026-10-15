import { Database } from 'bun:sqlite';

export type ArtifactScanReply = { ids: string[] } | { error: string };

const scope = globalThis as unknown as {
  onmessage: ((event: { data: string }) => void) | null;
  postMessage(message: ArtifactScanReply): void;
  close(): void;
};

// Large inline attachments make even a reference-only JSON scan expensive.
// Read through a separate WAL connection so RPC and journal writes can continue.
scope.onmessage = ({ data: path }): void => {
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    // A streaming message keeps its latest parts in streaming_parts until its row is written whole.
    const rows = db.query(`SELECT json_extract(part.value, '$.id') AS id
      FROM messages, json_each(messages.parts) AS part WHERE json_extract(part.value, '$.type') = 'artifact'
      UNION SELECT json_extract(json, '$.id') FROM streaming_parts WHERE json_extract(json, '$.type') = 'artifact'`)
      .all() as { id: string }[];
    scope.postMessage({ ids: rows.map(row => row.id) });
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    db?.close();
    scope.close();
  }
};
