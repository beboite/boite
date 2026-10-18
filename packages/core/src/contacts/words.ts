/**
 * The four words two owners compare after linking. They come from both
 * signing keys, so both cores read the same four, and a machine sitting
 * between them, holding keys of its own, would show different ones.
 */
import { createHash } from 'node:crypto';

/** 256 short, distinct words: one byte of the hash picks one. */
export const WORDS: readonly string[] = [
  'acorn', 'amber', 'anchor', 'apple', 'arrow', 'aspen', 'atlas', 'autumn', 'badge', 'bamboo', 'banjo', 'barley', 'basil', 'beacon', 'berry', 'birch',
  'bison', 'blossom', 'bonfire', 'breeze', 'brook', 'bubble', 'cabin', 'cactus', 'camel', 'candle', 'canyon', 'canvas', 'carbon', 'cargo', 'castle', 'cedar',
  'cherry', 'chess', 'cider', 'cinder', 'citrus', 'clover', 'cobalt', 'comet', 'compass', 'copper', 'coral', 'cotton', 'cougar', 'crane', 'crater', 'cricket',
  'crystal', 'cypress', 'daisy', 'dawn', 'delta', 'desert', 'diamond', 'dolphin', 'domino', 'dragon', 'drum', 'dune', 'eagle', 'echo', 'ember', 'emerald',
  'falcon', 'feather', 'fern', 'fiddle', 'fig', 'firefly', 'fjord', 'flame', 'flint', 'forest', 'fossil', 'fox', 'galaxy', 'garden', 'garnet', 'geyser',
  'ginger', 'glacier', 'globe', 'granite', 'grape', 'gravel', 'harbor', 'harvest', 'hazel', 'heron', 'hickory', 'honey', 'horizon', 'hornet', 'iceberg', 'igloo',
  'indigo', 'iris', 'island', 'ivory', 'jade', 'jaguar', 'jasmine', 'jelly', 'jungle', 'juniper', 'kayak', 'kernel', 'kettle', 'kiwi', 'koala', 'lagoon',
  'lantern', 'lark', 'lava', 'lemon', 'lilac', 'lily', 'linen', 'lion', 'lizard', 'lotus', 'lunar', 'magnet', 'mango', 'maple', 'marble', 'meadow',
  'melon', 'meteor', 'mint', 'mirror', 'mist', 'monsoon', 'moose', 'mosaic', 'moss', 'mountain', 'mulberry', 'nectar', 'needle', 'nest', 'nickel', 'nutmeg',
  'oak', 'oasis', 'ocean', 'olive', 'onyx', 'opal', 'orbit', 'orchid', 'otter', 'owl', 'oyster', 'paddle', 'palm', 'panda', 'papaya', 'parrot',
  'pebble', 'pelican', 'pepper', 'pine', 'planet', 'plum', 'polar', 'pollen', 'pony', 'poppy', 'prairie', 'prism', 'pumpkin', 'quartz', 'quill', 'rabbit',
  'raven', 'reef', 'ribbon', 'river', 'robin', 'rocket', 'ruby', 'saddle', 'saffron', 'salmon', 'sandal', 'sapphire', 'satin', 'sequoia', 'shadow', 'shell',
  'silver', 'sparrow', 'spruce', 'squid', 'star', 'stone', 'storm', 'summit', 'sunset', 'swan', 'tango', 'thistle', 'thunder', 'tiger', 'timber', 'topaz',
  'tulip', 'tundra', 'turtle', 'valley', 'velvet', 'violet', 'volcano', 'walnut', 'walrus', 'willow', 'winter', 'wolf', 'yarrow', 'zebra', 'zephyr', 'zinc',
  'badger', 'beetle', 'bramble', 'buffalo', 'butter', 'cliff', 'cloud', 'coconut', 'cocoa', 'condor', 'dahlia', 'ferret', 'frost', 'gecko', 'gull', 'hawk',
  'hedge', 'jasper', 'lichen', 'llama', 'lynx', 'maize', 'marsh', 'nova', 'orca', 'peach', 'quail', 'sable', 'sage', 'tide', 'wren', 'yak',
];

/** Four words from SHA-256 of both public keys, sorted so the order of the two does not matter. */
export function fingerprintWords(publicKeyA: string, publicKeyB: string): string {
  const digest = createHash('sha256').update([publicKeyA, publicKeyB].sort().join('\n')).digest();
  return [...digest.subarray(0, 4)].map(byte => WORDS[byte]!).join(' ');
}
