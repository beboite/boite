# Project icons

Each project in the sidebar and in the phone's project menu shows a tile: the
project's logo when its folder has one, the mark of its stack when it has none,
and the first letter of its name otherwise.

## What the core looks for

The core reads the folder after a project is added, once for any project it
has never checked or where it found nothing (after the first `projects.list`
of a run), and when the owner picks **Refresh icon** in the project menu. The
detection is in `packages/core/src/project-icons.ts`.

1. Files named like a logo in a fixed list of folders, each listed once and
   never walked: the root, `public`, `static`, `assets`, `docs`, `images`,
   `img`, `media`, `art`, `web`, `resources`, `branding`, `.github`, `src`,
   `src/assets`, `src/app`, `app` and a few nested public folders. `logo` ranks
   first, then names starting with `logo`, then `icon`, `app-icon` or `brand`,
   then names starting with `icon`, then `favicon`, then `apple-touch-icon` and
   `android-chrome`, then any name containing `logo` or `icon`. On the same
   name, SVG beats PNG, then WebP, JPEG and ICO; an earlier folder beats a
   later one.
2. Icons at a known path: `src-tauri/icons/128x128.png`, `build/appicon.png`,
   `.idea/icon.svg`, the web icons of a Flutter project and Android launcher
   icons, highest density first. They beat a favicon and lose to a logo.
3. Icons a manifest declares: `<link rel="icon">` in an `index.html`, the
   `icons` of a web app manifest (largest first), `bundle.icon` in
   `src-tauri/tauri.conf.json` and the `icon` field of `package.json`. An href
   with a scheme, a drive, `//` or `..` is ignored.
4. Without an image, the stack from marker files at the root, first match wins:
   Unity, Unreal, Godot, Flutter or Dart, then the `package.json` dependencies
   (Electron, Next.js, Nuxt, SvelteKit or Svelte, Angular, React), then Gradle
   (Android), Swift, `Cargo.toml`, `go.mod`, Python, .NET, `pom.xml`,
   `CMakeLists.txt`, and any other `package.json` as Node.js.

An image is at most 256 KB, must be SVG, PNG, WebP, JPEG or ICO with matching
first bytes, and must be a plain file, not a link. A manifest over 256 KB is
not parsed, and a folder listing stops at 2,000 names. A detection that takes
longer than 5 s is dropped; **Refresh icon** then reports the folder and keeps
the icon it had.

## How it reaches a client

The result is stored in the journal's `project_icons` table, so a start or a
`projects.list` reads no folder. A project carries `icon: { kind: 'image',
version }` or `icon: { kind: 'tech', id }`, a few dozen bytes. The image itself
comes from `projects.icon`, which a paired phone may call: the UI asks for it
once per project and version, and draws it as a `data:` URL in an `<img>`, where
an SVG runs no script and loads nothing. A changed icon reaches every client as
`project.updated`.

The stack marks are inline SVG paths from the simple-icons package (CC0-1.0);
each mark is its owner's trademark, and `packages/ui/src/lib/tech-icons.ts`
notes the licence recorded for each one. Stacks whose recorded mark licence
forbids commercial use or derivatives (Tauri, Vue) are not drawn, and their
projects fall through to the next rule.
