/**
 * The release this build of the UI belongs to. Vite defines `__BOITE_VERSION__`
 * from the root package.json (`release-version.ts`), which the nightly build
 * stamps, and the tests' setup sets it the same way. The core's tests and the CLI import the client
 * under Bun, where nothing defines it: they get `dev`.
 */
export const RELEASE_VERSION: string = typeof __BOITE_VERSION__ === 'string' ? __BOITE_VERSION__ : 'dev';
