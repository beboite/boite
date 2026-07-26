// Wrapping a command in a shell so its functions and aliases resolve lives in
// the backend now (`boite_core::shell::wrap_argv`): the decision needs the PATH
// and the profile of whichever machine owns the PTY, which for a remote boite
// is not this one.

const POWERSHELL_CMD = /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?\s*$/i;

// PowerShell's slow start is banner + profile load. -NoLogo is free; the
// profile skip is opt-in since users may rely on aliases defined there.
export function withPowershellFastFlags(
  cmd: string,
  args: string[],
  noProfile: boolean,
): string[] {
  if (!POWERSHELL_CMD.test(cmd)) return args;
  const out = [...args];
  if (!out.some((a) => /^-nologo$/i.test(a))) out.unshift("-NoLogo");
  if (noProfile && !out.some((a) => /^-nop(?:rofile)?$/i.test(a))) {
    out.unshift("-NoProfile");
  }
  return out;
}
