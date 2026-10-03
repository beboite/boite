import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { normalizePairingCode, PAIRING_CODE_TTL_MS, GRANT_TTL_MS } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { CODE_FAILURES_MAX, formatCode } from '../src/sessions.ts';
import { startTestCore, type TestCore } from './harness.ts';

let harness: TestCore;

beforeEach(async () => {
  harness = await startTestCore();
});

afterEach(async () => {
  await harness.stop();
});

const client = { name: 'pwa', version: '0' };
const spentCode = 'the pairing code is wrong, expired, or was already used';
const spentLink = 'the pairing link was already used, expired, or never issued';

function refusal(run: () => unknown): string {
  try {
    run();
    return 'accepted';
  } catch (error) {
    return (error as Error).message;
  }
}

describe('normalizePairingCode', () => {
  test('reads a code the way a person types it', () => {
    expect(normalizePairingCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizePairingCode(' K7QM 2222 ')).toBe('K7QM2222');
    // The letters Crockford leaves out read as the digits they look like.
    expect(normalizePairingCode('O0IL-1234')).toBe('00111234');
    expect(normalizePairingCode('ABCD-EFG')).toBeNull();
    expect(normalizePairingCode('ABCD-EFGU')).toBeNull();
    expect(normalizePairingCode('a'.repeat(64))).toBeNull();
    expect(formatCode('ABCDEFGH')).toBe('ABCD-EFGH');
  });
});

describe('pairing codes', () => {
  test('a device grant comes with a code that pairs once, typed in any case and spacing', async () => {
    const minted = harness.core.sessions.grant(1_000);
    expect(minted.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(minted.codeExpiresAt).toBe(1_000 + PAIRING_CODE_TTL_MS);
    expect(minted.expiresAt).toBe(1_000 + GRANT_TTL_MS);

    const typed = (minted.code ?? '').toLowerCase().replace('-', ' ');
    const session = harness.core.sessions.exchange(typed, client, 2_000);
    expect(session.role).toBe('device');
    expect(harness.core.journal.listSessions()).toHaveLength(1);

    // Spent: neither the code nor the link it named opens anything again.
    expect(refusal(() => harness.core.sessions.exchange(minted.code ?? '', client, 3_000))).toBe(spentCode);
    expect(refusal(() => harness.core.sessions.exchange(minted.grant, client, 3_000))).toBe(spentLink);
  });

  test('the link spends the code too, and a code outlives neither its five minutes nor its grant', () => {
    const sessions = harness.core.sessions;
    const linked = sessions.grant(1_000);
    sessions.exchange(linked.grant, client, 2_000);
    expect(refusal(() => sessions.exchange(linked.code ?? '', client, 2_000))).toBe(spentCode);

    const late = sessions.grant(1_000);
    expect(refusal(() => sessions.exchange(late.code ?? '', client, 1_000 + PAIRING_CODE_TTL_MS))).toBe(spentCode);
    // The link itself still has its ten minutes.
    expect(sessions.exchange(late.grant, client, 1_000 + PAIRING_CODE_TTL_MS).role).toBe('device');
  });

  test('a retry through the code with the same nonce gets the same session', () => {
    const sessions = harness.core.sessions;
    const nonce = 'n'.repeat(32);
    const minted = sessions.grant(1_000);
    const first = sessions.exchange(minted.code ?? '', client, 2_000, nonce);
    expect(sessions.exchange(minted.code ?? '', client, 3_000, nonce)).toEqual(first);
    expect(refusal(() => sessions.exchange(minted.code ?? '', client, 3_000, 'm'.repeat(32)))).toBe(spentCode);
    // Once the key opens the core, the code is gone with the delivery.
    sessions.authenticate(first.token, 4_000);
    expect(refusal(() => sessions.exchange(minted.code ?? '', client, 5_000, nonce))).toBe(spentCode);
  });

  test(`${CODE_FAILURES_MAX} wrong codes in a row drop every live code, and the links keep working`, () => {
    const sessions = harness.core.sessions;
    const minted = sessions.grant(1_000);
    const wrong = minted.code === 'ZZZZ-ZZZZ' ? 'YYYY-YYYY' : 'ZZZZ-ZZZZ';
    for (let i = 0; i < CODE_FAILURES_MAX - 1; i++) expect(refusal(() => sessions.exchange(wrong, client, 2_000))).toBe(spentCode);
    // A right code before the limit resets the count.
    const other = sessions.grant(1_000);
    sessions.exchange(other.code ?? '', client, 2_000);
    for (let i = 0; i < CODE_FAILURES_MAX - 1; i++) refusal(() => sessions.exchange(wrong, client, 2_000));
    expect(sessions.exchange(minted.code ?? '', client, 2_000).role).toBe('device');

    const live = sessions.grant(1_000);
    for (let i = 0; i < CODE_FAILURES_MAX; i++) refusal(() => sessions.exchange(wrong, client, 2_000));
    expect(refusal(() => sessions.exchange(live.code ?? '', client, 2_000))).toBe(spentCode);
    expect(sessions.exchange(live.grant, client, 2_000).role).toBe('device');
  });

  test('an owner grant has a code only when asked short, and then lives five minutes', () => {
    const sessions = harness.core.sessions;
    const plain = sessions.grant(1_000, 'owner');
    expect(plain.code).toBeUndefined();
    expect(plain.expiresAt).toBe(1_000 + GRANT_TTL_MS);

    const short = sessions.grant(1_000, 'owner', true);
    expect(short.expiresAt).toBe(1_000 + PAIRING_CODE_TTL_MS);
    expect(short.codeExpiresAt).toBe(short.expiresAt);
    expect(refusal(() => sessions.exchange(short.grant, client, 1_000 + PAIRING_CODE_TTL_MS))).toBe(spentLink);
    const again = sessions.grant(1_000, 'owner', true);
    expect(sessions.exchange(again.code ?? '', client, 2_000).role).toBe('owner');

    expect(refusal(() => sessions.grant(1_000, 'owner', 'yes' as unknown as boolean))).toBe('pairing.grant short must be a boolean, got string');
  });

  test('through the socket: pairing.grant takes short, and a hello with the code pairs', async () => {
    const owner = await harness.connect();
    const minted = await owner.call('pairing.grant', { role: 'owner', short: true });
    expect(minted.role).toBe('owner');
    expect(minted.expiresAt - Date.now()).toBeLessThanOrEqual(PAIRING_CODE_TTL_MS);
    const phone = await connect(harness.url, '', { grant: minted.code ?? '', client: { name: 'pwa', version: '0' } });
    expect(phone.principal).toBe('owner');

    const device = await owner.call('pairing.grant', {});
    let wrong = 'none';
    try {
      await connect(harness.url, '', { grant: device.code === 'ZZZZ-ZZZZ' ? 'YYYY-YYYY' : 'ZZZZ-ZZZZ' });
    } catch (error) {
      wrong = (error as Error).message;
    }
    expect(wrong).toBe(spentCode);
  });
});
