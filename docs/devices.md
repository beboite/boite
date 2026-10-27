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
boite device key back                   # also home, recents, enter, backspace, tab, delete, up, down, left, right, power, rotate
boite device close --shutdown
```

`open` starts a stopped emulator with `emulator -avd <name> -no-boot-anim`, or a
simulator with `xcrun simctl boot`, and waits up to 180 seconds for the boot. It
prints the command prefix that drives the device (`adb -s emulator-5554` or
`xcrun simctl`), so the agent can install and launch its app with the SDK
itself. Coordinates are screen pixels, as in a full-size screenshot. Without a
device id, a command uses the conversation's only open device.

`close` removes the device from the conversation's panel. `close --shutdown`
powers it off, which closes it in every conversation that showed it; a
simulator someone already shut down counts as powered off. Archiving
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
`screencap`. An iOS capture goes through a PNG file in a private temporary
folder, deleted once read: since Xcode 27, `simctl io screenshot -` writes a
file named `-` instead of stdout. A frame keeps its id while the screen's PNG bytes stay the same
at that size and quality. The panel sends the id it shows as `previous`, and
the core answers `unchanged` with no picture and makes no JPEG. The panel
slows to a poll every 800 ms after three unchanged answers and every 1.5 s
after ten, until the screen moves or the user acts.

On Android, a tap or a drag on the screen becomes `adb shell input tap` or
`swipe`. The footer has back, home, recents, rotate, power, enter and
backspace, and a field that types printable ASCII. Rotate reaches emulators
only (`adb emu rotate`). iOS Simulators are
view-only: `simctl` has no input command, and the agent drives them itself.

A computer (any screen that is not `pointer: coarse`) has no text field: a
click on the screen gives it the keyboard. Printable ASCII characters are
typed, Enter, Backspace, Delete, Tab and the arrows are their Android keys,
and Escape is back. Characters typed while `adb` is busy leave as one text.
Paste types the computer's clipboard on one line, line breaks turned into
spaces, and refuses text `adb` cannot type. Wheel notches become one swipe
from under the pointer. Copying from the device is not available: `adb` has no
command that reads an Android clipboard.

When a device opens in the conversation on screen, by the agent or by another
client, the panel opens on the Device tab (`lib/device-watch.ts`).

## Live stream

The `deviceStream` setting (Settings › Experiments, off by default) plays an
Android emulator or phone as H.264 video through
[scrcpy](https://github.com/Genymobile/scrcpy). Off, nothing below runs and the
panel behaves as described above. An agent asks for it with
`boite settings request deviceStream true --why "..."`; `boite device list`
prints that command once when a phone is plugged in and the setting is off,
and `boite device help` names it.

**The server.** `packages/core/vendor/scrcpy/` holds the scrcpy 5.0.1 server
jar, its SHA-256 and its Apache 2.0 licence. The core checks the hash, copies
the jar into `<data dir>/scrcpy/` on first use and loads none of this before.
Per device, it runs `adb push` to
`/data/local/tmp/boite-scrcpy-server-v5.0.1.jar` at every start (the server
deletes its jar as it starts), reads `adb shell wm size`,
listens on a loopback port, maps the server's abstract socket to it with
`adb reverse`, and starts `app_process` with `audio=false`, `video_codec=h264`,
`clipboard_autosync=false` and a key frame every two seconds. The device
connects the video socket, then the control socket, and the reverse is removed
at once. Every adb call is a `procs.spawn` tool process of `system:devices`.
The core reads scrcpy's wire format itself (`packages/core/src/devices/scrcpy.ts`,
`stream.ts`): it needs the codec header, the 12-byte packet headers and six
control messages, which is less code than a client library and needs no
dependency at startup.

**One session per device.** Every viewer of a device shares its session; the
first `devices.stream` starts it. A larger panel restarts the encoder at its
size. The core keeps the chunks since the last key frame, so a viewer joining
late starts at once. The session stops 3 seconds after its last viewer's last
poll, or when its device closes, is unplugged, its server exits, the setting
turns off or the core stops. Stopping closes both sockets, which makes the
server restore the device and exit, removes any reverse still there and ends
the adb process the core started (its PID, never a name). A failed start is
answered `failed` with the server's words for 15 seconds, then tried again.

**Bandwidth.** The panel asks for its drawn size at the screen's density, at
most 1920 pixels on a computer and 1024 on a touch screen. The core rounds it
up to 480, 720, 1024, 1280, 1600, 1920 or 2560 pixels and encodes at
1.5 Mbit/s up to 720, 3 Mbit/s up to 1280 and 5 Mbit/s above, at most
60 frames a second. A long poll answers as soon as a chunk is newer than the
caller's, so a phone on a slow link reads fewer, larger answers instead of
queuing frames. It starts again from the next key frame when its decoder falls
behind.

**The panel.** Once Show is pressed, an Android device asks `devices.stream`
and decodes it with WebCodecs onto a canvas (`lib/device-stream.ts`);
screenshots fill in until the first frame. It shows screenshots, with a line
saying why, while the setting is off, when the browser has no `VideoDecoder`
for the stream or when the session failed. Hide, Pause and another tab stop
asking, which lets the session stop.

While the stream plays, input goes through scrcpy's control socket:

- A press, its moves and its release are touch events, so a drag is a real
  drag and a long press holds. Up to ten fingers.
- Wheel notches are scroll events at the pointer.
- Any character typed is sent. Printable ASCII goes as scrcpy text; other text
  is set as the device's clipboard and pasted, which replaces what the
  device's clipboard held.
- Paste sets the device's clipboard to the computer's and pastes it, line
  breaks included. Ctrl+C or Ctrl+X on a computer, or the copy key on a phone,
  copies the device's selection back.
- Keys are scrcpy key events.

The agent's `tap`, `swipe`, `type` and `key` go through the session while one
is up, so `type` takes any text then; otherwise they use `adb shell input`.
`devices.input` answers `via: 'stream'` or `via: 'adb'`. `screenshot` stays an
`adb exec-out screencap` PNG either way: it is full size and lossless, which
the stream is not.

Only the owner and paired devices may call `devices.stream` and
`devices.clipboard`. The agent has neither: the video is for the person
watching, and the agent already has screenshots and the device's own adb.

## Shown on request

The panel opens on the Device tab covered by a card that names the machine,
"This agent controls a device on m2", and a **Show** button. No frame is
captured or sent until the user presses it; **Hide** stops the frames again.
The choice holds for the conversation while the app stays open. The Device
card and its launcher key (**D**) are always offered: the agent's devices run
on the machine of the conversation, so every client shows them the same way.

## Remote clients and phones

All nine methods (`devices.list`, `open`, `sessions`, `frame`, `stream`,
`clipboard`, `screenshot`, `input`, `close`) are allowed for paired devices, and
`devices.changed` is sent only to clients subscribed to the conversation. A
phone sees the devices of the machine that runs the conversation, with no SDK
of its own. The agent token reaches every method but `devices.frame`,
`devices.stream` and `devices.clipboard`, and only for its own conversation;
`packages/core/src/access.ts` records why for each.

## Limits

- One host, the core's own machine. A device plugged into another machine is
  not listed.
- iOS is view-only in the panel and needs macOS with Xcode.
- Without the live stream, `type`, the keyboard and a paste send printable
  ASCII through `adb shell input text`, which reads `%s` as a space. Accented
  letters and emoji do not reach a device, and nothing is copied back from one.
- Without the live stream, frames are screenshots: a few frames per second.
- The live stream is Android only, from the core's own machine, with no audio.
  Text beyond ASCII goes through the device's clipboard and replaces it.
  An agent's input uses the stream only while a viewer keeps it up.
- Tests use fake `adb`, `emulator` and `xcrun` scripts
  (`packages/core/test/fixtures/fake-sdk.ts`), whose `app_process` is a fake
  scrcpy server that streams `packages/core/test/fixtures/scrcpy-video.h264`
  and logs the control messages it reads, and the fake client
  (`lib/fake-client/devices.ts`), which streams four H.264 frames. No test
  boots a real emulator.
