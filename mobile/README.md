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

## What the phone layout is

`settings.mobileLayout` (guessed from the form factor on first run, pinned once
toggled) swaps the sidebar and the docked column for a top bar and a six-tab
bottom bar: Files, Git, Terminal, Todo, Projects, Settings. A project's overview
opens from the button on its card, since there is no project row to click.

All of it goes through the same `backend()` the PC uses, which on a phone is
always the WebSocket one, so what works here is what the server can answer. Two
things stay on the PC and are not oversights: the command palette (no keyboard
to open it with) and anything reading the local filesystem. The folder picker
falls back to the server-side browser, and the MCP shim is a path on the device
that spawns the PTY, so a launch from the phone gets no `--mcp-config`
(`src/lib/features/thread/agentMcp.ts`).

## Staying in step with the PWA

`manifest-checksum.txt` records the web manifest the wrapper was generated
from. When `static/manifest.webmanifest` changes (name, icons, scope, display),
the two drift apart and the wrapper wants regenerating:

```bash
npx @bubblewrap/cli update --appVersionName=$(node -p "require('../package.json').version")
```

Read the diff before keeping it. Bubblewrap writes literal values back over
`app/build.gradle`, which reads the version out of `package.json` on purpose —
that block has to survive. `twa-manifest.json`'s own `appVersionName` /
`appVersionCode` are cosmetic for the same reason and are kept in step by hand.
The `RECORD_AUDIO` permission in `AndroidManifest.xml` is hand-added for voice
input and has to survive a regeneration the same way.

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
