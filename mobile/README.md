# Boite mobile (Android TWA)

Trusted Web Activity wrapper that ships the boite PWA as an installable Android
app. Generated with [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap)
and kept here as source so the wrapper versions alongside the app.

The app is a thin shell: it points at the PWA served by a boite-server (see the
root README / `crates/boite-server`) via the URL in `twa-manifest.json`. All UI
lives in the SvelteKit frontend embedded in the server; this module only owns
the Android packaging (icons, splash, manifest, Digital Asset Links).

## Layout

- `twa-manifest.json` — Bubblewrap config (host URL, colors, icons, app id).
- `assetlinks.json` — Digital Asset Links; must be served at
  `https://<host>/.well-known/assetlinks.json` so the TWA opens without the
  browser URL bar. The SHA-256 fingerprint must match the signing key.
- `app/src/` — generated Android sources (manifest, launcher, delegation
  service, resources).
- `gradlew`, `gradle/`, `*.gradle` — Gradle wrapper + build scripts.

## Build

```bash
cd mobile
./gradlew bundleRelease   # -> app/build/outputs/bundle/release/*.aab (Play Store)
./gradlew assembleRelease # -> app/build/outputs/apk/release/*.apk (sideload)
```

Then sign with `apksigner` / `jarsigner` using the release keystore.

## Signing secrets (not in the repo)

`android.keystore` and `KEYSTORE_PASSWORD.txt` are gitignored and must be kept
out of version control. Restore them locally before a release build. The
release keystore SHA-256 has to match the fingerprint baked into
`assetlinks.json`, otherwise the TWA falls back to a Custom Tab with a URL bar.
