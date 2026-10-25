/**
 * `boite window`: an agent's captures of the machine's desktop windows (a
 * Unity editor, a game, Blender) and the conversation's Window panel. The core
 * captures and writes the PNG; an app the project does not allow waits for the
 * owner's answer on a consent card. See docs/windows.md.
 */
import { resolve } from 'node:path';
import { parseWindowCrop, WINDOW_CLIP_LIMITS, WINDOW_SHOT_MAX, type DesktopWindow, type WindowShot, type WindowTarget } from '@boite/contracts';
import type { CoreClient } from './client.ts';
import type { CliIo } from './cli.ts';
import { Usage } from './cli-args.ts';

/** How long a window command may wait: the owner has 10 minutes to answer the consent card. */
export const WINDOW_REQUEST_TIMEOUT_MS = 11 * 60_000;

export const WINDOW_HELP = `boite window <command> [args] [--json]
  list                           the desktop windows: id, process, PID, size, state;
                                 titles only for apps the project allows
  screenshot <target> [--output <file.png>] [--max <px>] [--crop x,y,w,h]
                                 save the window as a PNG (default: the conversation's
                                 temporary folder). --max is the longest side, ${WINDOW_SHOT_MAX} by
                                 default, 0 for full size. --crop in pixels, or in
                                 fractions such as 0.5,0,0.5,0.5
  clip <target> --seconds <s> [--fps <n>] [--output <file.png>] [--max <px>]
                                 a labelled contact sheet of up to ${WINDOW_CLIP_LIMITS.seconds} s at up to ${WINDOW_CLIP_LIMITS.fps} fps
                                 (2 by default), as one PNG
  watch <target>                 show the window live in the user's Window panel
  close                          empty the Window panel
<target> is --id <id>, --process <name> or --title <part of the title>. Several
matches are refused with the candidates: pick one by --id.
An app the project has not allowed waits up to 10 minutes for the owner's answer
on a consent card. Password managers and the sign-in screen are never captured;
a minimized window is refused (restore it first: boite never restores or focuses).
Reading a picture costs about width x height / 750 tokens: keep --max low and
--crop to what matters. For emulators and simulators use boite device.`;

export interface WindowCliResult {
  lines: string[];
  value: unknown;
}

function flag(rest: string[], name: string): string | undefined {
  const at = rest.indexOf(name);
  if (at === -1) return undefined;
  const value = rest[at + 1];
  if (value === undefined || value.startsWith('--')) throw new Usage(`window ${name} needs a value`);
  rest.splice(at, 2);
  if (rest.includes(name)) throw new Usage(`window accepts one ${name}`);
  return value;
}

function number(rest: string[], name: string, integer: boolean): number | undefined {
  const raw = flag(rest, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < 0) throw new Usage(`window ${name} needs a ${integer ? 'whole ' : ''}number`);
  return value;
}

function target(rest: string[]): WindowTarget {
  const id = flag(rest, '--id'), process = flag(rest, '--process'), title = flag(rest, '--title');
  const given = [id, process, title].filter(value => value !== undefined).length;
  if (given !== 1) throw new Usage('window needs exactly one of --id, --process or --title');
  return id !== undefined ? { id } : process !== undefined ? { process } : { title: title! };
}

function done(rest: string[]): void {
  if (rest.length > 0) throw new Usage(`window does not take ${rest[0]}\n${WINDOW_HELP}`);
}

function windowLine(window: DesktopWindow): string {
  const state = window.excluded ? '  excluded' : window.minimized ? '  minimized' : '';
  return `${window.id}  ${window.process}  pid ${window.pid}  ${window.width}x${window.height}${state}${window.title ? `  "${window.title}"` : ''}`;
}

/** What reading the picture costs, as the agent guide counts it. */
const tokens = (shot: Pick<WindowShot, 'width' | 'height'>) => Math.ceil(shot.width * shot.height / 750);

function shotLines(shot: WindowShot): string[] {
  return [
    `path: ${shot.path}`,
    `size: ${shot.width}x${shot.height} pixels (window ${shot.source.width}x${shot.source.height}), about ${tokens(shot)} tokens to read`,
    `window: ${shot.windowId} (${shot.process})`,
  ];
}

export async function windowCommand(args: string[], io: CliIo, client: CoreClient, threadId: string): Promise<WindowCliResult> {
  const [command = 'list', ...rest] = args;
  switch (command) {
    case 'help': return { lines: [WINDOW_HELP], value: { help: WINDOW_HELP } };
    case 'list': {
      done(rest);
      const list = await client.call('windows.list', { threadId });
      const lines = list.support.available ? [] : [`window capture is unavailable here: ${list.support.reason ?? 'no reason given'}`];
      if (list.support.available && list.windows.length === 0) lines.push('windows: none');
      lines.push(...list.windows.map(windowLine));
      lines.push(list.watch ? `Window panel: ${list.watch.windowId} (${list.watch.process})` : 'Window panel: empty');
      return { lines, value: list };
    }
    case 'screenshot': {
      const output = flag(rest, '--output');
      const max = number(rest, '--max', true);
      const cropText = flag(rest, '--crop');
      const crop = cropText === undefined ? undefined : parseWindowCrop(cropText);
      if (crop === null) throw new Usage('window --crop takes x,y,w,h in pixels, or in fractions from 0 to 1');
      const named = target(rest);
      done(rest);
      const shot = await client.call('windows.screenshot', {
        threadId, target: named,
        ...(output === undefined ? {} : { output: resolve(io.cwd, output) }),
        ...(max === undefined ? {} : { max }),
        ...(crop === undefined ? {} : { crop }),
      });
      return { lines: shotLines(shot), value: shot };
    }
    case 'clip': {
      const output = flag(rest, '--output');
      const max = number(rest, '--max', true);
      const seconds = number(rest, '--seconds', false);
      const fps = number(rest, '--fps', true);
      if (seconds === undefined) throw new Usage(`window clip needs --seconds (at most ${WINDOW_CLIP_LIMITS.seconds})`);
      const named = target(rest);
      done(rest);
      const clip = await client.call('windows.clip', {
        threadId, target: named, seconds,
        ...(fps === undefined ? {} : { fps }),
        ...(output === undefined ? {} : { output: resolve(io.cwd, output) }),
        ...(max === undefined ? {} : { max }),
      });
      return { lines: [...shotLines(clip), `frames: ${clip.frames} over ${clip.seconds} s at ${clip.fps} fps`], value: clip };
    }
    case 'watch': {
      const named = target(rest);
      done(rest);
      const { watch } = await client.call('windows.watch', { threadId, target: named });
      return { lines: [`Window panel: ${watch.windowId} (${watch.process}); nothing is captured until the user presses Show`], value: { watch } };
    }
    case 'close': {
      done(rest);
      const { closed } = await client.call('windows.close', { threadId });
      return { lines: [closed ? 'Window panel closed' : 'the Window panel was already empty'], value: { closed } };
    }
    default: throw new Usage(`unknown window command ${command}\n${WINDOW_HELP}`);
  }
}
