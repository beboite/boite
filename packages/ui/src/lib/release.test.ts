import { expect, test } from 'vitest';
import { releaseVersion } from '../../release-version';
import { RELEASE_VERSION } from './release';
import { UI_VERSION } from './store/connection.svelte';

// The nightly build stamps the root package.json; `scripts/ci/nightly-build.test.ts`
// checks the build's define, this the value the tests run under and what reads it.
test('the client and the hello report the release the root package.json names', () => {
  const root = releaseVersion();
  expect(RELEASE_VERSION).toBe(root);
  expect(UI_VERSION).toBe(root);
  expect(RELEASE_VERSION).not.toBe('dev');
});
