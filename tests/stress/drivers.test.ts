import { test } from 'bun:test';
import { protocolLoad } from './lib/protocol-load.ts';

test('24 protocol processes keep streams and warm sessions isolated, stop together and recover after agent exits',
  () => protocolLoad(8), 120_000);
