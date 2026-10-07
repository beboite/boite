/*
 * The little robots agents wear as their picture. A robot is five small
 * numbers, a family and four parts, kept in the profile's `avatar` field as
 * `bot:<family>.<shape>.<color>.<eyes>.<top>`, so it needs no field of its own
 * and fits the core's 40 characters. An agent whose avatar is empty wears the
 * robot its id draws; one or two characters (an emoji, letters) stay text.
 * `RobotFace.svelte` draws them.
 */

export type RobotFamily = 'loco' | 'bubble' | 'capsule' | 'retro';

export interface Robot {
  family: RobotFamily;
  shape: number;
  color: number;
  eyes: number;
  top: number;
}

/** The part a picker row changes. */
export type RobotPart = 'family' | 'shape' | 'color' | 'eyes' | 'top';

/** How many choices each family offers per part. Every family has nine colours. */
export const ROBOT_PARTS: Record<RobotFamily, Record<'shape' | 'eyes' | 'top', number>> = {
  loco: { shape: 4, eyes: 5, top: 5 },
  bubble: { shape: 4, eyes: 5, top: 7 },
  capsule: { shape: 4, eyes: 5, top: 6 },
  retro: { shape: 4, eyes: 5, top: 4 },
};
export const ROBOT_FAMILIES: RobotFamily[] = ['loco', 'bubble', 'capsule', 'retro'];
/** `--robot-1` to `--robot-9` in app.css; the LocoRoco family reads its own `--loco-1` to `--loco-9`. */
export const ROBOT_COLORS = 9;
/** The family a robot drawn from an id belongs to: the jelly blobs of LocoRoco. */
export const DEFAULT_FAMILY: RobotFamily = 'loco';

/** The colour variable a robot wears: LocoRoco's flat, saturated set, or the pastel one the others share. */
export function robotColor(robot: Pick<Robot, 'family' | 'color'>): string {
  return `var(--${robot.family === 'loco' ? 'loco' : 'robot'}-${robot.color + 1})`;
}

/** The ninth LocoRoco colour is black: its mouth and lids are drawn light. */
export const LOCO_DARK = 8;

const LETTER: Record<RobotFamily, string> = { bubble: 'a', capsule: 'b', retro: 'c', loco: 'd' };
const PREFIX = 'bot:';

export function isRobotCode(avatar: string): boolean {
  return avatar.trim().startsWith(PREFIX);
}

/** The robot a stored avatar names, or null when it names none or names one this build cannot draw. */
export function parseRobot(avatar: string): Robot | null {
  const value = avatar.trim();
  if (!value.startsWith(PREFIX)) return null;
  const [letter, ...rest] = value.slice(PREFIX.length).split('.');
  const family = ROBOT_FAMILIES.find(f => LETTER[f] === letter);
  if (!family || rest.length !== 4 || rest.some(n => !/^\d{1,2}$/.test(n))) return null;
  const [shape, color, eyes, top] = rest.map(Number) as [number, number, number, number];
  return clamp({ family, shape, color, eyes, top });
}

export function encodeRobot(robot: Robot): string {
  const r = clamp(robot);
  return `${PREFIX}${LETTER[r.family]}.${r.shape}.${r.color}.${r.eyes}.${r.top}`;
}

/** Every part inside its family's range: a code from a build with more parts still draws. */
function clamp(robot: Robot): Robot {
  const parts = ROBOT_PARTS[robot.family];
  return { family: robot.family, shape: robot.shape % parts.shape, color: robot.color % ROBOT_COLORS, eyes: robot.eyes % parts.eyes, top: robot.top % parts.top };
}

/** The same robot for the same seed on every client: what a new agent starts with, and what Shuffle draws. */
export function seededRobot(seed: string, family: RobotFamily = DEFAULT_FAMILY): Robot {
  let hash = 2166136261;
  for (const char of seed) { hash ^= char.codePointAt(0)!; hash = Math.imul(hash, 16777619); }
  const pick = (n: number) => { hash = Math.imul(hash ^ (hash >>> 13), 1274126177); return Math.abs(hash) % n; };
  const parts = ROBOT_PARTS[family];
  return { family, shape: pick(parts.shape), color: pick(ROBOT_COLORS), eyes: pick(parts.eyes), top: pick(parts.top) };
}

/**
 * What an agent wears: its own robot, the robot its id draws when it chose
 * nothing, or null when it chose a short text (an emoji), which stays text.
 */
export function robotOf(id: string, avatar: string): Robot | null {
  const value = avatar.trim();
  if (!value) return seededRobot(id);
  return parseRobot(value);
}

/** One part changed, the others kept; a new family keeps what still fits. */
export function withPart(robot: Robot, part: RobotPart, value: number | RobotFamily): Robot {
  if (part === 'family') return clamp({ ...robot, family: value as RobotFamily });
  return clamp({ ...robot, [part]: value as number });
}

/** How many choices a picker row offers for this robot. */
export function choices(robot: Robot, part: Exclude<RobotPart, 'family'>): number {
  return part === 'color' ? ROBOT_COLORS : ROBOT_PARTS[robot.family][part];
}

/** The agent's own avatar when it is one or two characters (an emoji, a letter), else the initials of its first two words. */
export function avatarText(name: string, avatar = ''): string {
  const own = avatar.trim();
  if (own && [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(own)].length <= 2) return own;
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(word => Array.from(word)[0]).join('').toUpperCase() || '?';
}

/** One of the eight series tints, the same for an id on every client. */
export function tintOf(id: string): string {
  let hash = 0;
  for (const c of id) hash = (hash * 31 + c.codePointAt(0)!) | 0;
  return `var(--series-${(Math.abs(hash) % 8) + 1})`;
}
