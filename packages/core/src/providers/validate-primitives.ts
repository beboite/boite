// Primitive descriptor checks and structured provider rejections.
import type { ProviderRejected } from '@boite/contracts';

/** Thrown with the file, the field and what was expected, so a caller can tell a refusal from any other error. */
export class Rejection extends Error {
  constructor(readonly rejected: ProviderRejected) {
    super(rejected.message);
    this.name = 'ProviderRejection';
  }
}

export function reject(file: string, field: string, expected: string, message: string): never {
  throw new Rejection({ file, field, expected, message });
}

export function asObject(value: unknown, file: string, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    reject(file, field, 'an object', `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown, file: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    reject(file, field, 'a non-empty string', `${field} must be a non-empty string`);
  }
  return value;
}

export function asBoolean(value: unknown, file: string, field: string): boolean {
  if (typeof value !== 'boolean') reject(file, field, 'a boolean', `${field} must be a boolean`);
  return value;
}

export function asArray(value: unknown, file: string, field: string): unknown[] {
  if (!Array.isArray(value)) reject(file, field, 'an array', `${field} must be an array`);
  return value;
}

export function asPositiveInteger(value: unknown, file: string, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    reject(file, field, 'a positive whole number of bytes', `${field} must be a positive whole number`);
  }
  return value;
}

export function checkKeys(obj: Record<string, unknown>, allowed: readonly string[], file: string, path: string): void {
  for (const key of Object.keys(obj)) {
    if (allowed.includes(key)) continue;
    const field = path === '' ? key : `${path}.${key}`;
    reject(file, field, `one of: ${allowed.join(', ')}`, `unknown field ${field}`);
  }
}

export function checkRoots(value: unknown, file: string): string[] {
  const raw = asArray(value, file, 'roots');
  const roots: string[] = [];
  raw.forEach((entry, index) => {
    const root = asString(entry, file, `roots[${index}]`);
    for (const segment of root.split(/[\\/]/)) {
      if (segment === '..') {
        reject(file, `roots[${index}]`, 'a path with no ".." segment', `roots[${index}] escapes its root: ${root}`);
      }
    }
    roots.push(root);
  });
  return roots;
}

export function checkStringMap(value: unknown, file: string, field: string): Record<string, string> {
  const obj = asObject(value, file, field);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(obj)) out[key] = asString(entry, file, `${field}.${key}`);
  return out;
}

