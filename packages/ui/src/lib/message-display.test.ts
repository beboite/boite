import { expect, test } from 'vitest';
import { paragraphBlocks, answerText, promptText, currentThought } from './message-display';

test('paragraphs wait for a boundary, and completion or cancellation flushes the tail', () => {
  expect(paragraphBlocks('First sentence', true)).toEqual([]);
  expect(paragraphBlocks('First sentence\n\nSecond par', true)).toEqual(['First sentence']);
  expect(paragraphBlocks('First sentence\n\nSecond par', false)).toEqual(['First sentence', 'Second par']);
  expect(paragraphBlocks('One\r\n\r\nTwo', true)).toEqual(['One']);
});
test('blank lines inside fenced code do not expose an incomplete block', () => {
  expect(paragraphBlocks('Intro\n\n```ts\nconst a = 1;\n\npartial', true)).toEqual(['Intro']);
  expect(paragraphBlocks('```ts\nconst a = 1;\n\n```\n\nTail', true)).toEqual(['```ts\nconst a = 1;\n\n```']);
});
test('internal goal markers stay out of prose, even during partial arrival', () => {
  expect(answerText('Done\n\n[BOITE_GOAL_COMPLETE]', false)).toBe('Done\n\n');
  expect(answerText('Done\n\n[BOITE_GOAL_COM', true)).not.toContain('[BOITE_');
  expect(answerText('A literal [BOITE_GOAL_COMPLETE] in a sentence.', false)).toContain('[BOITE_GOAL_COMPLETE]');
});
test('display commands leave the execution prompt intact', () => {
  const part = {type: 'text' as const, text: 'private instructions', displayText: '/goal Check it'};
  expect(promptText(part)).toBe('/goal Check it');
  expect(part.text).toBe('private instructions');
  expect(promptText({type:'text',text:'Ordinary prompt'})).toBe('Ordinary prompt');
});

test('a new thought replaces previous bold headings even within one protocol part', () => {
  expect(currentThought('**First thought**old**Next thought**new')).toEqual({title:'Next thought',text:'**Next thought**new'});
  expect(currentThought('plain reasoning')).toEqual({title:null,text:'plain reasoning'});
});
