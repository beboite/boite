import { expect, test } from 'vitest';
import { encodeRobot, parseRobot, robotColor, robotOf, ROBOT_COLORS, ROBOT_FAMILIES, ROBOT_PARTS, seededRobot, withPart } from './robots';

test('a robot round-trips through the avatar field and fits the core limit', () => {
  for (const family of ROBOT_FAMILIES) {
    for (let seed = 0; seed < 50; seed++) {
      const robot = seededRobot(`agent-${seed}`, family);
      const code = encodeRobot(robot);
      expect(code.length).toBeLessThanOrEqual(40);
      expect(parseRobot(code)).toEqual(robot);
    }
  }
});

test('an id draws the same robot on every client, and different ids differ', () => {
  expect(seededRobot('mira')).toEqual(seededRobot('mira'));
  // A new agent is a LocoRoco, in the games' flat colours; the other styles keep the pastel set.
  expect(seededRobot('mira').family).toBe('loco');
  expect(encodeRobot(seededRobot('mira'))).toMatch(/^bot:d\./);
  expect(robotColor({ family: 'loco', color: 0 })).toBe('var(--loco-1)');
  expect(robotColor({ family: 'bubble', color: 8 })).toBe('var(--robot-9)');
  const drawn = new Set(Array.from({ length: 40 }, (_, i) => encodeRobot(seededRobot(`id-${i}`))));
  expect(drawn.size).toBeGreaterThan(30);
});

test('what an agent wears: its robot, the robot of its id, or its emoji left as text', () => {
  expect(robotOf('mira', '')).toEqual(seededRobot('mira'));
  expect(robotOf('mira', 'bot:c.1.2.3.0')).toEqual({ family: 'retro', shape: 1, color: 2, eyes: 3, top: 0 });
  expect(robotOf('mira', '🦊')).toBeNull();
  expect(robotOf('mira', 'MJ')).toBeNull();
  // A code this build cannot read stays text rather than drawing something else.
  expect(robotOf('mira', 'bot:z.1.2.3.4')).toBeNull();
  expect(robotOf('mira', 'bot:a.1.2')).toBeNull();
});

test('parts out of range wrap into the family, and a new family keeps what still fits', () => {
  const parsed = parseRobot(`bot:c.${ROBOT_PARTS.retro.shape + 1}.${ROBOT_COLORS}.0.${ROBOT_PARTS.retro.top}`)!;
  expect(parsed).toEqual({ family: 'retro', shape: 1, color: 0, eyes: 0, top: 0 });
  const bubble = { family: 'bubble' as const, shape: 2, color: 4, eyes: 1, top: 6 };
  expect(withPart(bubble, 'family', 'retro')).toEqual({ family: 'retro', shape: 2, color: 4, eyes: 1, top: 6 % ROBOT_PARTS.retro.top });
  expect(withPart(bubble, 'color', 7)).toEqual({ ...bubble, color: 7 });
});
