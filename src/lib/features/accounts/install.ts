/**
 * The account switcher, as files rather than as a download.
 *
 * The toolkit is vendored in this repository under `plugins/`, so what gets
 * installed is what was reviewed here: nothing is fetched at install time and
 * there is no third-party repository in the trust path.
 *
 * Getting those files onto the machine is the awkward part. The backend refuses
 * writes outside a registered project root — `~/.claude-tools` is nobody's
 * project — and on a remote boite the files live on this side of the wire
 * anyway. So they are typed into the shell that is already being spawned to run
 * the installer: the same PTY the panel is showing, on whichever machine the
 * threads run on, with no new privilege and no new transport.
 */

/** Where the toolkit puts itself, and where the panel looks for it afterwards. */
export const TOOLS_DIR = ".claude-tools";
/** The file the installer stamps with what it just wrote. */
export const VERSION_FILE = ".version";
/** The two account pools, one per provider. */
export const CLAUDE_STORE = ".claude-cc-accounts";
export const CODEX_STORE = ".codex-cc-accounts";

/**
 * Where the vendored copy is unpacked, inside the tools directory.
 *
 * A subdirectory rather than the tools directory itself: `install.ps1` clears
 * the scripts it owns before copying the new ones in, and the package it is
 * copying from has to survive that.
 */
const PACKAGE_DIR = `${TOOLS_DIR}/.pkg`;

/**
 * PowerShell 7, by the name that resolves to it on the three platforms.
 *
 * `powershell` is Windows PowerShell 5.1, which the toolkit does not run on.
 * Asking for `pwsh` is also how the panel tells a machine that can take an
 * install from one that cannot.
 */
export const PWSH_CMD = "pwsh";

/**
 * The toolkit, file by file, bundled at build time.
 *
 * Eager and raw: these are a few dozen kilobytes of scripts, and a lazy import
 * would only move the same bytes behind a promise.
 */
