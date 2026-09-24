import { expect, test } from 'vitest';
import { claudeKeywords, promptSegments, visibleAnswer, visibleUserText } from './message-display';

test('the keywords count only for a Claude model run by Claude Code', () => {
  expect(claudeKeywords('claude-sdk', 'claude-opus-5-5')).toBe(true);
  expect(claudeKeywords('claude-sdk', 'opus[1m]')).toBe(true);
  expect(claudeKeywords('claude-sdk', 'sonnet')).toBe(true);
  expect(claudeKeywords('claude-sdk', null)).toBe(true);
  // Claude Code routed to another model, or a Claude model behind another harness.
  expect(claudeKeywords('claude-sdk', 'glm-5')).toBe(false);
  expect(claudeKeywords('claude-sdk', 'deepseek-v4')).toBe(false);
  expect(claudeKeywords('claude-sdk', 'opusx-1')).toBe(false);
  expect(claudeKeywords('acp', 'claude-sonnet-5')).toBe(false);
  expect(claudeKeywords(undefined, 'claude-sonnet-5')).toBe(false);
});

test('old goal instructions display only the colored-command input, ordinary text stays intact', () => {
  expect(visibleUserText('Work toward this goal: Ship it\nContinue until the objective is achieved. private instructions')).toBe('/goal Ship it');
  expect(visibleUserText('/goal Ship it')).toBe('/goal Ship it');
  expect(visibleUserText('Discuss Work toward this goal: examples')).toBe('Discuss Work toward this goal: examples');
});
test('protocol markers are invisible while streaming and when complete', () => {
  expect(visibleAnswer('Verified.\n[BOITE_GOAL_COMPLETE]\n')).toBe('Verified.\n');
  expect(visibleAnswer('[BOITE_GOAL_BLOCKED]')).toBe('');
  expect(visibleAnswer('Verified.\n[BOITE_GOAL_COMP')).toBe('Verified.\n');
  expect(visibleAnswer('An inline [BOITE_GOAL_COMPLETE] example')).toBe('An inline [BOITE_GOAL_COMPLETE] example');
});

test('marker examples remain visible before more text and inside code fences', () => {
  for (const text of [
    '[BOITE_GOAL_COMPLETE]\nThis is an example.',
    '```text\n[BOITE_GOAL_COMPLETE]\n```',
    '```text\n[BOITE_GOAL_COMP',
    '~~~\n[BOITE_GOAL_BLOCKED]\n',
  ]) expect(visibleAnswer(text)).toBe(text);
});
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
  for (const live of [false, true]) {
    for (const example of ['[BOITE_GOAL_COMPLETE]\nAn example.', '```text\n[BOITE_GOAL_COMPLETE]\n```', '~~~\n[BOITE_GOAL_COMP']) {
      expect(answerText(example, live)).toBe(example);
    }
  }
});
test('display commands leave the execution prompt intact', () => {
  const part = {type: 'text' as const, text: 'private instructions', displayText: '/goal Check it'};
  expect(promptText(part)).toBe('/goal Check it');
  expect(part.text).toBe('private instructions');
  expect(promptText({type:'text',text:'Ordinary prompt'})).toBe('Ordinary prompt');
  expect(promptText({type:'text',text:'Work toward this goal: Check it\nContinue until the objective is achieved. Extra task guidance.'})).toBe('/goal Check it');
});

test('a new thought replaces previous bold headings even within one protocol part', () => {
  expect(currentThought('**First thought**\nold\n**Next thought**\nnew')).toEqual({title:'Next thought',text:'**Next thought**\nnew'});
  expect(currentThought('plain reasoning')).toEqual({title:null,text:'plain reasoning'});
  expect(currentThought('Check **all files** first')).toEqual({title:null,text:'Check **all files** first'});
  expect(currentThought('**Heading**\nCheck **all files** first')).toEqual({title:'Heading',text:'**Heading**\nCheck **all files** first'});
});

test('a prompt is cut at its command and at the words Claude Code acts on', () => {
  expect(promptSegments('/goal ultrathink it', '/goal', true)).toEqual([
    { text: '/goal', kind: 'command' },
    { text: ' ', kind: 'plain' },
    { text: 'ultrathink', kind: 'ultrathink' },
    { text: ' it', kind: 'plain' }
  ]);
  expect(promptSegments('Refactor it, UltraCode.', undefined, true)).toEqual([
    { text: 'Refactor it, ', kind: 'plain' },
    { text: 'UltraCode', kind: 'ultracode' },
    { text: '.', kind: 'plain' }
  ]);
  // Inside a longer word, or on another harness, the word is plain text.
  expect(promptSegments('ultrathinking', undefined, true)).toEqual([{ text: 'ultrathinking', kind: 'plain' }]);
  expect(promptSegments('ultrathink', undefined, false)).toEqual([{ text: 'ultrathink', kind: 'plain' }]);
  expect(promptSegments('', undefined, true)).toEqual([]);
});
