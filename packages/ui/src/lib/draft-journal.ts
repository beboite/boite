/** A completed strict transaction is the durable checkpoint for unsent messages. */
const DATABASE = 'boite-unsent-v1';
let database: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    let leaving = false;
    const timer = setTimeout(() => fail(new Error('Draft journal did not open within 3 seconds')), 3000);
    const close = () => {
      leaving = true;
      clearTimeout(timer);
      request.transaction?.abort();
      try { request.result.close(); } catch { /* The database is still opening. */ }
      database = null;
    };
    const fail = (error: unknown) => { close(); window.removeEventListener('pagehide', close); reject(error); };
    window.addEventListener('pagehide', close, { once: true });
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => {
      clearTimeout(timer);
      const db = request.result;
      if (leaving) { db.close(); reject(new Error('Page closed while opening the draft journal')); return; }
      db.onversionchange = () => { db.close(); database = null; };
      resolve(db);
    };
    request.onblocked = () => fail(new Error('Draft journal is blocked by another page'));
    request.onerror = () => fail(request.error);
  });
}

export async function readDraftJournal(key: string): Promise<unknown> {
  if (typeof indexedDB === 'undefined') return null;
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('drafts', 'readonly');
    const timer = setTimeout(() => transaction.abort(), 3000);
    const request = transaction.objectStore('drafts').get(key);
    transaction.oncomplete = () => { clearTimeout(timer); resolve(request.result); };
    transaction.onabort = () => { clearTimeout(timer); reject(transaction.error); };
  });
}

export async function writeDraftJournal(key: string, value: unknown): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('drafts', 'readwrite', { durability: 'strict' });
    const timer = setTimeout(() => transaction.abort(), 3000);
    transaction.objectStore('drafts').put(value, key);
    transaction.oncomplete = () => { clearTimeout(timer); resolve(); };
    transaction.onabort = () => { clearTimeout(timer); reject(transaction.error ?? new Error('Draft journal write aborted or timed out')); };
  });
}
