/*
 * The little robots agents wear as their picture. A robot is a style (its
 * family) and seven small numbers, kept in the profile's `avatar` field as
 * `bot:<family>.<shape>.<color>.<eyes>.<top>.<mouth>.<cheeks>.<gear>`, so it
 * needs no field of its own and fits the core's 40 characters. An agent whose
 * avatar is empty wears the robot its id draws; one or two characters (an
 * emoji, letters) stay text. `RobotFace.svelte` draws them.
 *
 * Only the body belongs to a family. Every other part is shared: each body
 * says where its eyes, mouth, cheeks and crown sit, and every eye, mouth, top,
 * cheek and gear is drawn there, so a part added once fits every style.
 */

export type RobotFamily = 'jelly' | 'bubble' | 'capsule' | 'retro';

export interface Robot {
  family: RobotFamily;
  shape: number;
  color: number;
  eyes: number;
  mouth: number;
  top: number;
  cheeks: number;
  gear: number;
}

/** The part a picker row changes. */
export type RobotPart = keyof Robot;
export type RobotNumberPart = Exclude<RobotPart, 'family'>;

/**
 * How many choices each part offers, the same for every family. Colors are
 * the nine lively `--jelly-<n>` then the nine pastel `--robot-<n>` of app.css.
 */
export const ROBOT_PARTS: Record<RobotNumberPart, number> = { shape: 6, color: 18, eyes: 16, mouth: 12, top: 18, cheeks: 4, gear: 5 };
/** The picker's rows, in the order a face is dressed. */
export const ROBOT_ROWS: RobotNumberPart[] = ['shape', 'color', 'eyes', 'mouth', 'top', 'cheeks', 'gear'];
export const ROBOT_FAMILIES: RobotFamily[] = ['jelly', 'bubble', 'capsule', 'retro'];
/** The family a robot drawn from an id belongs to: the jelly blobs. */
export const DEFAULT_FAMILY: RobotFamily = 'jelly';
/** The first pastel color: what the styles other than Jelly wore before colors were shared. */
const PASTEL = 9;

/** The color variable a robot wears. */
export function robotColor(robot: Pick<Robot, 'color'>): string {
  const color = robot.color % ROBOT_PARTS.color;
  return color < PASTEL ? `var(--jelly-${color + 1})` : `var(--robot-${color - PASTEL + 1})`;
}

const LETTER: Record<RobotFamily, string> = { bubble: 'a', capsule: 'b', retro: 'c', jelly: 'd' };
const PREFIX = 'bot:';

export function isRobotCode(avatar: string): boolean {
  return avatar.trim().startsWith(PREFIX);
}

/*
 * Codes written before parts were shared: `bot:<family>.<shape>.<color>.<face>.<top>`,
 * each number an index into that family's own lists. They keep their look:
 * the face becomes the shared eyes and mouth it drew, the top the shared top.
 */
type Legacy = { shape: number; color: number; faces: [eyes: number, mouth: number][]; tops: [top: number, gear: number][]; cheeks: number; pastel: boolean };
const LEGACY: Record<RobotFamily, Legacy> = {
  jelly: { shape: 6, color: 9, faces: [[0, 1], [1, 2], [4, 4], [5, 3], [6, 2], [7, 6], [7, 10], [8, 7]], tops: [[0, 0], [3, 0], [5, 0], [2, 0], [4, 0], [6, 0], [7, 0], [9, 0]], cheeks: 1, pastel: false },
  bubble: { shape: 4, color: 9, faces: [[2, 0], [3, 0], [4, 0], [5, 0], [6, 0]], tops: [[0, 0], [1, 0], [6, 0], [13, 0], [11, 0], [0, 1], [9, 0]], cheeks: 1, pastel: true },
  capsule: { shape: 4, color: 9, faces: [[3, 0], [2, 0], [8, 0], [5, 0], [9, 0]], tops: [[0, 0], [1, 0], [17, 0], [8, 0], [10, 0], [11, 0]], cheeks: 1, pastel: true },
  retro: { shape: 4, color: 9, faces: [[2, 0], [3, 0], [5, 0], [11, 0], [10, 0]], tops: [[1, 0], [2, 0], [12, 0], [0, 0]], cheeks: 0, pastel: true },
};

