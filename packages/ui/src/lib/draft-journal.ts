/** A completed strict transaction is the durable checkpoint for unsent messages. */
const DATABASE = 'boite-unsent-v1';
let database: Promise<IDBDatabase> | null = null;
/** The connection `database` resolved to, so a late close of an older one forgets nothing. */
let current: IDBDatabase | null = null;

/** The next operation opens a fresh connection when `db` is the one cached. */
function forget(db: IDBDatabase): void {
  if (current !== db) return;
  current = null;
  database = null;
}

function closedConnection(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'InvalidStateError';
}

function abortPending(transaction: IDBTransaction | null): void {
  try { transaction?.abort(); }
  catch (error) {
    // Commit can precede the completion event, leaving its timeout queued.
    if (!(error instanceof DOMException && error.name === 'InvalidStateError')) throw error;
  }
}

/** How long one operation waits on the journal before it fails with a `TimeoutError` DOMException: slow, not refused. */
const WAIT_MS = 3000;
const timedOut = (what: string) => new DOMException(`Draft journal did not ${what} within ${WAIT_MS / 1000} seconds`, 'TimeoutError');

/**
 * The open has no deadline of its own: a cold profile on a busy machine can
 * take longer than one caller waits, and abandoning it made every retry start
 * from scratch. The next operation picks up the same request.
 */
function open(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    let leaving = false;
    const close = () => {
      leaving = true;
      abortPending(request.transaction);
      try { request.result.close(); } catch { /* The database is still opening. */ }
      current = null;
      database = null;
    };
    const fail = (error: unknown) => { close(); window.removeEventListener('pagehide', close); reject(error); };
    window.addEventListener('pagehide', close, { once: true });
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => {
      const db = request.result;
      if (leaving) { db.close(); reject(new Error('Page closed while opening the draft journal')); return; }
      current = db;
      db.onversionchange = () => { db.close(); forget(db); };
      // The browser can drop the connection itself: storage pressure, site data cleared, a frozen tab.
      db.onclose = () => forget(db);
      resolve(db);
    };
    request.onblocked = () => fail(new Error('Draft journal is blocked by another page'));
    request.onerror = () => fail(request.error);
  });
}

/**
 * Runs `operation` on the cached connection. A connection the browser closed
 * without a close event refuses new transactions with InvalidStateError: the
 * operation runs once more on a fresh one, instead of every later save failing
 * until the page reloads.
 */
async function withDatabase<T>(operation: (db: IDBDatabase) => Promise<T>, retry = true): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const db = await Promise.race([open(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timedOut('open')), WAIT_MS); })])
    .finally(() => clearTimeout(timer));
  try { return await operation(db); }
  catch (error) {
    if (!closedConnection(error)) throw error;
    forget(db);
    if (!retry) throw error;
    return withDatabase(operation, false);
  }
}

export async function readDraftJournal(key: string): Promise<unknown> {
  if (typeof indexedDB === 'undefined') return null;
  return withDatabase(db => new Promise((resolve, reject) => {
    const transaction = db.transaction('drafts', 'readonly');
    let late = false;
    const timer = setTimeout(() => { late = true; abortPending(transaction); }, WAIT_MS);
    const request = transaction.objectStore('drafts').get(key);
    transaction.oncomplete = () => { clearTimeout(timer); resolve(request.result); };
    transaction.onabort = () => { clearTimeout(timer); reject(late ? timedOut('read') : transaction.error); };
  }));
}

export async function writeDraftJournal(key: string, value: unknown): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  return withDatabase(db => new Promise((resolve, reject) => {
    const transaction = db.transaction('drafts', 'readwrite', { durability: 'strict' });
    const timer = setTimeout(() => abortPending(transaction), WAIT_MS);
    transaction.objectStore('drafts').put(value, key);
    transaction.oncomplete = () => { clearTimeout(timer); resolve(); };
    transaction.onabort = () => { clearTimeout(timer); reject(transaction.error ?? new Error('Draft journal write aborted or timed out')); };
  }));
}
