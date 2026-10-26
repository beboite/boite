import { expect, test } from 'vitest';
import { encodeRobot, parseRobot, robotColor, robotOf, ROBOT_FAMILIES, ROBOT_PARTS, ROBOT_ROWS, seededRobot, shuffledRobot, withPart } from './robots';

test('a robot round-trips through the avatar field and fits the core limit', () => {
  for (const family of ROBOT_FAMILIES) {
    for (let seed = 0; seed < 50; seed++) {
      const robot = shuffledRobot(`agent-${seed}`, family);
      const code = encodeRobot(robot);
      expect(code.length).toBeLessThanOrEqual(40);
      expect(code).toMatch(/^bot:[a-d](\.\d{1,2}){7}$/);
      expect(parseRobot(code)).toEqual(robot);
    }
  }
  // The largest code still fits.
  const most = Object.fromEntries(ROBOT_ROWS.map(part => [part, ROBOT_PARTS[part] - 1]));
  expect(encodeRobot({ family: 'retro', ...most } as never).length).toBeLessThanOrEqual(40);
});

test('an agent that never picked a robot keeps the face its id drew before parts were shared', () => {
  // The codes the four-part build drew for these ids, read through the legacy path.
  for (const [id, old] of [['mira', 'bot:d.2.2.5.3'], ['agent-1', 'bot:d.3.6.6.6'], ['nova', 'bot:d.4.7.7.0']] as const) {
    expect(seededRobot(id)).toEqual(parseRobot(old));
    expect(robotOf(id, '')).toEqual(seededRobot(id));
  }
  expect(seededRobot('mira').family).toBe('jelly');
  const drawn = new Set(Array.from({ length: 40 }, (_, i) => encodeRobot(seededRobot(`id-${i}`))));
  expect(drawn.size).toBeGreaterThan(30);
});

test('a four-part code keeps its look: its face becomes the shared eyes and mouth, its top the shared top or gear', () => {
  // A retro with a visor and an antenna, in the pastel set it wore.
  expect(robotOf('x', 'bot:c.1.2.3.0')).toEqual({ family: 'retro', shape: 1, color: 11, eyes: 11, mouth: 0, top: 1, cheeks: 0, gear: 0 });
  // A smiling jelly with a bow, in its lively set, blushing.
  expect(parseRobot('bot:d.0.4.0.7')).toEqual({ family: 'jelly', shape: 0, color: 4, eyes: 0, mouth: 1, top: 9, cheeks: 1, gear: 0 });
  // The bubble's glasses were a top: now they are gear, and it wears nothing on its head.
  expect(parseRobot('bot:a.2.0.2.5')).toEqual({ family: 'bubble', shape: 2, color: 9, eyes: 4, mouth: 0, top: 0, cheeks: 1, gear: 1 });
  // A capsule's side pods and its headphones stay two different tops.
  expect(parseRobot('bot:b.0.0.0.2')?.top).toBe(17);
  expect(parseRobot('bot:b.0.0.0.5')?.top).toBe(11);
  expect(robotColor({ color: 0 })).toBe('var(--jelly-1)');
  expect(robotColor({ color: 17 })).toBe('var(--robot-9)');
});

test('what an agent wears: its robot, or its emoji left as text, and a code this build cannot read stays text', () => {
  expect(robotOf('mira', '🦊')).toBeNull();
  expect(robotOf('mira', 'MJ')).toBeNull();
  expect(robotOf('mira', 'bot:z.1.2.3.4')).toBeNull();
  expect(robotOf('mira', 'bot:a.1.2')).toBeNull();
  expect(robotOf('mira', 'bot:a.1.2.3.4.5')).toBeNull();
});

test('every part fits every style: a new style keeps the whole face, and parts out of range wrap', () => {
  const dressed = { family: 'jelly' as const, shape: 5, color: 16, eyes: 15, mouth: 11, top: 17, cheeks: 3, gear: 4 };
  for (const family of ROBOT_FAMILIES) expect(withPart(dressed, 'family', family)).toEqual({ ...dressed, family });
  expect(parseRobot(`bot:b.${ROBOT_PARTS.shape + 1}.${ROBOT_PARTS.color}.0.${ROBOT_PARTS.top}.0.0.0`)).toEqual({ family: 'capsule', shape: 1, color: 0, eyes: 0, mouth: 0, top: 0, cheeks: 0, gear: 0 });
  expect(withPart(dressed, 'mouth', 3)).toEqual({ ...dressed, mouth: 3 });
});
