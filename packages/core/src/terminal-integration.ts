/*
 * Shell integration for the thread terminal. Bash and PowerShell are started
 * with a few lines that mark each prompt and command on the screen, the way
 * VS Code and Windows Terminal do: OSC 133 A (prompt starts), B (input
 * starts), C (the command runs) and D;<status> (it ended), and OSC 633 P for
 * the working directory and the history file. The emulator draws a status dot
 * per command and jumps between them; the core reads the history file for the
 * recent commands list. Nothing is written into the user's own files: bash
 * reads ours through `--rcfile` after `~/.bashrc`, PowerShell gets it in
 * `-EncodedCommand` after its profile, which no execution policy blocks.
 * `BOITE_TERMINAL_HISTORY` gives PowerShell another history file, which bash
 * takes from `HISTFILE`: tests use them to keep away from the user's.
 */

import { existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, fstatSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import type { TerminalShell } from '@boite/contracts';
import type { Shell } from './terminals.ts';

/** Commands the recent list returns, newest first. */
export const HISTORY_COMMANDS = 500;
/** How much of the end of a history file is read: a few thousand commands. */
const HISTORY_TAIL_BYTES = 512 * 1024;
/** The integration reports its history file in the first output; past this much, it is not looked for. */
const ANNOUNCE_SCAN_CHARS = 64 * 1024;

export const BASH_INTEGRATION = String.raw`# Boite shell integration: marks prompts and commands for the terminal and
# saves each command to the history file as soon as it runs.
if [ -r ~/.bashrc ]; then . ~/.bashrc; fi
if [ -n "\${__boite_integration-}" ]; then return 0 2>/dev/null; fi
__boite_integration=1
shopt -s histappend 2>/dev/null
__boite_first=1
__boite_precmd() {
  local code=$?
  if [ -z "$__boite_first" ]; then builtin printf '\e]133;D;%s\a' "$code"; fi
  __boite_first=
  builtin history -a 2>/dev/null
  return $code
}
__boite_postcmd() {
  local code=$?
  builtin printf '\e]633;P;Cwd=%s\a' "$PWD"
  case "$PS1" in *'133;A'*) ;; *) PS1='\[\e]133;A\a\]'"$PS1"'\[\e]133;B\a\]' ;; esac
  case "\${PS0-}" in *'133;C'*) ;; *) PS0="\${PS0-}"$'\e]133;C\a' ;; esac
  return $code
}
if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND=(__boite_precmd "\${PROMPT_COMMAND[@]}" __boite_postcmd)
else
  PROMPT_COMMAND=$'__boite_precmd\n'"\${PROMPT_COMMAND-}"$'\n__boite_postcmd'
fi
builtin printf '\e]633;P;HistoryFile=%s\a' "\${HISTFILE-$HOME/.bash_history}"
`.replaceAll('\\${', '${');

/** Windows PowerShell 5.1 has no `e escape: the control characters are built from [char]. */
export const POWERSHELL_INTEGRATION = String.raw`
if ($Global:__BoiteIntegration) { return }
$Global:__BoiteIntegration = $true
$Global:__BoiteE = [char]27
$Global:__BoiteB = [char]7
$Global:__BoitePrompt = $function:prompt
$Global:__BoiteHistory = (Get-History -Count 1).Id
function Global:prompt {
  $ok = $Global:?
  $code = $Global:LASTEXITCODE
  $e = $Global:__BoiteE; $b = $Global:__BoiteB
  $out = ''
  $last = (Get-History -Count 1).Id
  if ($null -ne $last -and $last -ne $Global:__BoiteHistory) {
    $Global:__BoiteHistory = $last
    $status = if ($ok) { 0 } elseif ($code -is [int] -and $code -ne 0) { $code } else { 1 }
    $out += "$e]133;D;$status$b"
  }
  $out += "$e]133;A$b"
  $loc = $ExecutionContext.SessionState.Path.CurrentLocation
  if ($loc.Provider.Name -eq 'FileSystem') { $out += "$e]633;P;Cwd=$($loc.ProviderPath)$b" }
  $text = (& $Global:__BoitePrompt) -join ''
  $Global:LASTEXITCODE = $code
  "$out$text$e]133;B$b"
}
if (Get-Command PSConsoleHostReadLine -ErrorAction SilentlyContinue) {
  $Global:__BoiteReadLine = $function:PSConsoleHostReadLine
  function Global:PSConsoleHostReadLine {
    $line = & $Global:__BoiteReadLine
    if (-not [string]::IsNullOrWhiteSpace($line)) { [Console]::Write("$($Global:__BoiteE)]133;C$($Global:__BoiteB)") }
    $line
  }
}
# PSReadLine takes its path from the profile folder, never from $env:APPDATA: a test names another file here.
if ($env:BOITE_TERMINAL_HISTORY) { try { Set-PSReadLineOption -HistorySavePath $env:BOITE_TERMINAL_HISTORY } catch {} }
try { $path = (Get-PSReadLineOption).HistorySavePath } catch { $path = $null }
if ($path) { [Console]::Write("$($Global:__BoiteE)]633;P;HistoryFile=$path$($Global:__BoiteB)") }
`;

function shellName(exe: string, platform: NodeJS.Platform): string {
  return (platform === 'win32' ? win32.basename(exe) : posix.basename(exe)).toLowerCase().replace(/\.exe$/, '');
}

/** What the client is told about the shell: its family and whether it marks its commands. */
export function describeShell(shell: Shell, integrated: boolean, platform: NodeJS.Platform = process.platform): TerminalShell {
  const name = shellName(shell.exe, platform);
  return { name, kind: shell.kind, integrated };
}

/**
 * The shell with its integration, or the shell as it is: cmd, sh, zsh, fish
 * and a login bash (macOS, which skips `--rcfile`) start untouched, and
 * `BOITE_TERMINAL_INTEGRATION=0` turns it off.
 */
export function integrate(
  shell: Shell,
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): { shell: Shell; integrated: boolean } {
  if (env['BOITE_TERMINAL_INTEGRATION'] === '0') return { shell, integrated: false };
  if (shell.kind === 'powershell') {
    const encoded = Buffer.from(POWERSHELL_INTEGRATION, 'utf16le').toString('base64');
    return { shell: { ...shell, args: [...shell.args, '-NoExit', '-EncodedCommand', encoded] }, integrated: true };
  }
  if (shell.kind !== 'posix' || platform === 'win32' || shellName(shell.exe, platform) !== 'bash' || shell.args.includes('-l')) {
    return { shell, integrated: false };
  }
  const dir = join(dataDir, 'shell-integration');
  const file = join(dir, 'boite.bash');
  try {
    writeIfChanged(dir, file, BASH_INTEGRATION);
  } catch {
    return { shell, integrated: false };
  }
  return { shell: { ...shell, args: [...shell.args, '--rcfile', file, '-i'] }, integrated: true };
}

/**
 * The script in place, rewritten only when it differs, through a temporary
 * file and a rename: a second shell opening at the same moment must never
 * find it truncated while the first bash is still reading it.
 */
function writeIfChanged(dir: string, file: string, text: string): void {
  try {
    if (readFileSync(file, 'utf8') === text) return;
  } catch {
    // Not written yet.
  }
  mkdirSync(dir, { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o644 });
  renameSync(temporary, file);
}

/** Where a shell keeps its history when it did not say: bash's default, PSReadLine's default. */
export function defaultHistoryFile(
  shell: TerminalShell,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string | null {
  if (shell.kind === 'powershell') {
    if (platform === 'win32') {
      const appData = env['APPDATA'] ?? win32.join(home, 'AppData', 'Roaming');
      return win32.join(appData, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt');
    }
    const data = env['XDG_DATA_HOME'] ?? posix.join(home, '.local', 'share');
    return posix.join(data, 'powershell', 'PSReadLine', 'ConsoleHost_history.txt');
  }
  if (shell.name === 'bash') return env['HISTFILE'] ?? posix.join(home, '.bash_history');
  return null;
}

/**
 * Watches a shell's first output for the history file its integration names.
 * The marker can arrive split across chunks, so a short tail is kept.
 */
export class HistoryAnnounce {
  path: string | null = null;
  private seen = 0;
  private tail = '';

  feed(data: string): void {
    if (this.path !== null || this.seen > ANNOUNCE_SCAN_CHARS) return;
    this.seen += data.length;
    const text = this.tail + data;
    const match = /\x1b\]633;P;HistoryFile=([^\x07\x1b]*)(?:\x07|\x1b\\)/.exec(text);
    if (match !== null) {
      this.path = match[1]!.length > 0 ? match[1]! : null;
      this.seen = Infinity;
      return;
    }
    this.tail = text.slice(-512);
  }
}

/**
 * The commands of a history file, newest first and each once. PSReadLine
 * writes a newline inside a command as a backtick and a line break, and reads
 * it back by dropping that one backtick: a line the user ended with their own
 * continuation backtick is saved with two and keeps one here, as PSReadLine
 * recalls it. Bash with HISTTIMEFORMAT puts `#<seconds>` lines between commands.
 */
export function parseHistory(text: string, kind: TerminalShell['kind'], max = HISTORY_COMMANDS): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const commands: string[] = [];
  let pending: string[] = [];
  for (const line of lines) {
    if (kind === 'powershell') {
      if (line.endsWith('`')) {
        pending.push(line.slice(0, -1));
        continue;
      }
      const command = [...pending, line].join('\n');
      pending = [];
      if (command.trim().length > 0) commands.push(command);
      continue;
    }
    if (/^#\d+$/.test(line) || line.trim().length === 0) continue;
    commands.push(line);
  }
  const seen = new Set<string>();
  const newest: string[] = [];
  for (let i = commands.length - 1; i >= 0 && newest.length < max; i--) {
    const command = commands[i]!;
    const key = command.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    newest.push(command);
  }
  return newest;
}

/** The end of a history file as text, or null when it cannot be read. */
export function readHistoryTail(path: string, bytes = HISTORY_TAIL_BYTES): string | null {
  if (!existsSync(path)) return null;
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    // A cut tail starts mid-command: drop up to the first line break.
    if (length < size) {
      const line = text.indexOf('\n');
      return line === -1 ? '' : text.slice(line + 1);
    }
    return text;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
