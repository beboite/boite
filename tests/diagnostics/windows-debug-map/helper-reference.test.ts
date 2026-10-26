import {expect, test} from 'bun:test';
import {HelperReferenceSlot, otherReferencesClosed, type ReferenceAnchor} from './helper-reference.ts';
import {OwnershipLedger, type HandleIdentity} from './ownership-ledger.ts';
import type {Membership, LedgerRow} from './target-topology.ts';

const helper = {pid: 11, created: '100'};
const live: Membership = {...helper, role: 'harness-main', owner: 'harness', threadId: 'trial', threadJob: '50',
  jobKey: 4, globalJob: '41', nestingRefused: false, threadMember: 1, globalMember: 1};
function fixture() {
  const events: Record<string, unknown>[] = [], ledger = new OwnershipLedger('harness', e => events.push(e));
  let identity: HandleIdentity = {pid: 11, incarnation: '100', exitCode: 259}, closes = 0, queries = 0, success = true;
  ledger.acquire(8, 11, identity); ledger.stage(8, 'tracked');
  const slot = new HelperReferenceSlot({role: 'harness-main', owner: 'harness', event: e => {events.push(e);},
    reference: handle => {
      const entry = ledger.owned.get(handle); if (!entry || entry.closeFailed) return;
      queries++; return {entry: {...entry}, identity: {...identity}, complete: ledger.complete};
    }, close: (handle, id) => {
      closes++; ledger.close(handle, success, success ? 0 : 6);
      return {id, success, error: success ? 0 : 6, wallMs: Date.now()};
    }});
  const anchor: ReferenceAnchor = {nonce: '01'.repeat(16), helper, owner: 'harness', id: ledger.owned.get(8)!.id,
    handle: 8, threadId: 'trial', threadJob: '50', jobKey: 4, globalJob: '41', nestingRefused: false, deadline: Date.now() + 1000};
  const transfer = () => {identity.exitCode = 125; return slot.retain(8, 11, '100', 'trial', 125, anchor);};
  return {slot, anchor, ledger, events, transfer, closes: () => closes, queries: () => queries,
    identity: (change: Partial<HandleIdentity>) => {identity = {...identity, ...change};}, failClose: () => {success = false;}};
}

test('one captured reference changes custody only at normal exit; successful actual close is once', () => {
  const f = fixture();
  try {
    f.slot.arm(f.anchor, live); expect(f.transfer()).toBe(true);
    const sample = f.slot.sample(); expect(sample.identity.exitCode).toBe(125); expect(sample.id).toBe(f.anchor.id);
    expect(f.closes()).toBe(0); expect(f.slot.close()).toMatchObject({success: true, reason: 'observed'});
    const queries = f.queries(); expect(() => f.slot.sample()).toThrow(); expect(() => f.slot.close()).toThrow();
    f.slot.cleanup(); expect(f.closes()).toBe(1); expect(f.queries()).toBe(queries);
    expect(f.events.filter(e => e.event === 'helper-reference-held')).toHaveLength(1);
  } finally {f.slot.cleanup();}
});

test('stale incarnation, wrong owner/job and duplicate arm/transfer never grant a valid sample', () => {
  for (const change of [{helper: {...helper, created: '101'}}, {owner: 'launcher'}, {id: 'other'}, {jobKey: 5}, {nonce: 'bad'}]) {
    const f = fixture();
    try {expect(() => f.slot.arm({...f.anchor, ...change}, live)).toThrow(); expect(f.closes()).toBe(0);}
    finally {f.slot.cleanup();}
  }
  for (const duplicate of ['arm', 'transfer']) {
    const f = fixture();
    try {
      f.slot.arm(f.anchor, live); expect(f.transfer()).toBe(true);
      if (duplicate === 'arm') expect(() => f.slot.arm(f.anchor, live)).toThrow('duplicate arm');
      else expect(f.transfer()).toBe(true); // Custody remains with slot; no second native close at the hook.
      expect(() => f.slot.sample()).toThrow('duplicate'); f.slot.cleanup(); expect(f.closes()).toBe(1);
    } finally {f.slot.cleanup();}
  }
  const f = fixture();
  try {
    f.slot.arm(f.anchor, live); f.identity({exitCode: 125});
    expect(f.slot.retain(8, 11, '100', 'trial', 125, {...f.anchor, jobKey: 5})).toBe(false);
    expect(() => f.slot.sample()).toThrow(); expect(f.closes()).toBe(0);
  } finally {f.slot.cleanup();}
});

