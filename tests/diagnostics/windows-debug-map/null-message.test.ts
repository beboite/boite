import {expect, test} from 'bun:test';
import type {Captured} from './capture.ts';
import {acceptsNullMessageProbe} from './null-message.ts';

const complete: Captured = {pid: 123, code: 0, timedOut: false, err: '',
  out: 'NULL_MESSAGE_PROBE reads=32 eof-writes=32 flushes=32 write-blocks=32 received=2097152 pre-read-flush-pending=1 joined=3 closed=9 io-acquired=225 io-closed=225 retained=0 error=0 semanticAccepted=1 productionAccepted=0\n'};

test('ordinary pipe evidence requires completed I/O and no production admission', () => {
  expect(acceptsNullMessageProbe(complete)).toBe(true);
  expect(acceptsNullMessageProbe({...complete, out: complete.out.replace('\n', '\r\n')})).toBe(true);
  for (const patch of [{code: 1}, {code: null}, {timedOut: true}, {err: 'incomplete I/O'},
    {out: complete.out + complete.out}, {out: 'semanticAccepted=1\n'}])
    expect(acceptsNullMessageProbe({...complete, ...patch})).toBe(false);
  for (const [before, after] of [
    ['reads=32', 'reads=31'], ['eof-writes=32', 'eof-writes=31'], ['flushes=32', 'flushes=31'],
    ['write-blocks=32', 'write-blocks=31'], ['received=2097152', 'received=2097151'],
    ['pre-read-flush-pending=1', 'pre-read-flush-pending=0'], ['joined=3', 'joined=2'], ['closed=9', 'closed=8'],
    ['io-closed=225', 'io-closed=224'], ['io-acquired=225 io-closed=225', 'io-acquired=223 io-closed=223'],
    ['io-acquired=225 io-closed=225', 'io-acquired=99999999999999999999 io-closed=99999999999999999999'],
    ['retained=0', 'retained=1'], ['error=0', 'error=5'], ['semanticAccepted=1', 'semanticAccepted=0'],
    ['productionAccepted=0', 'productionAccepted=1'],
  ]) expect(acceptsNullMessageProbe({...complete, out: complete.out.replace(before!, after!)})).toBe(false);
});
