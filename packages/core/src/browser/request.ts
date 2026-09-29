import type { BrowserRequest } from '@boite/contracts';
import { invalidParams } from '../errors.ts';

export type Request = BrowserRequest & { maxSteps: number; timeoutMs: number; values: Record<string, string> };

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalidParams(`${field} must be a nonempty string of at most ${max} characters`);
  return value;
}
function url(value: unknown, field: string): string {
  const raw = text(value, field, 2048); let parsed: URL;
  try { parsed = new URL(raw); } catch { throw invalidParams(`${field} must be an http or https URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw invalidParams(`${field} must be an http or https URL without credentials`);
  return parsed.href;
}
function bound(value: unknown, fallback: number, max: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) throw invalidParams(`${field} must be an integer from 1 to ${max}`);
  return value;
}

export function validateBrowserRequest(raw: unknown): Request {
  if (!record(raw)) throw invalidParams('browser.start expects an object');
  for (const key of Object.keys(raw)) if (!['threadId', 'pluginId', 'url', 'goal', 'values', 'completion', 'maxSteps', 'timeoutMs'].includes(key)) throw invalidParams(`browser.start: unknown field ${key}`);
  if (!record(raw.completion)) throw invalidParams('completion must contain text and optionally an exact URL');
  for (const key of Object.keys(raw.completion)) if (!['text', 'url'].includes(key)) throw invalidParams(`completion: unknown field ${key}`);
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  if (raw.values !== undefined) {
    if (!record(raw.values) || Object.keys(raw.values).length > 8) throw invalidParams('values must contain at most eight named strings');
    for (const [key, value] of Object.entries(raw.values)) {
      text(key, 'values key', 80);
      if (typeof value !== 'string' || value.length > 2000) throw invalidParams(`values.${key} must be a string of at most 2000 characters`);
      values[key] = value;
    }
  }
  return {
    threadId: text(raw.threadId, 'threadId', 100), pluginId: text(raw.pluginId, 'pluginId', 64),
    url: url(raw.url, 'url'), goal: text(raw.goal, 'goal', 2000), values,
    completion: { text: text(raw.completion.text, 'completion.text', 500), ...(raw.completion.url === undefined ? {} : { url: url(raw.completion.url, 'completion.url') }) },
    maxSteps: bound(raw.maxSteps, 20, 60, 'maxSteps'), timeoutMs: bound(raw.timeoutMs, 120_000, 300_000, 'timeoutMs'),
  };
}

