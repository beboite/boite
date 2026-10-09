/*
 * The companion's skin: the colours and the accessory a box robot gives the
 * companion box, so several agents standing side by side as companions can be
 * told apart. The skin is the agent's robot (`lib/robots.ts`, family `box`),
 * kept in its profile's `avatar`, so the Agents page draws the same look.
 *
 * What a caller needs:
 * - `seededRobot(seed, 'box')` (robots.ts): the box an id draws.
 * - `isBox(robot)`: whether a robot is a box; `CompanionCharacter` draws the
 *   classic companion for anything else, or for no skin at all.
 * - `toBox(robot)`: any robot as a box that keeps its colour and accessory slot.
 * - `boxPaint(robot)`: the CSS colours a box wears, for anything drawing it.
 *
 * Every colour is an app.css variable. Body colour 0 is the classic look: the
 * theme's surface with the foreground as outline and eyes.
 */

import { boxColorOf, ROBOT_PARTS, robotColor, type Robot } from '../robots';

export type BoxRobot = Robot & { family: 'box' };

/** The eyes' colours after the classic ink: lit eyes, rimmed in ink so they read on any body. */
const EYES = ['var(--robot-led)', 'var(--robot-halo)', 'var(--robot-blush)', 'var(--color-accent)', 'var(--robot-shine)'];

export interface BoxPaint {
  body: string;
  lid: string;
  /** The outline: the foreground on the classic body, else a darker shade of the body, which reads on any wallpaper. */
  line: string;
  eye: string;
  /** The eyes are lit (a colour, not the ink): they wear a dark rim. */
  lit: boolean;
  /** The accessory on the lid, 0 for none. */
  top: number;
}

export function isBox(robot: Robot | null | undefined): robot is BoxRobot {
  return robot?.family === 'box';
}

/** The box a robot of any family becomes: its colour kept, the classic lid and eyes, its top slot as accessory. */
export function toBox(robot: Robot): BoxRobot {
  if (isBox(robot)) return robot;
  return { family: 'box', shape: 0, color: boxColorOf(robot), eyes: 0, top: robot.top % ROBOT_PARTS.box.top };
}

/** The body's outline. */
export function boxLine(color: number): string {
  return color === 0 ? 'var(--color-foreground)' : `color-mix(in srgb, ${robotColor({ family: 'box', color })} 45%, var(--robot-ink))`;
}

/** The lid's colour: lid 0 is the body's own. */
export function boxLid(robot: Pick<Robot, 'shape' | 'color'>): string {
  return robotColor({ family: 'box', color: robot.shape === 0 ? robot.color : robot.shape });
}

/** The eyes' colour: eyes 0 are the ink, the foreground on the classic body and the robot ink on a coloured one. */
export function boxEye(robot: Pick<Robot, 'eyes' | 'color'>): string {
  if (robot.eyes === 0) return robot.color === 0 ? 'var(--color-foreground)' : 'var(--robot-ink)';
  return EYES[(robot.eyes - 1) % EYES.length]!;
}

export function boxPaint(robot: Robot): BoxPaint {
  return { body: robotColor({ family: 'box', color: robot.color }), lid: boxLid(robot), line: boxLine(robot.color), eye: boxEye(robot), lit: robot.eyes !== 0, top: robot.top };
}