test('identity loss, incomplete ledger or an external early close never closes an undecidable value', () => {
  for (const fault of ['pid', 'created', 'incomplete', 'closed']) {
    const f = fixture();
    try {
      f.slot.arm(f.anchor, live); f.transfer();
      if (fault === 'pid') f.identity({pid: 12});
      if (fault === 'created') f.identity({incarnation: '101'});
      if (fault === 'incomplete') f.ledger.complete = false;
      if (fault === 'closed') f.ledger.close(8, true, 0);
      expect(() => f.slot.sample()).toThrow(); const queries = f.queries(); f.slot.cleanup();
      expect(f.closes()).toBe(0); expect(f.slot.cleanup()?.success).toBe(false);
      expect(f.queries()).toBe(queries);
    } finally {f.slot.cleanup();}
  }
});

test('failed actual close is fatal and never retried; error and deadline cleanup close their owned slot once', async () => {
  const failed = fixture();
  try {
    failed.slot.arm(failed.anchor, live); failed.transfer(); failed.failClose();
    expect(() => failed.slot.close()).toThrow('closure failed'); const queries = failed.queries();
    failed.slot.cleanup(); expect(failed.closes()).toBe(1); expect(failed.queries()).toBe(queries);
  } finally {failed.slot.cleanup();}
  const errored = fixture();
  errored.slot.arm(errored.anchor, live); errored.transfer();
  expect(errored.slot.cleanup()).toMatchObject({success: true, reason: 'cleanup'});
  expect(() => errored.slot.sample()).toThrow(); errored.slot.cleanup(); expect(errored.closes()).toBe(1);
  const timed = fixture();
  try {
    timed.slot.arm(timed.anchor, live); timed.transfer(); timed.slot.bound(Date.now() + 15);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(timed.closes()).toBe(1); expect(timed.slot.cleanup()).toMatchObject({success: true, reason: 'deadline'});
    expect(() => timed.slot.sample()).toThrow('deadline');
  } finally {timed.slot.cleanup();}
  const cancelled = fixture();
  cancelled.slot.arm(cancelled.anchor, live); cancelled.slot.cleanup();
  expect(cancelled.transfer()).toBe(false); expect(cancelled.closes()).toBe(0);
});

test('retained ledger requires the other registry, all other closes and complete worker transfers', () => {
  const f = fixture();
  try {
    f.slot.arm(f.anchor, live); f.transfer(); const sample = f.slot.sample();
    const rows: LedgerRow[] = [
      {event: 'acquired', owner: 'harness', role: 'harness-main', pid: 11, incarnation: '100', id: sample.id},
      {event: 'acquired', owner: 'launcher', role: 'launcher-main', pid: 11, incarnation: '100', id: 'launcher/1'},
      {event: 'close-result', owner: 'launcher', role: 'launcher-main', id: 'launcher/1', success: true},
    ];
    expect(otherReferencesClosed(helper, sample, rows)).toBe(true);
    expect(otherReferencesClosed(helper, sample, rows.slice(0, 1))).toBe(false);
    expect(otherReferencesClosed(helper, sample, rows.slice(0, 2))).toBe(false);
    expect(otherReferencesClosed({...helper, created: '101'}, sample, rows)).toBe(false);
    expect(otherReferencesClosed(helper, sample, [...rows, {event: 'close-result', owner: 'harness', role: 'harness-main', id: sample.id, success: true}])).toBe(false);
    const sent = {event: 'transfer-send', owner: 'launcher', role: 'launcher-worker', transfer: {id: 'launcher/1'}};
    expect(otherReferencesClosed(helper, sample, [...rows, sent])).toBe(false);
    expect(otherReferencesClosed(helper, sample, [...rows, sent, {...rows[1]!, event: 'transfer-received'}])).toBe(true);
  } finally {f.slot.cleanup();}
});
