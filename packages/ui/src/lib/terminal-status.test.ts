import { describe, expect, it } from 'vitest';
import { ShellStatusReader } from './terminal-status';

function reader() {
  const seen = { running: false, exits: [] as (number | null)[], cwd: null as string | null };
  const status = new ShellStatusReader({
    running: (running) => { seen.running = running; },
    exit: (code) => { seen.exits.push(code); },
    cwd: (path) => { seen.cwd = path; }
  });
  return { status, seen };
}

const RUNNING = '\x1b]133;A\x07$ \x1b]133;B\x07\x1b]133;C\x07';

describe('ShellStatusReader', () => {
  it('ends a sequence the snapshot leaves open with output that came before the snapshot did', () => {
    const exit = reader();
    exit.status.read('1\x07', 11);
    exit.status.seed(`${RUNNING}\x1b]133;D;`, 10);
    expect(exit.seen).toMatchObject({ running: false, exits: [1] });

    const cwd = reader();
    cwd.status.read('dir\x07', 11);
    cwd.status.seed('\x1b]633;P;Cwd=/new/', 10);
    expect(cwd.seen.cwd).toBe('/new/dir');
  });

  it('starts a new parser after the socket dropped, so lost output joins nothing', () => {
    const { status, seen } = reader();
    status.seed('\x1b]633;P;Cwd=/old/', 1);
    status.unseed();
    status.read('dir\x07', 4);
    status.seed('\x1b]633;P;Cwd=/new/', 3);
    expect(seen.cwd).toBe('/new/dir');
  });

  it('keeps a command\'s end that empty prompts follow before the snapshot lands', () => {
    const { status, seen } = reader();
    status.read('\x1b]133;D;1\x07', 11);
    for (let sequence = 12; sequence <= 1011; sequence++) status.read('\x1b]133;A\x07$ ', sequence);
    status.seed(`${RUNNING}\x1b]133;D;0\x07${RUNNING}`, 10);
    expect(seen).toMatchObject({ running: false, exits: [0, 1] });
  });

  it('keeps what output too old for its buffer said when it is newer than the snapshot', () => {
    const { status, seen } = reader();
    const flood = 'x'.repeat(64 * 1024);
    status.read('\x1b]133;D;1\x07\x1b]7;file:///work\x07', 11);
    for (let sequence = 12; sequence < 20; sequence++) status.read(flood, sequence);
    status.read('\x1b]133;A\x07$ ', 20);
    status.seed(RUNNING, 10);
    expect(seen).toMatchObject({ running: false, exits: [1], cwd: '/work' });
  });

  it('lets the snapshot decide when the output that left the buffer is in it', () => {
    const { status, seen } = reader();
    status.read(`${RUNNING}\x1b]133;D;7\x07`, 1);
    for (let sequence = 2; sequence < 10; sequence++) status.read('x'.repeat(64 * 1024), sequence);
    status.seed(`${RUNNING}\x1b]133;D;7\x07${RUNNING}`, 12);
    status.read('\x1b]133;D;', 13);
    status.read('2\x07', 14);
    expect(seen).toMatchObject({ running: false, exits: [7, 2] });
  });

  it('ends a sequence the snapshot leaves open with output that then left the buffer', () => {
    const flood = (status: ShellStatusReader) => {
      for (let sequence = 12; sequence < 20; sequence++) status.read('x'.repeat(64 * 1024), sequence);
      status.read('\x1b]133;A\x07$ \x1b]133;B\x07\x1b]133;C\x07', 20);
    };
    const exit = reader();
    exit.status.read('1\x07', 11);
    flood(exit.status);
    exit.status.seed(`${RUNNING}\x1b]133;D;`, 10);
    expect(exit.seen).toMatchObject({ running: true, exits: [1] });

    const cwd = reader();
    cwd.status.read('dir\x07', 11);
    flood(cwd.status);
    cwd.status.seed('\x1b]633;P;Cwd=/new/', 10);
    expect(cwd.seen.cwd).toBe('/new/dir');

    // A sequence drops C0 controls without counting them against MAX_OSC.
    const controls = reader();
    controls.status.read(`${'\r'.repeat(4097)}1\x07`, 11);
    flood(controls.status);
    controls.status.seed(`${RUNNING}\x1b]133;D;`, 10);
    expect(controls.seen).toMatchObject({ running: true, exits: [1] });

    const lines = reader();
    lines.status.read(`${'\n'.repeat(4097)}dir\x07`, 11);
    flood(lines.status);
    lines.status.seed('\x1b]633;P;Cwd=/new/', 10);
    expect(lines.seen.cwd).toBe('/new/dir');
  });

  it('ends a sequence that output leaving the buffer left open with the output still in it', () => {
    const exit = reader();
    exit.status.read(`${'x'.repeat(256 * 1024)}\x1b]133;D;`, 11);
    exit.status.read('1\x07', 12);
    exit.status.seed(RUNNING, 10);
    expect(exit.seen).toMatchObject({ running: false, exits: [1] });

    const cwd = reader();
    cwd.status.read(`${'x'.repeat(256 * 1024)}\x1b]633;P;Cwd=/new/`, 11);
    cwd.status.read('dir\x07', 12);
    cwd.status.seed(RUNNING, 10);
    expect(cwd.seen.cwd).toBe('/new/dir');
  });
});
