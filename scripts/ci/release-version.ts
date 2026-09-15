import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const tag = process.env.RELEASE_TAG ?? (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' ? `v${version}` : process.env.GITHUB_REF_NAME);
assert.equal(tag, `v${version}`, 'release tag must match package.json');
for (const file of ['packages/contracts/package.json', 'packages/core/package.json', 'packages/ui/package.json', 'apps/shell/package.json', 'apps/shell/src-tauri/tauri.conf.json']) {
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, version, `${file}: version mismatch`);
}
const cargo = readFileSync('apps/shell/src-tauri/Cargo.toml', 'utf8');
assert.equal(cargo.match(/^version = "([^"]+)"/m)?.[1], version, 'Cargo.toml: version mismatch');
const lock = readFileSync('apps/shell/src-tauri/Cargo.lock', 'utf8');
assert.equal(lock.match(/name = "boite-shell"\r?\nversion = "([^"]+)"/)?.[1], version, 'Cargo.lock: version mismatch');
console.log(`Release versions agree: v${version}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tag=v${version}\n`);
