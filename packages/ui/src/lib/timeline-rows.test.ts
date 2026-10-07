import { expect, test } from 'vitest';
import type { MemoryEvent, Message, MessagePart } from '@boite/contracts';
import { heavyThread } from './fake-client/heavy-thread';
import { memoryPartRuns } from './memory-timeline';
import { partRuns } from './tool-groups';
import { CUT_FROM, ROW_PARTS, TimelineRows, rowCuts, rowEstimate, rowIndexOf } from './timeline-rows';

const tool = (id: string): MessagePart => ({ type: 'tool', toolId: id, name: 'Bash', input: { command: `echo ${id}` }, output: 'ok', status: 'done' });
const text = (value: string): MessagePart => ({ type: 'text', text: value });

function message(id: string, parts: MessagePart[], role: Message['role'] = 'assistant'): Message {
  return { id, threadId: 't-1', turnId: `turn-${id}`, role, parts, state: 'complete', createdAt: 0 };
}

/** A turn of work: `runs` runs of `calls` calls, a paragraph in front of each and one to close. */
function work(runs: number, calls: number): MessagePart[] {
  const parts: MessagePart[] = [];
  for (let run = 0; run < runs; run += 1) {
    parts.push(text(`paragraph ${run}`));
    for (let call = 0; call < calls; call += 1) parts.push(tool(`k-${run}-${call}`));
  }
  parts.push(text('done'));
  return parts;
}

test('a message is one row until it is long, then it is cut in front of its paragraphs', () => {
  const short = message('m-short', work(4, 9));
  const long = message('m-long', work(30, 9));
  expect(short.parts.length).toBeLessThanOrEqual(CUT_FROM);
  const rows = new TimelineRows().build([short, long]);

  expect(rows[0]).toMatchObject({ id: 'm-short', from: 0, to: short.parts.length, first: true, last: true });
  const cut = rows.slice(1);
  expect(cut.length).toBeGreaterThan(5);
  // The first row keeps the message's id: an anchor, a jump or a saved height by message still finds it.
  expect(cut.map(row => row.id)).toEqual(['m-long', ...cut.slice(1).map((_, index) => `m-long#${index + 1}`)]);
  expect(cut.map(row => row.first)).toEqual(cut.map((_, index) => index === 0));
  expect(cut.map(row => row.last)).toEqual(cut.map((_, index) => index === cut.length - 1));
  // Every part is drawn once, in order, and each row but the last holds a row's worth.
  expect(cut[0]!.from).toBe(0);
  expect(cut.at(-1)!.to).toBe(long.parts.length);
  cut.slice(1).forEach((row, index) => {
    expect(row.from).toBe(cut[index]!.to);
    expect(long.parts[row.from]!.type).toBe('text');
    expect(cut[index]!.to - cut[index]!.from).toBeGreaterThanOrEqual(ROW_PARTS);
  });
});

test('the rows of a cut message draw the runs the whole message drew', () => {
  const thread = heavyThread();
  let cutMessages = 0;
  for (const whole of thread.messages) {
    const rows = new TimelineRows().build([whole]);
    if (rows.length > 1) cutMessages += 1;
    expect(rows.flatMap(row => memoryPartRuns(whole.parts, [], row.from, row.to))).toEqual(partRuns(whole.parts));
  }
  expect(cutMessages).toBeGreaterThan(5);
});

