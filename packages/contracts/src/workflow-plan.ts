/**
 * Pure workflow logic shared by the core, the in-memory client and the UI:
 * plan validation with refusals that name the field, dependency levels,
 * `{{path}}` substitution and output shapes. No runtime imports.
 */
import type { WorkflowCondition, WorkflowLimits, WorkflowPlan, WorkflowShape, WorkflowStepPlan } from './workflows';
import { DEFAULT_WORKFLOW_LIMITS, WORKFLOW_LIMITS } from './workflows';

const STEP_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const RESERVED = new Set(['item', 'index', 'steps']);
const TEMPLATE = /\{\{\s*([^{}]*?)\s*\}\}/g;

export class WorkflowPlanError extends Error {}

function fail(message: string): never {
  throw new WorkflowPlanError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${field}: expected 1 to ${max} characters`);
  return value;
}

/** `review.bugs.0` split into segments; refused unless every segment is a plain name or index. */
export function pathSegments(path: unknown, field: string): string[] {
  if (typeof path !== 'string' || !path.trim()) fail(`${field}: expected a path such as step.field`);
  const segments = path.trim().split('.');
  if (segments.some(s => !SEGMENT.test(s))) fail(`${field}: "${path}" is not a path; use step.field.0 with letters, digits, _ or -`);
  return segments;
}

function checkShapeDefinition(shape: unknown, field: string, depth = 0): WorkflowShape {
  if (depth > 5) fail(`${field}: shapes nest at most 5 levels`);
  if (shape === 'string' || shape === 'number' || shape === 'boolean' || shape === 'any') return shape;
  if (Array.isArray(shape)) {
    if (shape.length !== 1) fail(`${field}: a list shape holds exactly one item shape, such as ["string"]`);
    return [checkShapeDefinition(shape[0], `${field}[0]`, depth + 1)];
  }
  if (isRecord(shape)) {
    const keys = Object.keys(shape);
    if (keys.length === 0 || keys.length > 32) fail(`${field}: an object shape has 1 to 32 keys`);
    const out: Record<string, WorkflowShape> = {};
    for (const key of keys) {
      if (!SEGMENT.test(key)) fail(`${field}.${key}: keys use letters, digits, _ or -`);
      out[key] = checkShapeDefinition(shape[key], `${field}.${key}`, depth + 1);
    }
    return out;
  }
  fail(`${field}: expected "string", "number", "boolean", "any", [shape] or { key: shape }`);
}

function checkCondition(value: unknown, field: string): WorkflowCondition {
  if (!isRecord(value)) fail(`${field}: expected { path, equals | notEmpty | empty }`);
  const path = pathSegments(value.path, `${field}.path`).join('.');
  const ops = ['equals', 'notEmpty', 'empty'].filter(op => op in value);
  if (ops.length !== 1) fail(`${field}: expected exactly one of equals, notEmpty or empty`);
  if ('notEmpty' in value && value.notEmpty !== true) fail(`${field}.notEmpty: expected true`);
  if ('empty' in value && value.empty !== true) fail(`${field}.empty: expected true`);
  if ('equals' in value && !['string', 'number', 'boolean'].includes(typeof value.equals) && value.equals !== null) fail(`${field}.equals: expected a string, number, boolean or null`);
  return { path, ...('equals' in value ? { equals: value.equals as WorkflowCondition['equals'] } : {}), ...(value.notEmpty ? { notEmpty: true as const } : {}), ...(value.empty ? { empty: true as const } : {}) };
}

/** The `{{...}}` references of a brief, as segment lists. */
export function templateRefs(task: string, field: string): string[][] {
  const refs: string[][] = [];
  for (const match of task.matchAll(TEMPLATE)) refs.push(pathSegments(match[1], `${field} {{${match[1]}}}`));
  return refs;
}

export interface CheckedStep extends WorkflowStepPlan {
  /** `after` plus every step named by a path. */
  deps: string[];
}

export interface CheckOptions {
  /** Owner-approved profile ids. */
  profiles: string[];
  /** Step ids already in the run, for `extend`, with their dependencies. */
  existing?: { id: string; after: string[] }[];
}

export function checkSteps(value: unknown, options: CheckOptions, field = 'steps'): CheckedStep[] {
  const existing = options.existing ?? [];
  if (!Array.isArray(value) || value.length === 0) fail(`${field}: expected at least one step`);
  if (value.length + existing.length > WORKFLOW_LIMITS.steps) fail(`${field}: a run holds at most ${WORKFLOW_LIMITS.steps} steps`);
  const ids = new Set(existing.map(s => s.id));
  const declared = value.map((raw, i) => {
    const at = `${field}[${i}]`;
    if (!isRecord(raw)) fail(`${at}: expected an object with id, profile and task`);
    const id = raw.id;
    if (typeof id !== 'string' || !STEP_ID.test(id)) fail(`${at}.id: expected a letter then up to 31 letters, digits, _ or -`);
    if (RESERVED.has(id)) fail(`${at}.id: "${id}" is reserved`);
    if (ids.has(id)) fail(`${at}.id: "${id}" is used twice`);
    ids.add(id);
    return { raw, at, id };
  });
  const steps = declared.map(({ raw, at, id }): CheckedStep => {
    const profile = text(raw.profile, `${at}.profile`, 64);
    if (!options.profiles.includes(profile)) fail(`${at}.profile: "${profile}" is not an approved profile; expected one of ${options.profiles.join(', ') || '(none: the owner has configured no profile)'}`);
    const task = text(raw.task, `${at}.task`, WORKFLOW_LIMITS.taskChars);
    const title = raw.title === undefined ? undefined : text(raw.title, `${at}.title`, 80);
    const deps = new Set<string>();
    const needStep = (segments: string[], where: string, allowItem: boolean) => {
      const head = segments[0]!;
      if (head === 'item' || head === 'index') {
        if (!allowItem) fail(`${where}: {{${head}}} exists only in a step with forEach`);
        return;
      }
      if (head === id) fail(`${where}: a step cannot read its own output`);
      if (!ids.has(head)) fail(`${where}: no step "${head}"`);
      deps.add(head);
    };
    if (raw.after !== undefined) {
      if (!Array.isArray(raw.after)) fail(`${at}.after: expected a list of step ids`);
      raw.after.forEach((dep, j) => needStep([String(dep)], `${at}.after[${j}]`, false));
    }
    let forEach: string | undefined;
    if (raw.forEach !== undefined) {
      const segments = pathSegments(raw.forEach, `${at}.forEach`);
      needStep(segments, `${at}.forEach`, false);
      forEach = segments.join('.');
    }
    const when = raw.when === undefined ? undefined : checkCondition(raw.when, `${at}.when`);
    if (when) needStep(when.path.split('.'), `${at}.when.path`, false);
    for (const ref of templateRefs(task, `${at}.task`)) needStep(ref, `${at}.task`, forEach !== undefined);
    const output = raw.output === undefined ? undefined : checkShapeDefinition(raw.output, `${at}.output`);
    return { id, profile, task, deps: [...deps], ...(title ? { title } : {}), ...(raw.after ? { after: raw.after.map(String) } : {}), ...(forEach ? { forEach } : {}), ...(when ? { when } : {}), ...(output ? { output } : {}) };
  });
  // Existing steps cannot depend on new ones, so a cycle can only run through the new ones.
  const graph = new Map<string, string[]>([...existing.map(s => [s.id, s.after] as const), ...steps.map(s => [s.id, s.deps] as const)]);
  const state = new Map<string, 'open' | 'closed'>();
  const visit = (id: string, trail: string[]): void => {
    if (state.get(id) === 'closed') return;
    if (state.get(id) === 'open') fail(`${field}: cycle ${[...trail.slice(trail.indexOf(id)), id].join(' -> ')}`);
    state.set(id, 'open');
    for (const dep of graph.get(id) ?? []) visit(dep, [...trail, id]);
    state.set(id, 'closed');
  };
  for (const step of steps) visit(step.id, []);
  return steps;
}

export function checkLimits(value: unknown): WorkflowLimits {
  if (value === undefined) return { ...DEFAULT_WORKFLOW_LIMITS };
  if (!isRecord(value)) fail('limits: expected { maxConcurrent, maxSteps }');
  const limit = (key: keyof WorkflowLimits, max: number): number => {
    const n = value[key];
    if (n === undefined) return DEFAULT_WORKFLOW_LIMITS[key];
    if (!Number.isSafeInteger(n) || (n as number) < 1 || (n as number) > max) fail(`limits.${key}: expected an integer from 1 to ${max}`);
    return n as number;
  };
  return { maxConcurrent: limit('maxConcurrent', WORKFLOW_LIMITS.maxConcurrent), maxSteps: limit('maxSteps', WORKFLOW_LIMITS.maxSteps) };
}

export interface CheckedPlan {
  plan: WorkflowPlan;
  steps: CheckedStep[];
  limits: WorkflowLimits;
}

export function checkPlan(value: unknown, options: CheckOptions): CheckedPlan {
  if (!isRecord(value)) fail('plan: expected { name, steps }');
  const name = text(value.name, 'name', 80);
  const steps = checkSteps(value.steps, options);
  const limits = checkLimits(value.limits);
  const plan: WorkflowPlan = { name, steps: steps.map(({ deps: _deps, ...step }) => step), ...(value.limits ? { limits } : {}) };
  return { plan, steps, limits };
}

/** Columns: a step sits one column right of its deepest dependency. */
export function workflowLevels(steps: { id: string; after: string[] }[]): string[][] {
  const byId = new Map(steps.map(s => [s.id, s]));
  const depth = new Map<string, number>();
  const measure = (id: string, seen: Set<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const deps = byId.get(id)?.after.filter(d => byId.has(d)) ?? [];
    const d = deps.length ? Math.max(...deps.map(dep => measure(dep, seen))) + 1 : 0;
    depth.set(id, d);
    return d;
  };
  const levels: string[][] = [];
  for (const step of steps) (levels[measure(step.id, new Set())] ??= []).push(step.id);
  return levels.filter(Boolean);
}

/**
 * Reads a path through step values. A name applied to a list maps over it and
 * flattens one level, so `review.bugs` is every item's bugs in one list.
 */
export function resolvePath(root: Record<string, unknown>, segments: string[]): unknown {
  let value: unknown = root;
  for (const segment of segments) {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) {
      if (/^\d+$/.test(segment)) value = value[Number(segment)];
      else value = value.flatMap(entry => {
        const inner = isRecord(entry) ? entry[segment] : undefined;
        return inner === undefined ? [] : Array.isArray(inner) ? inner : [inner];
      });
    } else if (isRecord(value)) value = value[segment];
    else return null;
  }
  return value === undefined ? null : value;
}

export function renderValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return JSON.stringify(value, null, 2);
}

/** Fills `{{path}}`; a reference to a skipped step or a missing field is empty. */
export function renderTask(task: string, root: Record<string, unknown>): string {
  return task.replace(TEMPLATE, (_all, path: string) => renderValue(resolvePath(root, path.trim().split('.'))));
}

export function conditionHolds(condition: WorkflowCondition, root: Record<string, unknown>): boolean {
  const value = resolvePath(root, condition.path.split('.'));
  const empty = value === null || value === '' || value === false || (Array.isArray(value) && value.length === 0) || (isRecord(value) && Object.keys(value).length === 0);
  if (condition.notEmpty) return !empty;
  if (condition.empty) return empty;
  return value === condition.equals;
}

/** The first mismatch, as `path: expected ...`, or null when the value fits. */
export function shapeMismatch(value: unknown, shape: WorkflowShape, path = 'output'): string | null {
  if (shape === 'any') return value === undefined ? `${path}: missing` : null;
  if (shape === 'string') return typeof value === 'string' ? null : `${path}: expected a string`;
  if (shape === 'number') return typeof value === 'number' && Number.isFinite(value) ? null : `${path}: expected a number`;
  if (shape === 'boolean') return typeof value === 'boolean' ? null : `${path}: expected true or false`;
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) return `${path}: expected a list`;
    for (let i = 0; i < value.length; i++) {
      const inner = shapeMismatch(value[i], shape[0]!, `${path}[${i}]`);
      if (inner) return inner;
    }
    return null;
  }
  if (!isRecord(value)) return `${path}: expected an object with ${Object.keys(shape).join(', ')}`;
  for (const [key, inner] of Object.entries(shape)) {
    if (!(key in value)) return `${path}.${key}: missing`;
    const mismatch = shapeMismatch(value[key], inner, `${path}.${key}`);
    if (mismatch) return mismatch;
  }
  return null;
}

/** The last fenced ```json block of an answer, or the whole answer when it is JSON. */
export function extractJson(answer: string): { value: unknown } | null {
  const blocks = [...answer.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/g)];
  const candidates = [...blocks.reverse().map(m => m[1]!), answer.trim()];
  for (const candidate of candidates) {
    try {
      return { value: JSON.parse(candidate) };
    } catch { /* next */ }
  }
  return null;
}

/** A one-line preview of a fan-out item. */
export function itemLabel(item: unknown): string {
  const raw = typeof item === 'string' ? item : isRecord(item) ? String(item.title ?? item.name ?? item.path ?? item.file ?? item.id ?? JSON.stringify(item)) : JSON.stringify(item);
  const line = raw.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}
