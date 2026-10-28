import { describe, expect, test } from 'vitest';
import { FileDocument, FileDocuments, type FileWrite } from './file-documents.svelte';

/** A promise answered from outside, the way a held core call is. */
function held<T>(): { promise: Promise<T>; answer: (value: T) => void } {
  let answer!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { answer = resolve; });
  return { promise, answer };
}

const turns = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const ok = (text: string): FileWrite => ({ ok: true, value: { bytes: text.length, modifiedAt: 1 } });
const same = (text: string) => text;

/** Records each write the document sends, held until the test answers it. */
function writes() {
  const sent: Array<{ text: string; answer: (value: FileWrite) => void }> = [];
  const send = (text: string) => {
    const call = held<FileWrite>();
    sent.push({ text, answer: call.answer });
    return call.promise;
  };
  return { sent, send };
}

describe('a file document', () => {
  test('a read that answers after a newer one of the same file leaves the newer text', async () => {
    const document = new FileDocument(() => {});
    // An editor unmounts with its read out, the next one reads again, and the first answer is the last to land.
    const older = held<string>();
    const first = document.read(() => older.promise, same);
    await document.read(async () => 'changed by the agent', same);
    older.answer('before the agent');
    await first;
    expect(document.disk).toBe('changed by the agent');

    // Answered in the order they began, the later one lands last.
    const one = held<string>(), two = held<string>();
    const reads = [document.read(() => one.promise, same), document.read(() => two.promise, same)];
    one.answer('read first');
    two.answer('read last');
    await Promise.all(reads);
    expect(document.disk).toBe('read last');
  });

  test('a read out across a write, at its start or its answer, never takes the disk back', async () => {
    const document = new FileDocument(() => {});
    const { sent, send } = writes();
    await document.read(async () => 'before', same);
    // Begun before the write, answered after it.
    const before = held<string>();
    const across = document.read(() => before.promise, same);
    const saved = document.save('written', send);
    await turns();
    // Begun while the write is out, answered after it.
    const during = held<string>();
    const inside = document.read(() => during.promise, same);
    sent[0]!.answer(ok('written'));
    await saved;
    before.answer('before');
    during.answer('before');
    await Promise.all([across, inside]);
    expect(document.disk).toBe('written');
    // A read that began after the write answered sees a later disk.
    await document.read(async () => 'changed by the agent', same);
    expect(document.disk).toBe('changed by the agent');
  });

  test('a file has one write out at a time: saves asked meanwhile leave as one write of the last text', async () => {
    const document = new FileDocument(() => {});
    const { sent, send } = writes();
    const first = document.save('one', send);
    await turns();
    const second = document.save('two', send);
    const third = document.save('three', send);
    await turns();
    expect(sent.map((write) => write.text)).toEqual(['one']);
    expect(document.outgoing).toBe('three');
    sent[0]!.answer(ok('one'));
    expect((await first).text).toBe('one');
    await turns();
    expect(sent.map((write) => write.text)).toEqual(['one', 'three']);
    sent[1]!.answer(ok('three'));
    expect((await second).text).toBe('three');
    expect((await third).text).toBe('three');
    expect(document.disk).toBe('three');
    expect(document.outgoing).toBeNull();
  });

  test('an edit goes only once no write is out and the disk confirmed its very text', async () => {
    const document = new FileDocument(() => {});
    const { sent, send } = writes();
    await document.read(async () => 'disk', same);
    document.edit('one');
    const saved = document.save('one', send);
    await turns();
    // Typed back to the old disk while the write is out: once it lands, that is an edit.
    document.edit('disk');
    expect(document.draft).toBe('disk');
    sent[0]!.answer(ok('one'));
    await saved;
    expect(document.draft).toBe('disk');
    document.edit('one');
    expect(document.draft).toBeNull();
    // A failed write leaves the disk and the edit.
    document.edit('two');
    const failed = document.save('two', send);
    await turns();
    sent[1]!.answer({ ok: false, error: 'denied' });
    await failed;
    expect(document.disk).toBe('one');
    expect(document.draft).toBe('two');
  });
});

describe('the documents of every thread', () => {
  test('a document stays while a tab shows it or anything of it is out, and its tab closing takes its edit', async () => {
    let shown = true;
    const documents = new FileDocuments(() => shown);
    const document = documents.hold('t-1', 'notes.md');
    const { sent, send } = writes();
    document.edit('typed');
    expect(documents.drafted('t-1')).toBe(true);
    expect(documents.drafted('t-2')).toBe(false);
    const saved = document.save('typed', send);
    await turns();
    documents.close('t-1', 'notes.md');
    shown = false;
    // The write out keeps it: a tab reopened on the file must learn what it wrote.
    expect(documents.get('t-1', 'notes.md')).toBe(document);
    expect(documents.drafted('t-1')).toBe(false);
    sent[0]!.answer(ok('typed'));
    await saved;
    expect(documents.get('t-1', 'notes.md')).toBeUndefined();
  });

  test('a thread forgotten while a write is out keeps that document, and the thread back takes the same one', async () => {
    let shown = true;
    const documents = new FileDocuments(() => shown);
    const document = documents.hold('t-1', 'notes.md');
    const { sent, send } = writes();
    const saved = document.save('typed', send);
    await turns();
    documents.hold('t-1', 'idle.md').edit('only typed');
    // Archived: the layout and every edit go, the write out keeps its owner.
    shown = false;
    documents.forget('t-1');
    expect(documents.drafted('t-1')).toBe(false);
    expect(documents.get('t-1', 'idle.md')).toBeUndefined();
    expect(documents.get('t-1', 'notes.md')).toBe(document);
    // Restored and reopened before the write answered.
    shown = true;
    expect(documents.hold('t-1', 'notes.md')).toBe(document);
    sent[0]!.answer(ok('typed'));
    await saved;
    expect(documents.get('t-1', 'notes.md')?.disk).toBe('typed');
  });
});
