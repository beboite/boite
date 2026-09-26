/**
 * A fake agent with an updater, for `providers.updates`.
 *
 * Run as `bun <this file> <state file> <command>`. The state file holds the
 * installed version. `--version` prints it, `check` prints the JSON an agent
 * that checks by itself prints, `update` installs 1.2.0, `update-broken`
 * fails the way a real updater does, and `update-launched` installs 1.2.0 only
 * when its launcher set `FAKE_MANAGED_BY_NPM`, as `codex update` does. With
 * `FAKE_HANG=1`, `--version` answers and then hangs with a child on its pipes.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [stateFile = '', command = ''] = process.argv.slice(2);
const installed = existsSync(stateFile) ? readFileSync(stateFile, 'utf8').trim() : '1.0.0';

if (command === '--version' && process.env['FAKE_HANG'] === '1') {
  // A launcher that answers, leaves a child holding its output pipe, and never exits.
  console.log(`fake-agent ${installed} (test build)`);
  Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 20000)'], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  await Bun.sleep(60_000);
} else if (command === '--version') console.log(`fake-agent ${installed} (test build)`);
else if (command === 'check') {
  console.log(JSON.stringify({ currentVersion: installed, latestVersion: '1.2.0', updateAvailable: installed !== '1.2.0' }));
} else if (command === 'update') {
  writeFileSync(stateFile, '1.2.0');
  console.log('updated to 1.2.0');
} else if (command === 'update-launched') {
  if (process.env['FAKE_MANAGED_BY_NPM'] !== '1') {
    console.error('Error: Could not detect the installation method.');
    process.exit(1);
  }
  writeFileSync(stateFile, '1.2.0');
  console.log('updated to 1.2.0');
} else if (command === 'update-broken') {
  console.error('error: the release server refused the download');
  process.exit(3);
} else {
  console.error(`unknown command ${command}`);
  process.exit(2);
}
