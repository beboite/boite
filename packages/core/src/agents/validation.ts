import { invalidParams } from '../errors.ts';

export function object(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidParams(`${field}: expected an object`);
}
export function text(value: unknown, field: string, max = 4000, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw invalidParams(`${field}: expected ${empty ? '0' : '1'} to ${max} characters`);
  return value.trim();
}
export function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw invalidParams(`${field}: expected an integer from ${min} to ${max}`);
  return value;
}
export function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw invalidParams(`${field}: expected a boolean`);
  return value;
}
export function oneOf<T extends string>(value: unknown, field: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw invalidParams(`${field}: expected ${values.join(', ')}`);
  return value as T;
}
export function ids(value: unknown, field: string, max = 100): string[] {
  if (!Array.isArray(value) || value.length > max) throw invalidParams(`${field}: expected an array with at most ${max} entries`);
  const found = value.map((entry, index) => text(entry, `${field}[${index}]`, 160));
  if (new Set(found).size !== found.length) throw invalidParams(`${field}: duplicate entries are not allowed`);
  return found;
}

/** A field quoted from another thread, as a JSON string: its text can open no paragraph or heading of its own. */
export const quoted = (text: string): string => JSON.stringify(text);