const ROOT_FILES = import.meta.glob("../../../../plugins/claude-account-switcher/*.ps1", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const SRC_FILES = import.meta.glob(
  "../../../../plugins/claude-account-switcher/src/**/*.{ps1,js,md}",
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const VERSION_TEXT = import.meta.glob("../../../../plugins/claude-account-switcher/VERSION", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const PREFIX = "../../../../plugins/claude-account-switcher/";

/** The package, as `path relative to the plugin root` to `file contents`. */
function packageFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const source of [ROOT_FILES, SRC_FILES, VERSION_TEXT]) {
    for (const [key, content] of Object.entries(source)) {
      files.set(key.slice(PREFIX.length), content);
    }
  }
  return files;
}

/** The version this build would install, which is not the one on the machine. */
export function packageVersion(): string {
  return (packageFiles().get("VERSION") ?? "").trim() || "unknown";
}

/**
 * FNV-1a over the bytes of a file, mirrored on the PowerShell side.
 *
 * The unpack script is typed into an interactive shell, where a line that goes
 * wrong prints an error and the next line runs anyway. Nothing else would
 * notice a file that arrived truncated, so each one is checked against this
 * before the installer is allowed to start.
 */
function checksum(text: string): number {
  const bytes = new TextEncoder().encode(text);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash = (hash ^ byte) >>> 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  // In slices: a single spread of a large array overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * How much base64 goes on one typed line.
 *
 * Long enough that a file is a handful of lines, short enough to stay well
 * inside what a console input buffer takes in one go.
 */
const CHUNK = 1600;

function writeFileLines(relative: string, content: string): string[] {
  const encoded = base64(content);
  const lines = [`$p = Join-Path $pkg '${relative}'`, "$b = [Text.StringBuilder]::new()"];
  for (let i = 0; i < encoded.length; i += CHUNK) {
    lines.push(`[void]$b.Append('${encoded.slice(i, i + CHUNK)}')`);
  }
  lines.push("[IO.File]::WriteAllBytes($p, [Convert]::FromBase64String($b.ToString()))");
  lines.push(
    `try { if ((CcSum ([IO.File]::ReadAllBytes($p))) -ne ${checksum(content)}) ` +
      `{ $bad += '${relative}' } } catch { $bad += '${relative}' }`,
  );
  return lines;
}

/**
 * The checksum function itself, on one line.
 *
 * One line because a multi-line block typed at a prompt depends on the shell
 * holding a continuation open, which is not something to rely on here.
 */
const SUM_FUNCTION =
  "function CcSum([byte[]]$b) { $h = [long]2166136261; " +
  "foreach ($x in $b) { $h = $h -bxor [long]$x; $h = ([long]($h * 16777619)) -band 0xFFFFFFFFL }; return $h }";

export type InstallScript = { cmd: string; args: string[]; stdin?: string[] };

/**
 * The whole session: unpack the package, then run one of its scripts.
 *
 * Typed into an interactive `pwsh` line by line. The echo of several hundred
 * base64 lines is worth nothing to anyone reading the log, so the console is
 * cleared before the script that matters starts talking.
 */
function session(run: string): InstallScript {
  const files = packageFiles();
  const directories = new Set<string>();
  for (const relative of files.keys()) {
    const slash = relative.lastIndexOf("/");
    if (slash > 0) directories.add(relative.slice(0, slash));
  }

  const lines = [
    "$ErrorActionPreference = 'Stop'",
    SUM_FUNCTION,
    "$bad = @()",
    `$pkg = Join-Path $HOME '${PACKAGE_DIR}'`,
    "if (Test-Path -LiteralPath $pkg) { Remove-Item -LiteralPath $pkg -Recurse -Force }",
    "New-Item -ItemType Directory -Force -Path $pkg | Out-Null",
    ...[...directories].map(
      (dir) => `New-Item -ItemType Directory -Force -Path (Join-Path $pkg '${dir}') | Out-Null`,
    ),
    ...[...files].flatMap(([relative, content]) => writeFileLines(relative, content)),
    // Nothing is installed from a package that did not arrive whole.
    "if ($bad.Count) { Write-Host \"Incomplete: $($bad -join ', ')\" -ForegroundColor Red; exit 1 }",
    // Wrapped: a host without a real console — which is what a piped shell is —
    // throws rather than clearing, and would take the install down with it.
    "try { Clear-Host } catch { }",
    run,
    "exit $LASTEXITCODE",
  ];

  return { cmd: PWSH_CMD, args: ["-NoProfile", "-NoLogo"], stdin: lines };
}

/**
 * The first install: unpack, then let the toolkit's own installer finish.
 *
 * `install.ps1` copies the scripts into place, writes the slash commands, adds
 * the `claude-cc` function to the shell profile and stamps the version marker.
 */
export function installCommand(): InstallScript {
  return session('& (Join-Path $pkg "install.ps1")');
}

/**
 * Updating, which is the installer run again over a freshly unpacked copy.
 *
 * It overwrites the files it owns and leaves the account pools alone, so there
 * is no separate update path to keep working.
 */
export function updateCommand(): InstallScript {
  return installCommand();
}

/**
 * Removing the tools, and only the tools.
 *
 * `uninstall.ps1` takes back what was put down — the tools directory, the slash
 * commands, the profile function, the status line — and never touches the saved
 * logins. It runs from a freshly unpacked copy rather than from the installed
 * one, so it still works when the install is half missing.
 */
export function uninstallCommand(): InstallScript {
  return session('& (Join-Path $pkg "uninstall.ps1") -Yes');
}

/**
 * The switcher's own self-check, in the panel that installed it.
 *
 * The one command here that answers questions this panel cannot: whether the
 * credential store is readable and whether the pool still verifies. Run through
 * `-Command` so `$HOME` is expanded by the shell that owns it, which on a
 * remote boite is the machine the tools are actually on.
 */
export function doctorCommand(): InstallScript {
  return {
    cmd: PWSH_CMD,
    args: ["-NoProfile", "-Command", `& "$HOME/${TOOLS_DIR}/claude-cc.ps1" doctor -Provider all`],
  };
}
