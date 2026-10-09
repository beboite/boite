/*
 * The little robots agents wear as their picture. A robot is five small
 * numbers, a family and four parts, kept in the profile's `avatar` field as
 * `bot:<family>.<shape>.<color>.<eyes>.<top>`, so it needs no field of its own
 * and fits the core's 40 characters. An agent whose avatar is empty wears the
 * robot its id draws; one or two characters (an emoji, letters) stay text.
 * `RobotFace.svelte` draws them.
 *
 * The box family is the desktop companion's own look: `shape` is the lid's
 * colour, `color` the body's, `eyes` the eyes' colour and `top` the accessory
 * on the lid. Its colour 0 is the classic companion, in the theme's own
 * colours. `lib/companion/skin.ts` turns a box into the colours the companion
 * wears; `seededRobot(seed, 'box')` draws one for an agent.
 */

export type RobotFamily = 'jelly' | 'bubble' | 'capsule' | 'retro' | 'box';

export interface Robot {
  family: RobotFamily;
  shape: number;
  color: number;
  eyes: number;
  top: number;
}

/** The part a picker row changes. */
export type RobotPart = 'family' | 'shape' | 'color' | 'eyes' | 'top';

/** How many choices each family offers per part. Colors are counted by `robotColors`. */
export const ROBOT_PARTS: Record<RobotFamily, Record<'shape' | 'eyes' | 'top', number>> = {
  jelly: { shape: 6, eyes: 8, top: 8 },
  bubble: { shape: 4, eyes: 5, top: 7 },
  capsule: { shape: 4, eyes: 5, top: 6 },
  retro: { shape: 4, eyes: 5, top: 4 },
  // The lid: the body's own colour, then the nine jelly colours.
  box: { shape: 10, eyes: 6, top: 12 },
};
export const ROBOT_FAMILIES: RobotFamily[] = ['jelly', 'bubble', 'capsule', 'retro', 'box'];
/** `--robot-1` to `--robot-9` in app.css; the jelly family reads its own, livelier `--jelly-1` to `--jelly-9`. */
export const ROBOT_COLORS = 9;
/** The box: the classic theme colours, then `--jelly-1` to `--jelly-9`. */
export const BOX_COLORS = 10;
/** The family a robot drawn from an id belongs to: the jelly blobs. */
export const DEFAULT_FAMILY: RobotFamily = 'jelly';

/** How many body colors a family offers. */
export function robotColors(family: RobotFamily): number {
  return family === 'box' ? BOX_COLORS : ROBOT_COLORS;
}

/** The color variable a robot wears: the jelly set, the pastel one the other families share, or the box's. */
export function robotColor(robot: Pick<Robot, 'family' | 'color'>): string {
  if (robot.family === 'box') return robot.color === 0 ? 'var(--color-surface)' : `var(--jelly-${robot.color})`;
  return `var(--${robot.family === 'jelly' ? 'jelly' : 'robot'}-${robot.color + 1})`;
}

const LETTER: Record<RobotFamily, string> = { bubble: 'a', capsule: 'b', retro: 'c', jelly: 'd', box: 'e' };
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
  return { family: robot.family, shape: robot.shape % parts.shape, color: robot.color % robotColors(robot.family), eyes: robot.eyes % parts.eyes, top: robot.top % parts.top };
}

/** The same robot for the same seed on every client: what a new agent starts with, and what Shuffle draws. */
export function seededRobot(seed: string, family: RobotFamily = DEFAULT_FAMILY): Robot {
  let hash = 2166136261;
  for (const char of seed) { hash ^= char.codePointAt(0)!; hash = Math.imul(hash, 16777619); }
  const pick = (n: number) => { hash = Math.imul(hash ^ (hash >>> 13), 1274126177); return Math.abs(hash) % n; };
  const parts = ROBOT_PARTS[family];
  return { family, shape: pick(parts.shape), color: pick(robotColors(family)), eyes: pick(parts.eyes), top: pick(parts.top) };
}

/*
 * A pastel `--robot-<n>` and the jelly color nearest to it, so a robot that
 * becomes a box (or a box that becomes a robot) keeps its color. Index: the
 * pastel color, value: the jelly color, both from 0.
 */
const PASTEL_TO_JELLY = [2, 1, 0, 6, 5, 5, 4, 3, 8];
const JELLY_TO_PASTEL = [2, 1, 0, 7, 6, 4, 3, 3, 8];

/** The box body color nearest to another family's color; a box keeps its own. */
export function boxColorOf(robot: Pick<Robot, 'family' | 'color'>): number {
  if (robot.family === 'box') return robot.color % BOX_COLORS;
  const color = robot.color % ROBOT_COLORS;
  return (robot.family === 'jelly' ? color : PASTEL_TO_JELLY[color]!) + 1;
}

/** Another family's color nearest to a box's; the classic box reads as the grey. */
function colorFromBox(color: number, family: RobotFamily): number {
  const jelly = color === 0 ? 8 : color - 1;
  return family === 'jelly' ? jelly : JELLY_TO_PASTEL[jelly]!;
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

/** One part changed, the others kept; a new family keeps what still fits, and a box its color. */
export function withPart(robot: Robot, part: RobotPart, value: number | RobotFamily): Robot {
  if (part === 'family') {
    const family = value as RobotFamily;
    if (family === robot.family || (family !== 'box' && robot.family !== 'box')) return clamp({ ...robot, family });
    const color = family === 'box' ? boxColorOf(robot) : colorFromBox(robot.color, family);
    return clamp({ ...robot, family, color });
  }
  return clamp({ ...robot, [part]: value as number });
}

/** How many choices a picker row offers for this robot. */
export function choices(robot: Robot, part: Exclude<RobotPart, 'family'>): number {
  return part === 'color' ? robotColors(robot.family) : ROBOT_PARTS[robot.family][part];
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
