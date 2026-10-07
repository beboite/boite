/**
 * A fake agent with an updater, for `providers.updates`.
 *
 * Run as `bun <this file> <state file> <command>`. The state file holds the
 * installed version. `--version` prints it, `check` prints the JSON an agent
 * that checks by itself prints, `update` installs 1.2.0, `update-current`
 * finds nothing newer and changes nothing, as `agy update` does, `update-broken`
 * fails the way a real updater does, and `update-launched` installs 1.2.0 only
 * when its launcher set `FAKE_MANAGED_BY_NPM`, as `codex update` does,
 * `update-npm` installs 1.2.0 and writes the `npm_config_prefix` it was given
 * to `<state file>.prefix`, where `npm install -g` would have written, and
 * `update-stuck` fails and still exits with zero, as `opencode upgrade` does
 * whatever went wrong, and `update-gated` writes `<state file>.running`, then
 * installs 1.2.0 once `<state file>.go` exists, so a test can look while it
 * runs; a gate still shut after 30 s fails it. With
 * `FAKE_HANG=1`, `--version` answers and then hangs with a child on its pipes.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

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
} else if (command === 'update-gated') {
  writeFileSync(`${stateFile}.running`, 'yes');
  for (let waited = 0; !existsSync(`${stateFile}.go`) && waited < 30_000; waited += 20) await Bun.sleep(20);
  rmSync(`${stateFile}.running`, { force: true });
  // A gate nobody opened is a stuck test, not an installed release.
  if (!existsSync(`${stateFile}.go`)) {
    console.error('error: the gate never opened');
    process.exit(4);
  }
  writeFileSync(stateFile, '1.2.0');
  console.log('updated to 1.2.0');
} else if (command === 'update-current') {
  console.log(`You are already on the latest version.`);
} else if (command === 'update-launched') {
  if (process.env['FAKE_MANAGED_BY_NPM'] !== '1') {
    console.error('Error: Could not detect the installation method.');
    process.exit(1);
  }
  writeFileSync(stateFile, '1.2.0');
  console.log('updated to 1.2.0');
} else if (command === 'update-npm') {
  writeFileSync(`${stateFile}.prefix`, process.env['npm_config_prefix'] ?? '(unset)');
  writeFileSync(stateFile, '1.2.0');
  console.log('updated to 1.2.0');
} else if (command === 'update-stuck') {
  // What `opencode upgrade` prints through @clack/prompts, colors and ASCII fallback included.
  for (const line of ['\x1b[90m┌\x1b[39m  Upgrade', '│', '●  Using method: npm', '│', `●  From ${installed} → 1.1.0`, '│', '◇  Upgrade failed', '│', 'x  Upgrade failed for npm (exit code 1).', '│', '—  Done']) console.log(line);
} else if (command === 'update-broken') {
  console.log('Using global installation update method...');
  console.error('error: the release server refused the download');
  process.exit(3);
} else if (command === 'update-permission') {
  console.log('Updating agent via npm install -g...');
  console.error('npm error code EACCES');
  console.error("npm error Error: EACCES: permission denied, mkdir '/usr/lib/node_modules/@boite-test'");
  console.error('npm error A complete log of this run can be found in: /tmp/npm-debug.log');
  process.exit(1);
} else {
  console.error(`unknown command ${command}`);
  process.exit(2);
}
