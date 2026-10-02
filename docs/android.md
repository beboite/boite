# The Android app

`apps/android` is a Trusted Web Activity: a small Android package that opens
one core's page in Chrome, full screen, without an address bar. The core serves
the UI, so core updates change the app without an APK update. Chrome runs the
page and keeps the service worker, Web Push and microphone working as they do
in the installed web app
([phone.md](phone.md)). The package is `com.boite.two`.

## One host per APK

A TWA trusts a single origin, fixed at build time. The repository has no
hard-coded origin. The nightly requires `ANDROID_HOST`, a repository variable
containing a bare hostname such as `boite.example.com`, before publishing. The
page must be served over HTTPS at that host, through a proxy as in
[phone.md](phone.md).

Android opens the page full screen only after it has checked both halves of
Digital Asset Links. The app half is inside the APK and names the host. The site
half is `/.well-known/assetlinks.json`, served by every core from
`packages/ui/public/.well-known/`. It names the package and its signing
certificate. If validation fails, the app opens in a Custom Tab with an address
bar.

The APK also claims `https://<host>/` links. Set the core's Public HTTPS address
to that same host, and a pairing QR code scanned on the phone opens the app
instead of the browser.

## Installing it

Each nightly release lists `boite-<version>.apk`. Download it on the phone,
allow the browser to install unknown apps when Android asks, and open Boite.
The first launch shows the page without a session; pair it from the desktop
the usual way. Android updates the app over an older one when the certificate
matches and the version code is higher.

## What a nightly publishes

The nightly calls `.github/workflows/android.yml` with `release: true`.
`scripts/ci/android-apk.ts reuse` checks the newest published release with a
signed APK. It reuses that file under its original name when all of these hold:

- `apps/android/` has no change between that release's tag and this commit;
- the APK opens the host `ANDROID_HOST` names now;
- its certificate is the one `assetlinks.json` publishes.

Otherwise the job builds the APK, signs it with `apksigner` and checks the
certificate before uploading. A reused APK keeps its original version, so its
filename may name an older version than the release containing it. Only the
Android wrapper goes into the APK; UI and core changes never rebuild it.

The version name is the nightly version and the version code is the number of
commits on `main`, which only grows. `ci` builds an unsigned APK when
`apps/android/` or its pipeline changes and keeps it as the
`android-apk-unsigned` artifact of that run.

## The signing key

The PKCS12 keystore holds one signing key under the alias `boite`. Repository
secrets hold `ANDROID_KEYSTORE` (the base64-encoded file) and
`ANDROID_KEYSTORE_PASSWORD`; the same password protects the key. A missing
secret fails the job. It never falls back to an unsigned APK, which phones
cannot install.

Changing the key means a new SHA-256 fingerprint in `assetlinks.json`, and
every installed app must be uninstalled first, because Android refuses an
update signed by another certificate.

## Building it locally

JDK 17 and the Android SDK (platform 36; Gradle fetches the build tools it
needs):

```sh
cd apps/android
ANDROID_HOME=<sdk> ./gradlew assembleRelease -PboiteHost=boite.example.com
```

`-PboiteVersion` and `-PboiteVersionCode` default to the `package.json`
version and `1`. The unsigned APK lands in
`app/build/outputs/apk/release/app-release-unsigned.apk`; sign it with
`zipalign` and `apksigner` as the workflow does.

The wrapper came from [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap).
Regenerating it would replace the property-based host and version settings in
`app/build.gradle` with literal values. It would also drop the added
`RECORD_AUDIO` permission needed for dictation. Edit the files directly.
