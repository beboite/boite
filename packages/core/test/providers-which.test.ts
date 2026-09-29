import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry } from '../src/providers/loader.ts';
import { forgetWhich, which } from '../src/providers/which.ts';

const PROGRAM = 'boite-which-fixture-program';
const DETECT = 'boite-which-fixture-detect';

let dataDir: string;
let asked: string[];
let hostAgents: string | undefined;
const original = Bun.which;

/** A user descriptor whose program and detect command exist nowhere, so the lookups are the test's own names. */
function writeFixtureDescriptor(): void {
  const dir = join(dataDir, 'providers');
  mkdirSync(dir, { recursive: true });
  const profile = { detect: { command: DETECT }, executable: [{ kind: 'path', value: PROGRAM }] };
  writeFileSync(join(dir, 'which-fixture.json'), JSON.stringify({
    id: 'which-fixture',
    schemaVersion: 1,
    name: 'Which fixture',
    shortName: 'Which',
    protocol: 'echo',
    roots: [],
    profiles: { windows: profile, linux: profile, macos: profile },
    auth: { kind: 'none' },
    models: [{ id: 'echo', name: 'Echo', default: true }],
    capabilities: { approvals: false, hooks: false, checkpoint: false, images: false, planMode: false, resume: false },
  }), 'utf8');
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'boite-which-'));
  asked = [];
  // The shipped descriptors resolve nothing: the only names looked up are the fixture's.
  hostAgents = process.env.BOITE_HOST_AGENTS;
  process.env.BOITE_HOST_AGENTS = '0';
  forgetWhich();
  (Bun as { which: typeof Bun.which }).which = ((name: string, options?: Parameters<typeof Bun.which>[1]) => {
    asked.push(name);
    return original(name, options);
  }) as typeof Bun.which;
});

afterEach(() => {
  (Bun as { which: typeof Bun.which }).which = original;
  if (hostAgents === undefined) delete process.env.BOITE_HOST_AGENTS;
  else process.env.BOITE_HOST_AGENTS = hostAgents;
  forgetWhich();
  rmSync(dataDir, { recursive: true, force: true });
});

test('listing providers again right away scans PATH once, and a reload looks again', () => {
  writeFixtureDescriptor();
  const registry = new ProviderRegistry(dataDir);
  expect(registry.list().rejected).toEqual([]);
  // The core's start: the registry loads, then the default accounts list the available ones.
  registry.available();
  expect(asked.filter((name) => name === DETECT)).toEqual([DETECT]);
  const first = asked.length;
  // A client's boot lists them too.
  registry.list();
  registry.list();
  expect(asked.length).toBe(first);

  // Something the user installed outside Boite: the Providers page reloads.
  registry.load();
  expect(asked.filter((name) => name === DETECT)).toEqual([DETECT, DETECT]);
});

test('an answer is kept thirty seconds, then looked up again', () => {
  let now = 1_000_000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const found = which('bun');
    expect(found).toBe(original('bun'));
    now += 29_000;
    expect(which('bun')).toBe(found);
    expect(asked).toEqual(['bun']);
    now += 2_000;
    expect(which('bun')).toBe(found);
    expect(asked).toEqual(['bun', 'bun']);
    expect(which(PROGRAM)).toBeNull();
    now += 100;
    expect(which(PROGRAM)).toBeNull();
    expect(asked).toEqual(['bun', 'bun', PROGRAM]);
  } finally {
    clock.mockRestore();
  }
});