function fromLegacy(family: RobotFamily, shape: number, color: number, face: number, top: number): Robot {
  const old = LEGACY[family];
  const [eyes, mouth] = old.faces[face % old.faces.length]!;
  const [hat, gear] = old.tops[top % old.tops.length]!;
  return { family, shape: shape % old.shape, color: (color % old.color) + (old.pastel ? PASTEL : 0), eyes, mouth, top: hat, cheeks: old.cheeks, gear };
}

/** The robot a stored avatar names, or null when it names none or names one this build cannot draw. */
export function parseRobot(avatar: string): Robot | null {
  const value = avatar.trim();
  if (!value.startsWith(PREFIX)) return null;
  const [letter, ...rest] = value.slice(PREFIX.length).split('.');
  const family = ROBOT_FAMILIES.find(f => LETTER[f] === letter);
  if (!family || (rest.length !== 4 && rest.length !== 7) || rest.some(n => !/^\d{1,2}$/.test(n))) return null;
  const n = rest.map(Number);
  if (n.length === 4) return fromLegacy(family, n[0]!, n[1]!, n[2]!, n[3]!);
  const [shape, color, eyes, top, mouth, cheeks, gear] = n as [number, number, number, number, number, number, number];
  return clamp({ family, shape, color, eyes, mouth, top, cheeks, gear });
}

export function encodeRobot(robot: Robot): string {
  const r = clamp(robot);
  return `${PREFIX}${LETTER[r.family]}.${r.shape}.${r.color}.${r.eyes}.${r.top}.${r.mouth}.${r.cheeks}.${r.gear}`;
}

/** Every part inside its range: a code from a build with more parts still draws. */
function clamp(robot: Robot): Robot {
  const out = { family: robot.family } as Robot;
  for (const part of ROBOT_ROWS) out[part] = Math.abs(Math.trunc(robot[part] ?? 0)) % ROBOT_PARTS[part];
  return out;
}

function hasher(seed: string): (n: number) => number {
  let hash = 2166136261;
  for (const char of seed) { hash ^= char.codePointAt(0)!; hash = Math.imul(hash, 16777619); }
  return (n: number) => { hash = Math.imul(hash ^ (hash >>> 13), 1274126177); return Math.abs(hash) % n; };
}

/**
 * The robot an id draws, the same on every client: what an agent with an
 * empty avatar wears. It draws the way it did before parts were shared, so an
 * agent that never picked a robot keeps its face.
 */
export function seededRobot(seed: string): Robot {
  const pick = hasher(seed);
  const old = LEGACY[DEFAULT_FAMILY];
  const shape = pick(old.shape), color = pick(old.color), face = pick(old.faces.length), top = pick(old.tops.length);
  return fromLegacy(DEFAULT_FAMILY, shape, color, face, top);
}

/** What Shuffle may draw for a part: every choice, with a few kept rare so most robots stay plain. */
const SHUFFLE: Partial<Record<RobotNumberPart, number[]>> = {
  // Dizzy eyes read as a failure; the picker offers them, Shuffle does not.
  eyes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15],
  cheeks: [0, 1, 1, 1, 2, 3],
  gear: [0, 0, 0, 0, 0, 1, 2, 3, 4],
};

/** A new robot of a family from a seed, every part drawn: what Shuffle gives. */
export function shuffledRobot(seed: string, family: RobotFamily = DEFAULT_FAMILY): Robot {
  const pick = hasher(seed);
  const out = { family } as Robot;
  for (const part of ROBOT_ROWS) {
    const pool = SHUFFLE[part];
    out[part] = pool ? pool[pick(pool.length)]! : pick(ROBOT_PARTS[part]);
  }
  return out;
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

/** One part changed, the others kept: every part fits every family. */
export function withPart(robot: Robot, part: RobotPart, value: number | RobotFamily): Robot {
  if (part === 'family') return clamp({ ...robot, family: value as RobotFamily });
  return clamp({ ...robot, [part]: value as number });
}

/** How many choices a picker row offers. */
export function choices(part: RobotNumberPart): number {
  return ROBOT_PARTS[part];
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
