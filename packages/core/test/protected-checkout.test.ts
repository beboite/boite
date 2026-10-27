import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureExecutionPolicy } from '../src/execution-policy.ts';
import { ProtectedCheckout } from '../src/platform/protected-checkout.ts';

test('a temporary directory alias produces a canonical private checkout without exposing secrets', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'boite-private-alias-')));
  let view: ProtectedCheckout | undefined;
  try {
    const checkout = join(root, 'project'), temporary = join(root, 'temporary'), alias = join(root, 'alias');
    mkdirSync(checkout); mkdirSync(temporary);
    symlinkSync(temporary, alias, 'junction');
    writeFileSync(join(checkout, 'ordinary.txt'), 'original');
    writeFileSync(join(checkout, '.env'), 'SYNTHETIC_SECRET');
    const policy = captureExecutionPolicy({
      scope: { kind: 'job', id: 'alias', associationId: 'fixture', grantRevision: 1 },
      checkout, credentialPaths: [], expiresAt: Date.now() + 60_000,
    });
    view = new ProtectedCheckout(policy, alias);
    expect(view.scratch).toBe(realpathSync(view.scratch));
    expect(view.root).toBe(realpathSync(view.root));
    expect(existsSync(join(view.root, '.env'))).toBe(false);
    writeFileSync(join(view.root, 'ordinary.txt'), 'changed');
    expect(view.flush()).toEqual(['ordinary.txt']);
    expect(readFileSync(join(checkout, 'ordinary.txt'), 'utf8')).toBe('changed');
    expect(readFileSync(join(checkout, '.env'), 'utf8')).toBe('SYNTHETIC_SECRET');
  } finally {
    view?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
