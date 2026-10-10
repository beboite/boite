// Stands in for the Windows firewall commands: `query` prints the reading kept
// in <state>, `allow` replaces it with an allow-everywhere rule, or exits as a
// refused administrator prompt when <state>.refuse exists.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { FIREWALL_PROMPT_REFUSED } from '../../src/platform/types.ts';

const [state, action] = process.argv.slice(2) as [string, string];
if (action === 'query') {
  process.stdout.write(readFileSync(state, 'utf8'));
} else {
  if (existsSync(`${state}.refuse`)) process.exit(FIREWALL_PROMPT_REFUSED);
  const reading = JSON.parse(readFileSync(state, 'utf8'));
  writeFileSync(state, JSON.stringify({ ...reading, rules: [{ action: 1, profiles: 0x7fffffff }] }));
}