test('blank text, a hidden marker, a noticed part and the last part never start a row', () => {
  const parts = work(1, ROW_PARTS + 30);
  // Past a row's worth of calls: a blank paragraph, a goal marker alone, then a real one.
  parts.splice(ROW_PARTS + 4, 0, text('   '));
  parts.splice(ROW_PARTS + 8, 0, text('[BOITE_GOAL_COMPLETE]'));
  parts.splice(ROW_PARTS + 12, 0, text('noticed'));
  parts.splice(ROW_PARTS + 16, 0, text('a real paragraph'));
  const long = message('m-1', parts);
  expect(rowCuts(long)).toEqual([ROW_PARTS + 12]);
  // A memory notice anchored on a paragraph keeps it in the row before.
  expect(rowCuts(long, new Set([ROW_PARTS + 12]))).toEqual([ROW_PARTS + 16]);
  const notice = { at: 1, kind: 'killed', anchor: { messageId: 'm-1', partIndex: ROW_PARTS + 12 } } as unknown as MemoryEvent;
  expect(new TimelineRows().build([long], new Map([['m-1', [notice]]])).map(row => row.from)).toEqual([0, ROW_PARTS + 16]);
  // The closing paragraph is the one an answer may still be writing: it is not read.
  const closing = message('m-2', [...Array.from({ length: CUT_FROM + 6 }, (_, index) => tool(`k-${index}`)), text('still writing')]);
  expect(rowCuts(closing)).toEqual([]);
  // A prompt is never cut, whatever it carries.
  expect(rowCuts(message('m-3', work(30, 9), 'user'))).toEqual([]);
});

test('rows that did not change stay the same objects, and a part arriving touches only the last row', () => {
  // Twenty-one runs of ten parts: the closing paragraph sits ten parts into the last row.
  const steady = message('m-steady', work(21, 9));
  const growing = message('m-growing', work(21, 9));
  const builder = new TimelineRows();
  const before = builder.build([steady, growing]);
  expect(builder.build([steady, growing])).toBe(before);
  expect(builder.changedFrom).toBe(before.length);

  growing.parts.push(tool('k-new'));
  const after = builder.build([steady, growing]);
  expect(after).not.toBe(before);
  expect(after).toHaveLength(before.length);
  after.slice(0, -1).forEach((row, index) => expect(row).toBe(before[index]));
  expect(after.at(-1)).not.toBe(before.at(-1));
  expect(after.at(-1)!.to).toBe(growing.parts.length);
  expect(builder.changedFrom).toBe(before.length - 1);
  expect(builder.order).toBe(after.map(row => row.id).join('\0'));

  // A paragraph a row's worth further on starts the next row once a part follows it.
  for (let call = 0; call < ROW_PARTS; call += 1) growing.parts.push(tool(`k-more-${call}`));
  growing.parts.push(text('the next paragraph'));
  expect(builder.build([steady, growing])).toHaveLength(after.length);
  growing.parts.push(tool('k-last'));
  const cut = builder.build([steady, growing]);
  expect(cut).toHaveLength(after.length + 1);
  expect(cut.at(-1)).toMatchObject({ from: growing.parts.length - 2, to: growing.parts.length, first: false, last: true });
  expect(cut.at(-2)!.last).toBe(false);
  expect(builder.changedFrom).toBe(after.length - 1);
});

test('a part is found in the row that draws it, and a cut row is estimated by what it holds', () => {
  const long = message('m-long', work(30, 9));
  const rows = new TimelineRows().build([message('m-first', [text('hello')]), long]);
  expect(rowIndexOf(rows, 'm-long')).toBe(1);
  expect(rowIndexOf(rows, 'm-missing')).toBe(-1);
  for (const [index, row] of rows.entries()) {
    if (row.message !== long) continue;
    expect(rowIndexOf(rows, 'm-long', row.from)).toBe(index);
    expect(rowIndexOf(rows, 'm-long', row.to - 1)).toBe(index);
  }
  expect(rowEstimate(rows[0]!, 80)).toBe(80);
  expect(rowEstimate(rows[1]!, 80)).toBeGreaterThan(80);
});

test('the heavy thread is the 11.5 MiB conversation it stands for, the same at every build', () => {
  const thread = heavyThread();
  const bytes = new TextEncoder().encode(JSON.stringify(thread.messages)).byteLength / 1048576;
  expect(thread.messages).toHaveLength(40);
  expect(bytes).toBeGreaterThan(11);
  expect(bytes).toBeLessThan(12);
  expect(Math.max(...thread.messages.map(message => message.parts.length))).toBeGreaterThan(1000);
  expect(JSON.stringify(heavyThread().messages.at(-2))).toBe(JSON.stringify(thread.messages.at(-2)));
});
