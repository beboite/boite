import { test } from 'bun:test';
import { protocolLoad } from '../../../tests/stress/lib/protocol-load.ts';

// A fresh core process exercises first-use imports even when other test files warmed their drivers.
test('concurrent first turns share each driver and retain their warm processes', () => protocolLoad(2), 60_000);
