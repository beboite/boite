# Devices

An agent can open an iOS Simulator or an Android emulator in its conversation.
The user watches it live in the Device panel, on the desktop and on a paired
phone, and can drive an Android device from there. This mirrors T3 Code's
Device panel and its `device_list`, `device_open`, `device_screenshot` and
`device_close` tools.

## What a machine can run

`packages/core/src/devices/sdk.ts` looks for the SDKs on the machine that runs
the core:

| Platform | Where                                                                                   | Tools                          |
| -------- | --------------------------------------------------------------------------------------- | ------------------------------ |
| Android  | `ANDROID_HOME`, then `ANDROID_SDK_ROOT`; else Android Studio's folder, then the SDK around an `adb` on `PATH` | `platform-tools/adb`, `emulator/emulator` |
| iOS      | macOS only, `xcrun` on `PATH`                                                           | `xcrun simctl`                 |

Android Studio's folder is `%LOCALAPPDATA%\Android\Sdk` on Windows,
`~/Library/Android/sdk` on macOS and `~/Android/Sdk` on Linux. When
`ANDROID_HOME` is set, it is the only place looked at.

`devices.list` reports each platform as available or not, with the reason:
no SDK, Platform-Tools missing, no Emulator package (connected phones and
running emulators still list), iOS on a machine that is not a Mac, or no Xcode
command line tools. Nothing is installed or downloaded.

Devices come from `adb devices -l`, `emulator -list-avds` and
`xcrun simctl list devices -j`. A device is acted on only after the SDK has
listed it. Every SDK command goes through `procs.spawn` as a tool process of
`system:devices`, so [the trace](trace.md) shows it.

## The agent's commands

The agent uses `boite device`, as it uses `boite browser` ([cli.md](cli.md)).
There is no MCP tool.

```sh
boite device list
boite device open Pixel_8_API_35        # boots it, waits, prints the adb -s prefix
boite device screenshot --output home.png
boite device tap 540 1200
boite device swipe 540 2000 540 400 300
boite device type hello
boite device key back
boite device close --shutdown
```

`open` starts a stopped emulator with `emulator -avd <name> -no-boot-anim`, or a
simulator with `xcrun simctl boot`, and waits up to 180 seconds for the boot. It
prints the command prefix that drives the device (`adb -s emulator-5554` or
`xcrun simctl`), so the agent can install and launch its app with the SDK
itself. Coordinates are screen pixels, as in a full-size screenshot. Without a
device id, a command uses the conversation's only open device.

`close` removes the device from the conversation's panel. `close --shutdown`
powers it off, which closes it in every conversation that showed it. Archiving
or removing a conversation releases its devices without powering them off.

A conversation shows at most four devices.

## The panel

The Device surface lists the open devices as tabs. Without one, or after **+**,
it lists the machine's devices, the reasons a platform is missing, and an
**Open** button per device. A booting device shows a waiting message. A failed
boot shows the SDK's error.

The screen is polled as JPEG frames (`devices.frame`), sized to the panel at
the screen's density and slowed down when the round trip is slow, as the
phone's remote browser view does. One capture serves every viewer within
200 ms, so a desktop and a phone watching the same device cost one
`screencap`.

On Android, a tap or a drag on the screen becomes `adb shell input tap` or
`swipe`. The footer has back, home, recents, rotate, power, enter and
backspace, and a field that types printable ASCII. Rotate reaches emulators
only (`adb emu rotate`). iOS Simulators are
view-only: `simctl` has no input command, and the agent drives them itself.

When a device opens in the conversation on screen, by the agent or by another
client, the panel opens on the Device tab (`lib/device-watch.ts`).

## Experiment

The Device card, its entry in the launcher (**D**) and the automatic opening
are behind **Device panel** in Settings > Experiments, off by default. It is a
client setting: each desktop and phone turns it on for itself. The agent's
commands work without it; the devices it opens wait in the conversation until
a client shows the panel.

## Remote clients and phones

All seven methods (`devices.list`, `open`, `sessions`, `frame`, `screenshot`,
`input`, `close`) are allowed for paired devices, and `devices.changed` is sent
only to clients subscribed to the conversation. A phone sees the devices of
the machine that runs the conversation, with no SDK of its own. The agent token
reaches every method but `devices.frame`, and only for its own conversation;
`packages/core/src/access.ts` records why for each.

## Limits

- One host, the core's own machine. A device plugged into another machine is
  not listed.
- iOS is view-only in the panel and needs macOS with Xcode.
- `type` sends printable ASCII through `adb shell input text`, which reads
  `%s` as a space.
- Frames are screenshots, not a video stream: a few frames per second.
- Tests use fake `adb`, `emulator` and `xcrun` scripts
  (`packages/core/test/fixtures/fake-sdk.ts`) and the fake client
  (`lib/fake-client/devices.ts`). No test boots a real emulator.
