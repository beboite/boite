import { expect, test } from 'bun:test';
import { coreEnv } from './idle-rss.ts';

test('a measured core resolves no host agent by default', () => {
  const env = coreEnv({ PATH: 'x', BOITE_TELEMETRY_URL: 'https://t.example' }, 'D:/data', false);
  expect(env.BOITE_HOST_AGENTS).toBe('0');
  expect(env.BOITE_DATA_DIR).toBe('D:/data');
  expect(env.BOITE_TELEMETRY_URL).toBe('');
  expect(env.PATH).toBe('x');
});

test('a caller that set BOITE_HOST_AGENTS=1 still gets no host agent without the bench opt-in', () => {
  expect(coreEnv({ BOITE_HOST_AGENTS: '1' }, 'D:/data', false).BOITE_HOST_AGENTS).toBe('0');
});

test('BOITE_BENCH_HOST_AGENTS lets the core read the agents on PATH', () => {
  expect(coreEnv({ BOITE_HOST_AGENTS: '0' }, 'D:/data', true).BOITE_HOST_AGENTS).toBeUndefined();
});
