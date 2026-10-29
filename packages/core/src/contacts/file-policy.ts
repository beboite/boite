/** Deterministic shared-file policy. Never pass the rejected path or bytes to a peer or reviewer. */
import { realpathSync, statSync, type BigIntStats } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { AgentContact, SharedSecretClass } from '@boite/contracts';

const SECRET_DIRS = new Set(['.git', '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker']);
export function secretPath(path: string): SharedSecretClass | null {
  const parts = path.replaceAll('\\', '/').split('/');
  if (parts.some(p => SECRET_DIRS.has(p.toLowerCase()))) return 'credential';
  for (const name of parts) {
    if (/^(?:\.env(?:\..*)?|\.envrc|\.dev\.vars)$/i.test(name)) return 'environment';
    if (/^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.+\.(?:pem|key|p12|pfx|jks|keystore))$/i.test(name)) return 'private-key';
    if (/^(?:\.?credentials?(?:\..*)?|\.?secrets?(?:\..*)?|\.netrc|_netrc|\.npmrc|\.pypirc|\.pgpass|\.htpasswd|\.git-credentials|.+\.(?:tfvars|tfstate|tfstate\.backup|kdbx))$/i.test(name)) return 'credential';
  }
  return null;
}
/** A second, conservative check for obvious credentials copied into an ordinary named file. */
export function secretText(value: string): SharedSecretClass | null {
  if (/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/i.test(value)) return 'private-key';
  if (/(?:^|[\s{,])\s*["']?(?:[\w.-]*[_-])?(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*\S+/i.test(value)) return 'secret';
  return null;
}
export const redactSharedText = (value: string): string => secretText(value) ? '[Shared file policy withheld credential-like text]' : value;
export function redactSharedContact(contact: AgentContact): AgentContact {
  return {...contact, title: redactSharedText(contact.title), machine: redactSharedText(contact.machine), resources: redactSharedText(contact.resources),
    ...(contact.branch ? {branch: redactSharedText(contact.branch)} : {}), ...(contact.project ? {project: redactSharedText(contact.project)} : {}), ...(contact.agent ? {agent: redactSharedText(contact.agent)} : {})};
}
export function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
export interface PolicyFile { real: string; path: string; identity: string; classification: SharedSecretClass | null }
export const policyIdentity = (real: string, stats: BigIntStats): string => `${real}|${stats.dev}|${stats.ino}|${stats.size}|${stats.mtimeNs}|${stats.ctimeNs}`;
export class PolicyPathError extends Error {
  constructor(readonly classification: SharedSecretClass) { super('shared file policy: expected a canonical file inside this job checkout'); }
}
/** Both the supplied spelling and its real target matter. Hard links cannot attest a secret-free origin. */
export function policyFile(root: string, path: string, directory = false): PolicyFile {
  // Refuse foreign drive/UNC/device paths, NTFS streams and normalized Windows aliases even on Linux.
  if (typeof path !== 'string' || /[\0\x00-\x1f]/.test(path) || /[:\\]/.test(path)
    || path.split('/').some(p => /[. ]$/.test(p) && p !== '.' && p !== '..')) throw new PolicyPathError('outside-project');
  try {
    const base = realpathSync(root), absolute = resolve(root, path);
    if (!inside(resolve(root), absolute)) throw new PolicyPathError('outside-project');
    const real = realpathSync(absolute);
    if (!inside(base, real)) throw new PolicyPathError('outside-project');
    const stats = statSync(real, {bigint: true});
    if (directory ? !stats.isDirectory() : !stats.isFile()) throw new PolicyPathError('outside-project');
    const logical = relative(resolve(root), absolute).split(sep).join('/');
    const canonical = relative(base, real).split(sep).join('/');
    return {real, path: canonical, identity: policyIdentity(real, stats),
      classification: secretPath(logical) ?? secretPath(canonical) ?? (!directory && stats.nlink > 1n ? 'secret' : null)};
  } catch (error) {
    if (error instanceof PolicyPathError) throw error;
    throw new PolicyPathError('outside-project');
  }
}
