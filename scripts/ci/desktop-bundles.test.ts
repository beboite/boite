import { expect, test } from 'bun:test';
import { plan } from './desktop-bundles';

const v = '2.0.0';

test('each macOS runner publishes its DMG and an updater archive named for its architecture', () => {
  for (const [host, arch] of [['darwin-arm64', 'aarch64'], ['darwin-x64', 'x64']]) {
    const files = [`dmg/Boite_${v}_${arch}.dmg`, 'dmg/bundle_dmg.sh', 'macos/Boite.app', 'macos/Boite.app.tar.gz', 'macos/Boite.app.tar.gz.sig'];
    expect(plan(host!, files).map((source) => source.to)).toEqual([
      `Boite_${v}_${arch}.dmg`, `Boite_${v}_${arch}.app.tar.gz`, `Boite_${v}_${arch}.app.tar.gz.sig`,
    ]);
  }
});

test('each Linux runner publishes a signed .deb and AppImage of its own architecture', () => {
  const files = [`deb/Boite_${v}_arm64.deb`, `deb/Boite_${v}_arm64.deb.sig`, 'appimage/Boite.AppDir',
    `appimage/Boite_${v}_aarch64.AppImage`, `appimage/Boite_${v}_aarch64.AppImage.sig`];
  expect(plan('linux-arm64', files).map((source) => source.to)).toEqual(files.filter((f) => f !== 'appimage/Boite.AppDir').map((f) => f.split('/')[1]));
});

test('a missing signature, payload or a stale bundle of another architecture fails the runner', () => {
  expect(() => plan('linux-x64', [`deb/Boite_${v}_amd64.deb`, `deb/Boite_${v}_amd64.deb.sig`, `appimage/Boite_${v}_amd64.AppImage`])).toThrow('missing updater signature');
  expect(() => plan('linux-x64', [`deb/Boite_${v}_amd64.deb`, `deb/Boite_${v}_amd64.deb.sig`])).toThrow('linux-x86_64-appimage');
  expect(() => plan('linux-x64', [`deb/Boite_${v}_amd64.deb`, `deb/Boite_${v}_amd64.deb.sig`, `appimage/Boite_${v}_amd64.AppImage`,
    `appimage/Boite_${v}_amd64.AppImage.sig`, `deb/Boite_${v}_arm64.deb`])).toThrow('unexpected');
  expect(() => plan('darwin-arm64', ['macos/Boite.app.tar.gz', 'macos/Boite.app.tar.gz.sig'])).toThrow('one DMG');
  expect(() => plan('win32-x64', [])).toThrow('linux or darwin');
});
