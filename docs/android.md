# The Android app

This is the Android client: it connects to an existing core, which
runs the agents and keeps the conversations. To host the core on the phone
itself, use the separate [Boite Server app and Termux](android-server.md).

`apps/android` is a Trusted Web Activity: a small Android package that opens
one HTTPS page in Chrome, full screen, without an address bar. The nightly's
opens the phone app's own address, `APP_ORIGIN` in the contracts
([phone](phone.md#the-app-on-its-own-address)), so UI updates change the app
without an APK update. Chrome runs the
page and keeps the service worker, Web Push and microphone working as they do
in the installed web app
([phone.md](phone.md)). The package is `com.boite.two`.

## One host per APK

A TWA trusts a single origin, fixed at build time. `android.yml` takes the
hostname of `APP_ORIGIN`, a page no machine serves and every core trusts: the
app reaches the machines of the group its phone was added to. Its `host` input,
a bare hostname such as `boite.example.com`, builds one for another HTTPS page
instead, a fork's own address or one core's behind a proxy as in
[phone.md](phone.md).

Android opens the page full screen only after it has checked both halves of
Digital Asset Links. The app half is inside the APK and names the host. The site
half is `/.well-known/assetlinks.json`, from `packages/ui/public/.well-known/`,
which the app's address and every core serve. It names the package and its signing
certificate. If validation fails, the app opens in a Custom Tab with an address
bar.

The page is public and the machines are private, so its sockets need Chrome's
"Local network" permission ([phone](phone.md#chromes-local-network-permission)).
It is changed in the settings of the browser the app runs in, Site settings,
Local network. The icon's Site settings shortcut (`enableSiteSettingsShortcut`
in `app/build.gradle`) only lists linked sites and their storage.

The APK also claims `https://<host>/` links. A pairing QR code names the
machine that drew it, so it opens the app only in an APK built for that
machine's Public HTTPS address; the nightly's reads it with **Scan the code**.

## Installing it

Each nightly release carries `boite-android-<app version>.apk`: download it on the phone,
allow the browser to install unknown apps when Android asks, and open Boite.
Android updates the app over an older one when the certificate matches and the
version code is higher. For another host, run `android.yml` by hand with
`release` on and `host` set, then install its `android-apk` artifact.

## Building a signed APK

The nightly runs `android.yml` with `release` on. Then `scripts/ci/android-apk.ts reuse` checks the newest published
release with a signed APK. It reuses that file under its original name when all
of these hold:

- `apps/android/` has no change between that release's tag and this commit;
- the APK opens the host chosen now;
- its certificate is the one `assetlinks.json` publishes.

Otherwise the job builds the APK, signs it with `apksigner` and checks the
certificate before uploading. Only the Android wrapper goes into the APK; UI
and core changes never rebuild it. `ci` builds an unsigned APK when
`apps/android/` or its pipeline changes and keeps it as the
`android-apk-unsigned` artifact of that run.

## The app version

The app has its own version, `MAJOR.MINOR.PATCH`, apart from Boite's release
version. `apps/android/VERSION` holds `MAJOR.MINOR`:

- Raise the minor by hand for a large addition to the app.
- Raise the major by hand for a rewrite.
- Nothing automatic ever changes either one.

The nightly sets the patch:

- A reused APK keeps its file and its version. A release with no change to the
  app does not move the version.
- A rebuilt APK with the same `MAJOR.MINOR` as the last published one takes
  that APK's patch plus one.
- A rebuilt APK after `VERSION` was raised starts at patch 0.
- The last APK named after Boite's release (`boite-2.0.0-nightly.*.apk`)
  carries no app version, so the first rebuild after it is `1.0.0`.

`android-apk.ts` reads the last version from the file name
`boite-android-<version>.apk`. It refuses a `VERSION` below the published app
and a minor or patch of 1000 or more. The version name is `MAJOR.MINOR.PATCH`.
The version code is `MAJOR * 1000000 + MINOR * 1000 + PATCH`. It sits above
the commit counts that older APKs used, and every newer version gets a larger
code. Editing `VERSION` changes `apps/android/`, so the next nightly rebuilds.

## The signing key

The PKCS12 keystore holds one signing key under the alias `boite`. Repository
secrets hold `ANDROID_KEYSTORE` (the base64-encoded file) and
`ANDROID_KEYSTORE_PASSWORD`; the same password protects the key. A missing
secret fails the job. It never falls back to an unsigned APK, which phones
cannot install.

Changing the key means a new SHA-256 fingerprint in `assetlinks.json`, and
every installed app must be uninstalled first, because Android refuses an
update signed by another certificate. The same key signs Boite Server
([Android server](android-server.md#publishing-the-app)), whose nightly checks
its APK against that fingerprint too.

## Building it locally

JDK 17 and the Android SDK (platform 37; Gradle fetches the build tools it
needs):

```sh
cd apps/android
ANDROID_HOME=<sdk> ./gradlew assembleRelease -PboiteHost=boite.example.com
```

`-PboiteVersion` and `-PboiteVersionCode` default to `VERSION` with patch 0
and the code that version gets. The unsigned APK lands in
`app/build/outputs/apk/release/app-release-unsigned.apk`; sign it with
`zipalign` and `apksigner` as the workflow does.

The wrapper came from [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap).
Regenerating it would replace the property-based host and version settings in
`app/build.gradle` with literal values. It would also drop the added
`RECORD_AUDIO` permission needed for dictation. Edit the files directly.
