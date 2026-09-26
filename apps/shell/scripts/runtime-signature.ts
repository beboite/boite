/**
 * The Authenticode check the Windows sidecar has to pass before it is staged.
 *
 * The sidecar is Bun's runtime downloaded from its GitHub release. The release's
 * SHASUMS256.txt comes from the same place, so it catches a cut download and not
 * a swapped asset. The publisher's signature does: a runtime that is not signed,
 * or signed by anyone but Bun's publisher, is refused.
 */

/**
 * The organization Bun's Windows runtimes are signed by, as Windows reports the
 * signer certificate's subject (bun-windows-x64-baseline 1.4.2, 2026-09-25).
 */
export const BUN_PUBLISHER = 'Codeblog CORP';

export interface Signature {
  /** `Valid`, `NotSigned`, `HashMismatch`, ...; empty when PowerShell answered nothing. */
  status: string;
  /** The signer certificate's subject, `CN=..., O=..., ...`; empty without one. */
  subject: string;
}

/** The `O=` part of a certificate subject, or null. */
export function organization(subject: string): string | null {
  for (const part of subject.split(/,(?=\s*[A-Z]+=)/)) {
    const [key, ...value] = part.trim().split('=');
    if (key === 'O') return value.join('=').replace(/^"|"$/g, '').trim();
  }
  return null;
}

/** Why `path` must not ship as the sidecar, or null when its signature is Bun's and valid. */
export function signatureProblem(path: string, signature: Signature): string | null {
  if (signature.status !== 'Valid') {
    const status = signature.status === '' ? 'no status (PowerShell answered nothing)' : `status "${signature.status}"`;
    return `${path} has signature ${status}, expected "Valid"`;
  }
  const signer = organization(signature.subject);
  if (signer !== BUN_PUBLISHER) {
    return `${path} is signed by "${signature.subject}", expected O=${BUN_PUBLISHER}, Bun's publisher`;
  }
  return null;
}

/**
 * Asks Windows PowerShell for the signature of `path`. PowerShell 7 exports a
 * PSModulePath that Windows PowerShell 5.1 cannot load its own modules from, and
 * Get-AuthenticodeSignature then answers nothing: the child gets the rest of the
 * environment without it.
 */
export function readSignature(path: string): Signature {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.PSModulePath;
  const literal = path.replaceAll("'", "''");
  const script = `$s = Get-AuthenticodeSignature -LiteralPath '${literal}'; [string]$s.Status; [string]$s.SignerCertificate.Subject`;
  const read = Bun.spawnSync(['powershell', '-NoProfile', '-NonInteractive', '-Command', script], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });
  const [status = '', subject = ''] = read.stdout.toString().split(/\r?\n/).map((line) => line.trim());
  return { status, subject };
}
