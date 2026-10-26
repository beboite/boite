import {expect, test} from 'bun:test';
import {completeAccessChecks, completeMatrix, completeSuffix} from './windows-null-access-matrix.ts';

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

function suffixCapture(phase: 'host' | 'lpac', suffixOpened = false): string {
  const hex = (value: number) => `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
  const lines = [matrix(phase), `NULL_SUFFIX_BEGIN phase=${phase} suffix=boite-null-123-456`];
  for (const path of ['native-sync', 'globalroot']) for (const target of ['bare', 'suffix']) {
    for (const [access, right] of [['read', 0x80000000], ['write', 0x40000000], ['readwrite', 0xc0000000]] as const) {
      const native = path === 'native-sync', opened = target === 'bare' ? phase === 'host' : suffixOpened;
      const read = opened && access !== 'write', write = opened && access !== 'read';
      lines.push(`NULL_SUFFIX phase=${phase} path=${path} target=${target} access=${access} desired=${hex(right | (native ? 0x100080 : 0))} options=${native ? '0x00000060' : 'na'} opened=${opened ? 1 : 0} error=${native ? 'na' : opened ? '0' : '5'} status=${native ? opened ? '0x00000000' : '0xc0000022' : 'na'} type=${opened ? 2 : 0} type-error=0 query-status=${opened ? '0x00000000' : 'na'} query-bytes=${opened ? 8 : 0} device-type=${hex(opened ? 0x15 : 0)} characteristics=${hex(0)} secure-open=${opened ? 0 : 'na'} reads=${read ? 2 : 0} eof=${read ? 2 : 0} read-bytes=0 read-error=0 writes=${write ? 2 : 0} written=${write ? 8192 : 0} write-error=0 close-error=0`);
    }
  }
  lines.push(`NULL_SUFFIX_END phase=${phase} error=0`);
  return lines.join('\n') + '\n';
}

test('suffix collection distinguishes a complete negative experiment from a successful real Null open', () => {
  for (const phase of ['host', 'lpac'] as const) for (const opened of [false, true]) {
    expect(completeSuffix(suffixCapture(phase, opened), phase)).toBe(true);
  }
  expect(completeSuffix(suffixCapture('lpac', true).replaceAll('\n', '\r\n'), 'lpac')).toBe(true);
  expect(completeSuffix(matrix('lpac'), 'lpac')).toBe(false);
});

test('suffix collection rejects partial, duplicate and contradictory observations', () => {
  const text = suffixCapture('lpac', true), rows = text.trimEnd().split('\n');
  const protocol = text.slice(text.indexOf('NULL_SUFFIX_BEGIN'));
  for (const tag of ['NULL_SUFFIX_BEGIN', 'NULL_SUFFIX', 'NULL_SUFFIX_END']) {
    const row = rows.find(line => line.startsWith(tag + ' '))!;
    expect(completeSuffix(rows.filter(line => line !== row).join('\n'), 'lpac')).toBe(false);
    expect(completeSuffix(text + row + '\n', 'lpac')).toBe(false);
  }
  for (const [before, after] of [
    ['suffix=boite-null-123-456', 'suffix=../host'],
    ['target=bare access=read', 'target=unexpected access=read'],
    ['desired=0x80100080', 'desired=0x80000000'], ['options=0x00000060', 'options=0x00000040'],
    ['opened=0 error=na status=0xc0000022', 'opened=0 error=na status=0x00000000'],
    ['query-status=0x00000000', 'query-status=0xc0000002'], ['device-type=0x00000015', 'device-type=0x00000007'],
    ['query-bytes=8', 'query-bytes=0'],
    ['type=2 type-error=0', 'type=1 type-error=0'], ['secure-open=0 reads=', 'secure-open=1 reads='],
    ['reads=2 eof=2', 'reads=2 eof=1'], ['read-bytes=0 read-error=0 writes=2', 'read-bytes=1 read-error=0 writes=2'],
    ['written=8192', 'written=4096'], ['write-error=0 close-error=0', 'write-error=5 close-error=0'],
    ['close-error=0', 'close-error=6'], ['NULL_SUFFIX_END phase=lpac error=0', 'NULL_SUFFIX_END phase=lpac error=13'],
    ['target=bare', 'target=bare target=bare'],
  ]) expect(completeSuffix(matrix('lpac') + protocol.replace(before!, after!), 'lpac'), `${before} -> ${after}`).toBe(false);
  expect(completeSuffix(text.replace('appcontainer=1', 'appcontainer=0'), 'lpac')).toBe(false);
});

test('a secure-open device or namespace rejection is a measured negative, never missing evidence', () => {
  const text = suffixCapture('host');
  const secure = text.replaceAll('characteristics=0x00000000 secure-open=0', 'characteristics=0x00000100 secure-open=1');
  expect(completeSuffix(secure, 'host')).toBe(true);
  expect(completeSuffix(text.replaceAll('status=0xc0000022', 'status=0xc0000033').replaceAll('opened=0 error=5 status=na', 'opened=0 error=123 status=na'), 'host')).toBe(true);
});

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

// Authentic SDK/MinGW host capture, Windows Server 2025, commit 0e760ce5.
const hostZeroAccessCapture = String.raw`NULL_TOKEN phase=host appcontainer=0 flags=0x00002000 capabilities=0 registry-read=0 package=none
NULL_LPAC phase=host status=0xc0000225 value=0
NULL_SIDS phase=host normal=15 restricted=0 access-restricted=0 capability=0
NULL_SID phase=host set=normal index=0 sid=redacted attributes=0x00000000
NULL_SID phase=host set=normal index=1 sid=redacted attributes=0x00000007
NULL_SID phase=host set=normal index=2 sid=S-1-1-0 attributes=0x00000007
NULL_SID phase=host set=normal index=3 sid=redacted attributes=0x00000007
NULL_SID phase=host set=normal index=4 sid=redacted attributes=0x0000000f
NULL_SID phase=host set=normal index=5 sid=redacted attributes=0x00000007
NULL_SID phase=host set=normal index=6 sid=redacted attributes=0x00000007
NULL_SID phase=host set=normal index=7 sid=redacted attributes=0x00000007
NULL_SID phase=host set=normal index=8 sid=redacted attributes=0x00000007
NULL_SID phase=host set=normal index=9 sid=redacted attributes=0x00000007
NULL_SID phase=host set=normal index=10 sid=redacted attributes=0x00000007
NULL_SID phase=host set=normal index=11 sid=redacted attributes=0xc0000007
NULL_SID phase=host set=normal index=12 sid=redacted attributes=0x00000007
NULL_SID phase=host set=normal index=13 sid=redacted attributes=0x00000007
NULL_SID phase=host set=normal index=14 sid=redacted attributes=0x00000060
NULL_ACCESS phase=host path=dos access=none desired=0x00000000 options=na flags=0x00000000 opened=1 error=0 status=na granted=0x00100080 grant-status=0x00000000 mode=0x00000020 mode-status=0x00000000 type=2 type-error=0 close-error=0
NULL_ACCESS phase=host path=dos access=read desired=0x80000000 options=na flags=0x00000000 opened=1 error=0 status=na granted=0x00120089 grant-status=0x00000000 mode=0x00000020 mode-status=0x00000000 type=2 type-error=0 close-error=0
NULL_ACCESS phase=host path=dos access=write desired=0x40000000 options=na flags=0x00000000 opened=1 error=0 status=na granted=0x00120196 grant-status=0x00000000 mode=0x00000020 mode-status=0x00000000 type=2 type-error=0 close-error=0
NULL_ACCESS phase=host path=dos access=readwrite desired=0xc0000000 options=na flags=0x00000000 opened=1 error=0 status=na granted=0x0012019f grant-status=0x00000000 mode=0x00000020 mode-status=0x00000000 type=2 type-error=0 close-error=0
NULL_ACCESS phase=host path=globalroot access=none desired=0x00000000 options=na flags=0x00000000 opened=1 error=0 status=na granted=0x00100080 grant-status=0x00000000 mode=0x00000020 mode-status=0x00000000 type=2 type-error=0 close-error=0
NULL_ACCESS phase=host path=globalroot access=read desired=0x80000000 options=na flags=0x00000000 opened=1 error=0 status=na granted=0x00120089 grant-status=0x00000000 mode=0x00000020 mode-status=0x00000000 type=2 type-error=0 close-error=0
NULL_ACCESS phase=host path=globalroot access=write desired=0x40000000 options=na flags=0x00000000 opened=1 error=0 status=na granted=0x00120196 grant-status=0x00000000 mode=0x00000020 mode-status=0x00000000 type=2 type-error=0 close-error=0
NULL_ACCESS phase=host path=globalroot access=readwrite desired=0xc0000000 options=na flags=0x00000000 opened=1 error=0 status=na granted=0x0012019f grant-status=0x00000000 mode=0x00000020 mode-status=0x00000000 type=2 type-error=0 close-error=0
NULL_ACCESS phase=host path=native access=none desired=0x00000000 options=0x00000040 flags=na opened=0 error=na status=0xc0000022 granted=0x00000000 grant-status=na mode=0x00000000 mode-status=na type=0 type-error=0 close-error=0
NULL_ACCESS phase=host path=native access=read desired=0x80000000 options=0x00000040 flags=na opened=1 error=na status=0x00000000 granted=0x00120089 grant-status=0x00000000 mode=0x00000000 mode-status=0x00000000 type=2 type-error=0 close-error=0
NULL_ACCESS phase=host path=native access=write desired=0x40000000 options=0x00000040 flags=na opened=1 error=na status=0x00000000 granted=0x00120116 grant-status=0x00000000 mode=0x00000000 mode-status=0x00000000 type=2 type-error=0 close-error=0
NULL_ACCESS phase=host path=native access=readwrite desired=0xc0000000 options=0x00000040 flags=na opened=1 error=na status=0x00000000 granted=0x0012019f grant-status=0x00000000 mode=0x00000000 mode-status=0x00000000 type=2 type-error=0 close-error=0
NULL_ACCESS phase=host path=native-sync access=none desired=0x00100080 options=0x00000060 flags=na opened=1 error=na status=0x00000000 granted=0x00100080 grant-status=0x00000000 mode=0x00000020 mode-status=0x00000000 type=2 type-error=0 close-error=0
NULL_ACCESS phase=host path=native-sync access=read desired=0x80100080 options=0x00000060 flags=na opened=1 error=na status=0x00000000 granted=0x00120089 grant-status=0x00000000 mode=0x00000020 mode-status=0x00000000 type=2 type-error=0 close-error=0
NULL_ACCESS phase=host path=native-sync access=write desired=0x40100080 options=0x00000060 flags=na opened=1 error=na status=0x00000000 granted=0x00120196 grant-status=0x00000000 mode=0x00000020 mode-status=0x00000000 type=2 type-error=0 close-error=0
NULL_ACCESS phase=host path=native-sync access=readwrite desired=0xc0100080 options=0x00000060 flags=na opened=1 error=na status=0x00000000 granted=0x0012019f grant-status=0x00000000 mode=0x00000020 mode-status=0x00000000 type=2 type-error=0 close-error=0
`.replaceAll('\n', '\r\n');

test('native host zero-access refusal remains observable without blocking LPAC collection', () => {
  expect(completeMatrix(hostZeroAccessCapture, 'host')).toBe(true);
});

test('the host exception rejects other statuses, request changes and incomplete closure evidence', () => {
  const row = hostZeroAccessCapture.split('\r\n').find(line => line.includes('path=native access=none'))!;
  for (const [before, after] of [
    ['status=0xc0000022', 'status=0xc000000d'], ['desired=0x00000000', 'desired=0x00100080'],
    ['options=0x00000040', 'options=0x00000060'], ['flags=na', 'flags=0x00000000'],
    ['granted=0x00000000', 'granted=0x00000001'], ['grant-status=na', 'grant-status=0x00000000'],
    ['mode=0x00000000', 'mode=0x00000020'], ['mode-status=na', 'mode-status=0x00000000'],
    ['type=0', 'type=2'], ['type-error=0', 'type-error=5'], ['close-error=0', 'close-error=6'],
  ]) expect(completeMatrix(hostZeroAccessCapture.replace(row, row.replace(before!, after!)), 'host')).toBe(false);
  expect(completeMatrix(hostZeroAccessCapture.replace(row + '\r\n', ''), 'host')).toBe(false);
  expect(completeMatrix(hostZeroAccessCapture + row + '\r\n', 'host')).toBe(false);
});

test('all fifteen other native host observations still require successful opens', () => {
  const successful = hostZeroAccessCapture.split('\r\n').filter(line => line.startsWith('NULL_ACCESS ') && line.includes('opened=1'));
  expect(successful).toHaveLength(15);
  for (const row of successful) {
    const native = row.includes(' flags=na ');
    const refused = row.replace('opened=1', 'opened=0').replace(' error=0 ', ' error=5 ')
      .replace(' status=0x00000000 ', native ? ' status=0xc0000022 ' : ' status=na ')
      .replace(/ granted=0x[0-9a-f]{8} /, ' granted=0x00000000 ').replace('grant-status=0x00000000', 'grant-status=na')
      .replace(/ mode=0x[0-9a-f]{8} /, ' mode=0x00000000 ').replace('mode-status=0x00000000', 'mode-status=na').replace(' type=2 ', ' type=0 ');
    expect(completeMatrix(hostZeroAccessCapture.replace(row, refused), 'host')).toBe(false);
  }
});

function accessChecks(originalAllowed = false, packageAllowed = true): string {
  const lines = [matrix('lpac'),
    'NULL_AUTHZ_OBJECT name=DeviceNull verified=1 type=2 desired=0x00120080 options=0x00000060 status=0x00000000 security=0x00000007 owner=1 group=1 dacl-present=1 dacl-null=0 ace-count=1',
    'NULL_AUTHZ_ACE index=0 type=0 flags=0x00000000 mask=0x001201bf sid=S-1-1-0',
    'NULL_AUTHZ_LABEL error=0 present=0 count=0 scope=label-only full-sacl=0 driver=0',
    'NULL_AUTHZ_VARIANT name=package added=1 sid=S-1-15-2-123 mask=0x0012019f inherited=0 original-unchanged=1',
    'NULL_AUTHZ_TOKEN phase=host source=current-process type=2 level=1 appcontainer=0 lpac=0 status=0xc0000225 package=none capabilities=0 registry-read=0',
    'NULL_AUTHZ_TOKEN phase=lpac source=suspended-child type=2 level=1 appcontainer=1 lpac=1 status=0x00000000 package=S-1-15-2-123 capabilities=1 registry-read=1'];
  for (const phase of ['host', 'lpac']) for (const variant of ['original', 'package']) {
    for (const [access, requested, mapped] of [['read', '0x80000000', '0x00120089'], ['write', '0x40000000', '0x00120116'], ['readwrite', '0xc0000000', '0x0012019f']]) {
      const allowed = phase === 'host' || (variant === 'original' ? originalAllowed : packageAllowed);
      lines.push(`NULL_AUTHZ_CHECK phase=${phase} variant=${variant} access=${access} requested=${requested} mapped=${mapped} api=1 error=${allowed ? 0 : 5} allowed=${allowed ? 1 : 0} granted=${allowed ? mapped : '0x00000000'} privileges=0`);
    }
  }
  lines.push('NULL_AUTHZ_CLEANUP error=0');
  return lines.join('\n') + '\n';
}

test('an open matrix alone cannot claim the new DACL experiment is complete', () => {
  expect(completeMatrix(matrix('lpac'), 'lpac')).toBe(true);
  expect(completeAccessChecks(matrix('lpac'))).toBe(false);
});

test('DACL collection accepts either LPAC verdict without treating a memory grant as an open', () => {
  for (const original of [false, true]) for (const packageGrant of [false, true]) {
    expect(completeAccessChecks(accessChecks(original, packageGrant))).toBe(true);
  }
  expect(completeAccessChecks(accessChecks().replaceAll('\n', '\r\n'))).toBe(true);
});

test('optional label reads remain separate from DACL verdicts and retain every returned label', () => {
  const text = accessChecks();
  expect(completeAccessChecks(text.replace('NULL_AUTHZ_LABEL error=0', 'NULL_AUTHZ_LABEL error=5'))).toBe(true);
  const label = 'NULL_AUTHZ_MANDATORY index=0 rid=4096 policy=0x00000001 flags=0x00000000\n';
  const captured = text.replace('present=0 count=0 scope=label-only', 'present=1 count=1 scope=label-only') + label;
  expect(completeAccessChecks(captured)).toBe(true);
  expect(completeAccessChecks(captured.replace(label, ''))).toBe(false);
  expect(completeAccessChecks(captured + label)).toBe(false);
  expect(completeAccessChecks(captured.replace('rid=4096', 'rid=unknown'))).toBe(false);
  expect(completeAccessChecks(captured.replace('full-sacl=0', 'full-sacl=1'))).toBe(false);
});

test('DACL observations require the real duplicated LPAC identity, mapped rights and API success', () => {
  const text = accessChecks();
  for (const [before, after] of [
    ['owner=1', 'owner=0'], ['group=1', 'group=0'], ['security=0x00000007', 'security=0x00000004'],
    ['verified=1', 'verified=0'], ['source=suspended-child', 'source=synthetic-token'],
    ['type=2 level=1 appcontainer=1', 'type=1 level=1 appcontainer=1'], ['lpac=1', 'lpac=0'],
    ['status=0x00000000 package=', 'status=0xc0000022 package='], ['level=1 appcontainer=1', 'level=0 appcontainer=1'],
    ['capabilities=1 registry-read=1\nNULL_AUTHZ_CHECK', 'capabilities=2 registry-read=1\nNULL_AUTHZ_CHECK'],
    ['sid=S-1-15-2-123 mask=', 'sid=S-1-15-2-456 mask='], ['added=1', 'added=2'],
    ['original-unchanged=1', 'original-unchanged=0'], ['mask=0x0012019f inherited=0', 'mask=0x001f01ff inherited=0'],
    ['mapped=0x00120089', 'mapped=0x80000000'], ['api=1', 'api=0'], ['privileges=0', 'privileges=1'],
    ['allowed=0 granted=0x00000000', 'allowed=0 granted=0x00120089'],
    ['NULL_AUTHZ_CLEANUP error=0', 'NULL_AUTHZ_CLEANUP error=6'],
    ['sid=S-1-1-0', 'sid=S-1-5-21-123-456-789-1001'],
    ['api=1', 'api=1 api=1'], ['api=1', 'api=1 tag=NULL_AUTHZ_CHECK'],
    ['api=1 error=0 allowed=1', 'api=1 error=5 allowed=1'], ['api=1 error=5 allowed=0', 'api=1 error=0 allowed=0'],
  ]) expect(completeAccessChecks(text.replace(before!, after!)), `${before} -> ${after}`).toBe(false);
  const rows = text.trimEnd().split('\n');
  for (const tag of ['NULL_AUTHZ_OBJECT', 'NULL_AUTHZ_ACE', 'NULL_AUTHZ_LABEL', 'NULL_AUTHZ_VARIANT', 'NULL_AUTHZ_TOKEN', 'NULL_AUTHZ_CHECK', 'NULL_AUTHZ_CLEANUP']) {
    const row = rows.find(line => line.startsWith(tag + ' '))!;
    expect(completeAccessChecks(rows.filter(line => line !== row).join('\n')), `missing ${tag}`).toBe(false);
    expect(completeAccessChecks(text + row + '\n'), `duplicate ${tag}`).toBe(false);
  }
});
