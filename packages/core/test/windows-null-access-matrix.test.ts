import {expect, test} from 'bun:test';
import {completeMatrix} from './windows-null-access-matrix.ts';

function matrix(phase: 'host' | 'lpac', readOnly = false): string {
  const token = phase === 'host'
    ? 'NULL_TOKEN phase=host appcontainer=0 flags=0x00000000 capabilities=0 registry-read=0 package=none'
    : 'NULL_TOKEN phase=lpac appcontainer=1 flags=0x00000000 capabilities=1 registry-read=1 package=S-1-15-2-123';
  const lines = [token, `NULL_LPAC phase=${phase} status=${phase === 'host' ? '0xc0000225' : '0x00000000'} value=${phase === 'host' ? 0 : 1}`,
    `NULL_SIDS phase=${phase} normal=1 restricted=${phase === 'host' ? 0 : 1} access-restricted=${phase === 'host' ? 0 : 1} capability=${phase === 'host' ? 0 : 1}`,
    `NULL_SID phase=${phase} set=normal index=0 sid=redacted attributes=0x00000007`];
  if (phase === 'lpac') for (const set of ['restricted', 'access-restricted', 'capability']) {
    lines.push(`NULL_SID phase=${phase} set=${set} index=0 sid=${set === 'capability' ? 'S-1-15-3-1024-123' : 'S-1-5-12'} attributes=0x00000004`);
  }
  const rights = {none: 0, read: 0x80000000, write: 0x40000000, readwrite: 0xc0000000};
  const granted = {none: 0, read: 0x120089, write: 0x120116, readwrite: 0x12019f};
  const hex = (value: number) => `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
  for (const path of ['dos', 'globalroot', 'native', 'native-sync']) for (const access of ['none', 'read', 'write', 'readwrite'] as const) {
    const native = path.startsWith('native'), sync = path !== 'native';
    const opened = phase === 'host' || (readOnly && ['none', 'read'].includes(access));
    const desired = rights[access] | (path === 'native-sync' ? 0x100080 : 0);
    lines.push(`NULL_ACCESS phase=${phase} path=${path} access=${access} desired=${hex(desired)} options=${native ? path === 'native-sync' ? '0x00000060' : '0x00000040' : 'na'} flags=${native ? 'na' : '0x00000000'} opened=${opened ? 1 : 0} error=${native ? 'na' : opened ? 0 : 5} status=${native ? opened ? '0x00000000' : '0xc0000022' : 'na'} granted=${hex(opened ? granted[access] | (sync ? 0x100080 : 0) : 0)} grant-status=${opened ? '0x00000000' : 'na'} mode=${hex(opened && sync ? 0x20 : 0)} mode-status=${opened ? '0x00000000' : 'na'} type=${opened ? 2 : 0} type-error=0 close-error=0`);
  }
  return lines.join('\n') + '\n';
}

test('complete native captures allow both all-denied and read-only LPAC outcomes', () => {
  expect(completeMatrix(matrix('host'), 'host')).toBe(true);
  expect(completeMatrix(matrix('lpac'), 'lpac')).toBe(true);
  expect(completeMatrix(matrix('lpac', true).replaceAll('\n', '\r\n'), 'lpac')).toBe(true);
});

test('a partial or duplicate access row cannot stand for the missing native observation', () => {
  const text = matrix('lpac'), rows = text.trimEnd().split('\n');
  expect(completeMatrix(rows.slice(0, -1).join('\n'), 'lpac')).toBe(false);
  rows[rows.length - 1] = rows[rows.length - 2]!;
  expect(completeMatrix(rows.join('\n'), 'lpac')).toBe(false);
  expect(completeMatrix(text + text.split('\n').find(line => line.startsWith('NULL_ACCESS')) + '\n', 'lpac')).toBe(false);
});

test('wrong boundary, capability set, object type or failed handle close rejects the capture', () => {
  const text = matrix('lpac', true);
  for (const [before, after] of [
    ['appcontainer=1', 'appcontainer=0'], ['capabilities=1', 'capabilities=2'],
    ['registry-read=1', 'registry-read=0'], ['package=S-1-15-2-123', 'package=none'],
    ['type=2', 'type=1'], ['type-error=0', 'type-error=5'], ['close-error=0', 'close-error=6'],
    ['status=0x00000000 value=1', 'status=0xc0000022 value=1'], ['value=1', 'value=0'],
  ]) expect(completeMatrix(text.replace(before!, after!), 'lpac')).toBe(false);
  expect(completeMatrix(text.split('\n').filter(line => !line.startsWith('NULL_LPAC')).join('\n'), 'lpac')).toBe(false);
  expect(completeMatrix(matrix('host').replace('opened=1 error=0', 'opened=0 error=5'), 'host')).toBe(false);
});

test('every SID inventory retains indices and attributes while rejecting personal SID values', () => {
  const text = matrix('lpac');
  for (const changed of [
    text.replace('normal=1', 'normal=2'), text.replace('set=restricted index=0', 'set=restricted index=1'),
    text.replace('normal=1', 'normal=2') + 'NULL_SID phase=lpac set=normal index=00 sid=redacted attributes=0x00000007\n',
    text.replace('sid=redacted', 'sid=S-1-5-21-123-456-789-1001'),
    text.replace('attributes=0x00000007', 'attributes=unknown'),
    text.replace('set=capability index=0 sid=S-1-15-3-1024-123 attributes=0x00000004', 'set=capability index=0 sid=S-1-15-3-1024-123 attributes=0x00000000'),
    text.split('\n').filter(line => !line.includes('set=access-restricted')).join('\n'),
  ]) expect(completeMatrix(changed, 'lpac')).toBe(false);
});

test('direct NT observations require raw status, explicit desired rights and create options', () => {
  const text = matrix('lpac', true);
  for (const changed of [
    text.replace('error=na status=0x00000000', 'error=na status=na'),
    text.replace('error=na status=0x00000000', 'error=na status=0xc0000022'),
    text.replace('desired=0x00100080', 'desired=0x00000000'),
    text.replace('options=0x00000060', 'options=0x00000040'),
    text.replace('grant-status=0x00000000', 'grant-status=0xc0000022'),
    text.replace('mode-status=0x00000000', 'mode-status=na'),
    text.split('\n').filter(line => !line.includes('path=native ')).join('\n'),
  ]) expect(completeMatrix(changed, 'lpac')).toBe(false);
});
