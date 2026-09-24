// Compatibility entry points for archived callers. The default engine now owns
// an independent native connection on both TCP and Unix socket platforms.
export { connectIndependentNativeTransport } from './browser-lab-native.ts';
export { createBrowserLabEngine as createBrowserLabEngineTransportFix } from './browser-lab-engine.ts';
