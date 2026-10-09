import { afterEach, expect, test, vi } from 'vitest';
import { addReminder, clearMemory, FACT_LENGTH, forget, forgetFact, MEMORY_LIMIT, memoryBlock, readMemory, readReminders, readStatus, remember, subscribeCompanionData, takeDueReminders, writeStatus } from './memory';
import { parseDirectives, parseWhen, visibleReply } from './directives';
import { summaryLine } from './describe';
import { layoutOf } from './shell';
import { mentionsScreen } from './screen';
import { isNight } from './senses.svelte';

afterEach(() => window.localStorage.clear());

const MINUTE = 60_000;
// Friday 9 October 2026, 14:05, local time.
const now = new Date(2026, 9, 9, 14, 5);

test('a fact is kept once, the newest wording last, and the oldest go past the limit', () => {
  remember('Likes jazz.', 1);
  remember('Works on Boite', 2);
  remember('  likes   JAZZ ', 3);
  expect(readMemory().map((fact) => fact.text)).toEqual(['Works on Boite', 'likes JAZZ']);
  expect(remember('x'.repeat(FACT_LENGTH + 50)).at(-1)!.text).toHaveLength(FACT_LENGTH);
  expect(remember('   ')).toHaveLength(3);
  clearMemory();
  for (let index = 0; index < MEMORY_LIMIT + 5; index++) remember(`fact ${index}`, index);
  const kept = readMemory();
  expect(kept).toHaveLength(MEMORY_LIMIT);
  expect(kept[0]!.text).toBe('fact 5');
});

test('a fact is forgotten by its words, not only word for word', () => {
  remember('Plays Overwatch every weekend');
  remember('Works on Boite');
  remember('Likes jazz');
  expect(forget('jazz').map((fact) => fact.text)).toEqual(['Plays Overwatch every weekend', 'Works on Boite']);
  expect(forget('plays Overwatch at weekends').map((fact) => fact.text)).toEqual(['Works on Boite']);
  expect(forget('the user').map((fact) => fact.text)).toEqual(['Works on Boite']);
  expect(forgetFact(readMemory()[0]!.id)).toEqual([]);
});

test('the memory rides in front of a conversation as a list', () => {
  expect(memoryBlock([])).toBe('Your memory of the user is empty so far.');
  remember('Is called Chris');
  remember('Likes jazz');
  expect(memoryBlock(readMemory())).toBe('What you remember about the user:\n- Is called Chris\n- Likes jazz');
});

test('reminders come soonest first and ring once', () => {
  addReminder('later', 2000, 0);
  addReminder('sooner', 1000, 0);
  addReminder(' ', 500, 0);
  addReminder('never', Number.NaN, 0);
  expect(readReminders().map((reminder) => reminder.text)).toEqual(['sooner', 'later']);
  expect(takeDueReminders(1500).map((reminder) => reminder.text)).toEqual(['sooner']);
  expect(takeDueReminders(1500)).toEqual([]);
  expect(readReminders().map((reminder) => reminder.text)).toEqual(['later']);
});

test('the memory, the reminders and the status are heard on this page and from the other window', () => {
  const heard = vi.fn();
  const stop = subscribeCompanionData(heard);
  writeStatus({ hotkeyError: 'Ctrl+Alt+B' });
  writeStatus({ hotkeyError: 'Ctrl+Alt+B' });
  expect(readStatus()).toEqual({ hotkeyError: 'Ctrl+Alt+B' });
  remember('Likes jazz');
  window.dispatchEvent(new StorageEvent('storage', { key: 'boite.companion.reminders' }));
  window.dispatchEvent(new StorageEvent('storage', { key: 'boite.companion' }));
  stop();
  remember('Works on Boite');
  expect(heard).toHaveBeenCalledTimes(3);
});

