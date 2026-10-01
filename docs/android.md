# The Android app

`apps/android` is a Trusted Web Activity: a small Android package that opens
one core's page in Chrome, full screen, with no address bar. Everything on
screen is the UI that core serves, so the app changes when the core updates,
not when the APK does. Chrome still runs the page, which keeps the service
worker, Web Push and the microphone working as they do in the installed web app
([phone.md](phone.md)). The package is `com.boite.two`.

## One host per APK

A TWA trusts a single origin, fixed at build time. The repository names none:
the nightly reads it from the repository variable `ANDROID_HOST`, a bare
hostname such as `boite.example.com`, and refuses to publish without it. The
page must be served over HTTPS at that host, through a proxy as in
[phone.md](phone.md).

Android opens the page full screen only after it has checked both halves of
Digital Asset Links. The app half is inside the APK and names the host. The site
half is `/.well-known/assetlinks.json`, which every core serves from
`packages/ui/public/.well-known/`, and names the package and the certificate
that signs it. When the check fails, the app still opens, in a Custom Tab with
an address bar.

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
`scripts/ci/android-apk.ts reuse` looks at the newest published release that
carries a signed APK and takes that file back, under its original name, when
all of these hold:

- `apps/android/` has no change between that release's tag and this commit;
- the APK opens the host `ANDROID_HOST` names now;
- its certificate is the one `assetlinks.json` publishes.

Otherwise the job builds, signs with `apksigner` and checks the certificate
again before uploading. A reused file keeps the version it was built with,
which is why its name can be older than the release it sits on. Nothing else
in the repository goes into the APK, so a UI or core change never rebuilds it.

The version name is the nightly version and the version code is the number of
commits on `main`, which only grows. `ci` builds an unsigned APK when
`apps/android/` or its pipeline changes and keeps it as the
`android-apk-unsigned` artifact of that run.

## The signing key

A PKCS12 keystore holding one key under the alias `boite`, stored as the
repository secrets `ANDROID_KEYSTORE` (base64 of the file) and
`ANDROID_KEYSTORE_PASSWORD`. The same password protects the key. A missing
secret fails the job: an unsigned APK is not a fallback, since no phone
installs one.

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
Regenerating it would write literal values over `app/build.gradle`, which reads
the host and version from Gradle properties, and drop the hand-added
`RECORD_AUDIO` permission that dictation needs. Edit the files instead.
