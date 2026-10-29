import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dockerfile = readFileSync(resolve(import.meta.dir, '../../Dockerfile'), 'utf8');
const runtime = dockerfile.split(/^FROM .* AS runtime$/m)[1] ?? '';
const env = Object.fromEntries([...runtime.matchAll(/^[ \t]*(?:ENV[ \t]+)?([A-Z_]+)=([^\s\\]+)/gm)].map(match => [match[1]!, match[2]!]));

test('agent updates install where the server user can write, ahead of the image copy on PATH', () => {
  // /opt/agents is root's: `npm install -g` with npm's default /usr/local prefix fails with EACCES.
  const prefix = env.NPM_CONFIG_PREFIX;
  expect(prefix).toBe(`${env.HOME}/.local`);
  const path = (env.PATH ?? '').split(':');
  expect(path[0]).toBe(`${prefix}/bin`);
  expect(path.indexOf(`${prefix}/bin`)).toBeLessThan(path.indexOf('/opt/agents/node_modules/.bin'));
  expect(runtime).toContain('USER node');
});
