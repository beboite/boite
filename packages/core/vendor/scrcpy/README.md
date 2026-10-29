# scrcpy server

`scrcpy-server-v5.0.1.jar` is the unmodified `scrcpy-server-v5.0.1` asset of
[scrcpy v5.0.1](https://github.com/Genymobile/scrcpy/releases/tag/v5.0.1),
renamed with a `.jar` extension so the bundler copies it as a file.

- Version: 5.0.1. `packages/core/src/devices/scrcpy.ts` passes it to the
  server, which refuses any other.
- SHA-256: `764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536`
  (733930 bytes). The core checks it before pushing the file to a phone.
- Licence: Apache License 2.0, in `LICENSE` beside this file.

```
Copyright (C) 2018 Genymobile
Copyright (C) 2018-2026 Romain Vimont

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
```

The Device panel's live stream pushes it to the Android device with adb and
runs it there with `app_process` (docs/devices.md). To update it, download the
new release's `scrcpy-server-v<version>` asset, check its SHA-256 against the
release page, replace this file and change the version, hash and size in
`scrcpy.ts` and here, then read the release notes for protocol changes.
