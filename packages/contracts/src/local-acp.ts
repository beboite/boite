/*
 * The checks a local ACP command passes before the core writes it as a user
 * descriptor. The in-memory client runs the same function, so both refuse the
 * same input with the same field.
 */
import type { ProviderId } from './ids';
import type { LocalAcpCommand, Os } from './providers';

/** The longest name the picker shows for a provider added from Settings. */
export const LOCAL_ACP_NAME_MAX = 60;

/** What was wrong, in the shape every provider refusal carries. */
export interface LocalAcpRefusal {
  field: string;
  expected: string;
  message: string;
}

export type LocalAcpCheck =
  | { ok: true; id: ProviderId; command: LocalAcpCommand; executable: { kind: 'file' | 'path'; value: string } }
  | { ok: false; refusal: LocalAcpRefusal };

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A NUL ends a C string and a line break splits a command line: neither belongs in a program, an argument or a value. */
const UNSAFE = /[\0\r\n]/;
/** Windows launchers that Bun cannot spawn without a shell. */
const LAUNCHER = /\.(cmd|bat|ps1)$/i;

/**
 * The provider id a name turns into: lowercase letters, digits and dashes.
 * A name with none of those, in another script, gets a stable id of its own.
 */
export function localAcpId(name: string): ProviderId {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  if (slug.length > 0) return slug;
  let hash = 0x811c9dc5;
  for (const char of name) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `local-${hash.toString(36)}`;
}

function absolute(path: string, os: Os): boolean {
  return os === 'windows' ? /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path) : path.startsWith('/');
}

/** Checks the form's input field by field. Whether the program exists is the core's question. */
export function checkLocalAcpCommand(input: unknown, os: Os): LocalAcpCheck {
  const refuse = (field: string, expected: string, message: string): LocalAcpCheck => ({ ok: false, refusal: { field, expected, message } });
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return refuse('params', 'an object', 'the command must be an object');
  const raw = input as Record<string, unknown>;

  if (typeof raw['name'] !== 'string') return refuse('name', 'a string', 'name must be a string');
  const name = raw['name'].trim();
  if (name.length === 0 || name.length > LOCAL_ACP_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) {
    return refuse('name', `1 to ${LOCAL_ACP_NAME_MAX} printable characters`, `the name ${JSON.stringify(name)} cannot name a provider`);
  }

  if (typeof raw['command'] !== 'string') return refuse('command', 'a string', 'command must be a string');
  const command = raw['command'].trim();
  if (command.length === 0 || UNSAFE.test(command)) {
    return refuse('command', 'a program name on PATH or an absolute path', 'the command is empty or holds a line break');
  }
  const separated = os === 'windows' ? /[\\/]/.test(command) : command.includes('/');
  if (separated && !absolute(command, os)) {
    return refuse('command', 'a program name on PATH or an absolute path', `${command} is a relative path, which would depend on the folder Boite runs in`);
  }
  if (os === 'windows' && LAUNCHER.test(command)) {
    return refuse('command', 'the program itself, not a .cmd, .bat or .ps1 launcher', `${command} is a launcher script, which Boite cannot start without a shell`);
  }

  if (!Array.isArray(raw['args'])) return refuse('args', 'an array of strings', 'args must be an array');
  const args: string[] = [];
  for (const [index, arg] of raw['args'].entries()) {
    if (typeof arg !== 'string' || arg.length === 0 || UNSAFE.test(arg)) {
      return refuse(`args[${index}]`, 'a non-empty string with no line break', `argument ${index + 1} cannot be passed as one argument`);
    }
    args.push(arg);
  }

  if (typeof raw['env'] !== 'object' || raw['env'] === null || Array.isArray(raw['env'])) {
    return refuse('env', 'an object of names to values', 'env must be an object');
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw['env'])) {
    if (!ENV_NAME.test(key)) return refuse(`env.${key}`, 'a name of letters, digits and _, not starting with a digit', `${key} is not an environment variable name`);
    // A plain object drops this key on assignment, and the descriptor loader builds one too: the variable would never reach the agent.
    if (key === '__proto__') return refuse(`env.${key}`, 'any other variable name', `${key} cannot be stored in a provider file`);
    if (typeof value !== 'string' || value.length === 0 || /\0/.test(value)) {
      return refuse(`env.${key}`, 'a non-empty string', `the value of ${key} is empty or not text`);
    }
    env[key] = value;
  }

  return {
    ok: true,
    id: localAcpId(name),
    command: { name, command, args, env },
    executable: { kind: separated ? 'file' : 'path', value: command },
  };
}