test('a reminder rings after a delay, at a time of the day or at a date', () => {
  expect(parseWhen('+20m', now)).toBe(now.getTime() + 20 * MINUTE);
  expect(parseWhen('+20 min', now)).toBe(now.getTime() + 20 * MINUTE);
  expect(parseWhen('+1h30m', now)).toBe(now.getTime() + 90 * MINUTE);
  expect(parseWhen('+45s', now)).toBe(now.getTime() + 45_000);
  expect(parseWhen('+0m', now)).toBeNull();
  expect(parseWhen('18:30', now)).toBe(new Date(2026, 9, 9, 18, 30).getTime());
  // A time already past today is tomorrow's.
  expect(parseWhen('9h05', now)).toBe(new Date(2026, 9, 10, 9, 5).getTime());
  expect(parseWhen('24:00', now)).toBeNull();
  expect(parseWhen('2026-10-12 09:00', now)).toBe(new Date(2026, 9, 12, 9, 0).getTime());
  expect(parseWhen('2026-02-31 09:00', now)).toBeNull();
  expect(parseWhen('2026-10-01 09:00', now)).toBeNull();
  expect(parseWhen('tomorrow', now)).toBeNull();
});

test('the directives of a reply are read, and the bubble never shows them', () => {
  const reply = 'Noted, Chris.\n[[remember: Is called Chris]]\n[[forget: likes jazz]]\n[[remind: +20m | Take the pizza out]]\n[[remind: soon | nothing]]\n[[remind: 18:30]]\n[[remember:   ]]';
  expect(parseDirectives(reply, now)).toEqual({
    remember: ['Is called Chris'],
    forget: ['likes jazz'],
    remind: [{ text: 'Take the pizza out', at: now.getTime() + 20 * MINUTE }],
    timer: null,
    focus: null
  });
  expect(visibleReply(reply)).toBe('Noted, Chris.');
  expect(visibleReply('Sure.\n[[REMIND: +5m | tea]]\nIt rings at 14:10.')).toBe('Sure.\n\nIt rings at 14:10.');
  // While it streams, a directive half written, or its first bracket, stays out too.
  expect(visibleReply('Noted. [[remem')).toBe('Noted.');
  expect(visibleReply('Noted. [')).toBe('Noted.');
});

test('a finished thread is told in its first sentence, without Markdown', () => {
  expect(summaryLine('I fixed the `login` bug in [auth.ts](src/auth.ts). Then I ran the tests.')).toBe('I fixed the login bug in auth.ts.');
  expect(summaryLine('**Done!** Everything passes.')).toBe('Done!');
  expect(summaryLine('- first item\n- second item')).toBe('first item second item');
  const long = summaryLine(`The ${'very '.repeat(60)}long answer`);
  expect(long.length).toBeLessThanOrEqual(140);
  expect(long).toMatch(/very…$/);
});

test('a dropped character keeps to the side and the edge it is nearest to', () => {
  expect(layoutOf('left', null)).toEqual({ align: 'left', edge: 'top' });
  expect(layoutOf('free', null)).toEqual({ align: 'center', edge: 'top' });
  expect(layoutOf('free', { x: 0.1, y: 0.9 })).toEqual({ align: 'left', edge: 'bottom' });
  expect(layoutOf('free', { x: 0.5, y: 0.2 })).toEqual({ align: 'center', edge: 'top' });
  expect(layoutOf('free', { x: 0.8, y: 0.6 })).toEqual({ align: 'right', edge: 'bottom' });
});

test('a request that speaks of the screen offers to show it', () => {
  for (const text of ['What is on my screen?', 'Take a screenshot', 'Explain this window', 'Tu vois mon écran ?', 'regarde mes ecrans', 'Dis-moi ce que je vois']) expect(mentionsScreen(text), text).toBe(true);
  for (const text of ['Play some music', 'Open the screensaver settings', 'Mets un écrantage']) expect(mentionsScreen(text), text).toBe(false);
});

test('the night runs from eleven to seven', () => {
  expect([22, 23, 0, 6, 7].map(isNight)).toEqual([false, true, true, true, false]);
});
