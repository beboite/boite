import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { BUN_PUBLISHER, organization, readSignature, signatureProblem } from './runtime-signature.ts';

const BUN_SUBJECT = `CN=${BUN_PUBLISHER}, O=${BUN_PUBLISHER}, L=San Francisco, S=California, C=US`;

describe('signatureProblem', () => {
  test("accepts a valid signature from Bun's publisher", () => {
    expect(signatureProblem('bun.exe', { status: 'Valid', subject: BUN_SUBJECT })).toBeNull();
  });

  test('refuses an unsigned, broken or unread signature', () => {
    expect(signatureProblem('bun.exe', { status: 'NotSigned', subject: '' })).toContain('"NotSigned"');
    expect(signatureProblem('bun.exe', { status: 'HashMismatch', subject: BUN_SUBJECT })).toContain('"HashMismatch"');
    expect(signatureProblem('bun.exe', { status: '', subject: '' })).toContain('PowerShell answered nothing');
  });

  test('refuses a valid signature from anyone else', () => {
    const problem = signatureProblem('bun.exe', { status: 'Valid', subject: 'CN=Someone, O=Someone Else, C=US' });
    expect(problem).toContain(`expected O=${BUN_PUBLISHER}`);
    // The publisher's name in the common name alone is not the organization.
    expect(signatureProblem('bun.exe', { status: 'Valid', subject: `CN=${BUN_PUBLISHER}, O=Other` })).not.toBeNull();
  });
});

test('organization reads the O= part of a subject, quoted or not', () => {
  expect(organization(BUN_SUBJECT)).toBe(BUN_PUBLISHER);
  expect(organization('CN=x, O="Acme, Inc.", C=US')).toBe('Acme, Inc.');
  expect(organization('CN=x')).toBeNull();
});

describe.skipIf(process.platform !== 'win32')('readSignature', () => {
  const saved = process.env.PSModulePath;
  afterEach(() => {
    if (saved === undefined) delete process.env.PSModulePath;
    else process.env.PSModulePath = saved;
  });

  test('answers under a PowerShell 7 module path', () => {
    // What a pwsh 7 parent exports, the CI shell included: Windows PowerShell
    // finds pwsh 7's Microsoft.PowerShell.Security there first and cannot load it.
    const pwsh7 = [
      ...(saved ?? '').split(';'),
      join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'Modules'),
    ].filter((dir) => dir !== '' && !/WindowsPowerShell/i.test(dir) && existsSync(join(dir, 'Microsoft.PowerShell.Security')));
    process.env.PSModulePath = pwsh7.join(';');
    const signature = readSignature(process.execPath);
    expect(signature.status).not.toBe('');
  });

  test('reads an unsigned file as not signed', async () => {
    const file = `${process.env.TEMP ?? '.'}\\boite-unsigned-${process.pid}.txt`;
    await Bun.write(file, 'not a program');
    try {
      expect(readSignature(file).status).not.toBe('Valid');
    } finally {
      await Bun.file(file).delete();
    }
  });
});
