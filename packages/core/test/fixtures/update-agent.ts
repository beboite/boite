/**
 * A fake agent with an updater, for `providers.updates`.
 *
 * Run as `bun <this file> <state file> <command>`. The state file holds the
 * installed version. `--version` prints it, `check` prints the JSON an agent
 * that checks by itself prints, `update` installs 1.2.0, `update-broken`
 * fails the way a real updater does.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [stateFile = '', command = ''] = process.argv.slice(2);
const installed = existsSync(stateFile) ? readFileSync(stateFile, 'utf8').trim() : '1.0.0';

if (command === '--version') console.log(`fake-agent ${installed} (test build)`);
else if (command === 'check') {
  console.log(JSON.stringify({ currentVersion: installed, latestVersion: '1.2.0', updateAvailable: installed !== '1.2.0' }));
} else if (command === 'update') {
  writeFileSync(stateFile, '1.2.0');
  console.log('updated to 1.2.0');
} else if (command === 'update-broken') {
  console.error('error: the release server refused the download');
  process.exit(3);
} else {
  console.error(`unknown command ${command}`);
  process.exit(2);
}
