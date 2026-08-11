import { describe, expect, it } from 'vitest';
import { byIndex, makeNameParser, parseAnimSpec, parseFpsFlags, slugFromFilename } from './spec.js';

describe('parseAnimSpec', () => {
  it('parses a range with fps', () => {
    expect(parseAnimSpec('walk=0-3@8')).toEqual({ name: 'walk', indices: [0, 1, 2, 3], fps: 8 });
  });

  it('parses a comma list, defaults fps', () => {
    expect(parseAnimSpec('idle=0,1')).toEqual({ name: 'idle', indices: [0, 1], fps: 8 });
  });

  it('mixes ranges and singles, descending ranges walk backwards', () => {
    expect(parseAnimSpec('walk=2,4-6,3-1@10').indices).toEqual([2, 4, 5, 6, 3, 2, 1]);
  });

  it('accepts fractional fps', () => {
    expect(parseAnimSpec('sleep=7@1.5').fps).toBe(1.5);
  });

  it('rejects garbage with a useful message', () => {
    expect(() => parseAnimSpec('walk')).toThrow(/name=frames/);
    expect(() => parseAnimSpec('walk=a-b')).toThrow(/name=frames/); // fails the outer shape
    expect(() => parseAnimSpec('walk=1--2')).toThrow(/frame index/); // fails per-entry
    expect(() => parseAnimSpec('walk=1@0')).toThrow(/positive/);
    expect(() => parseAnimSpec('walk=1,,2')).toThrow(/empty/);
  });

  it('rejects absurd ranges before allocating them', () => {
    expect(() => parseAnimSpec('walk=0-999999999')).toThrow(/4096/);
  });
});

describe('parseFpsFlags', () => {
  it('separates the global default from per-animation overrides', () => {
    const { byAnim, fallback } = parseFpsFlags(['6', 'walk=12']);
    expect(fallback).toBe(6);
    expect(byAnim.get('walk')).toBe(12);
  });

  it('matches case-insensitively, because parsed animation names are lowercased', () => {
    // `--fps Walk=10` next to files named Walk_0.png — the parser lowercases
    // the animation to "walk", so the override must land there too.
    expect(parseFpsFlags(['Walk=10']).byAnim.get('walk')).toBe(10);
  });

  it('defaults to 8', () => {
    expect(parseFpsFlags([]).fallback).toBe(8);
  });

  it('rejects nonsense', () => {
    expect(() => parseFpsFlags(['walk='])).toThrow();
    expect(() => parseFpsFlags(['fast'])).toThrow();
  });
});

describe('makeNameParser', () => {
  it('default pattern handles the common separators', () => {
    const p = makeNameParser();
    expect(p('walk_3.png')).toEqual({ anim: 'walk', index: 3 });
    expect(p('walk-10.PNG')).toEqual({ anim: 'walk', index: 10 });
    expect(p('Walk 2.webp')).toEqual({ anim: 'walk', index: 2 });
    expect(p('walk3.png')).toEqual({ anim: 'walk', index: 3 });
    expect(p('notes.txt')).toBeNull();
  });

  it('explicit pattern is anchored and literal', () => {
    const p = makeNameParser('{anim}.{i}.png');
    expect(p('idle.0.png')).toEqual({ anim: 'idle', index: 0 });
    expect(p('idlex0.png')).toBeNull(); // the dot is a literal dot
  });

  it('supports index-first patterns', () => {
    const p = makeNameParser('{i}_{anim}.png');
    expect(p('07_walk.png')).toEqual({ anim: 'walk', index: 7 });
  });

  it('rejects a pattern missing a placeholder', () => {
    expect(() => makeNameParser('{anim}.png')).toThrow(/\{i\}/);
  });
});

describe('numeric ordering', () => {
  it('walk_10 sorts after walk_9', () => {
    const names = [
      { anim: 'walk', index: 10 },
      { anim: 'walk', index: 9 },
      { anim: 'walk', index: 1 },
    ].sort(byIndex);
    expect(names.map((n) => n.index)).toEqual([1, 9, 10]);
  });
});

describe('slugFromFilename', () => {
  it('slugs a path down to an animation name', () => {
    expect(slugFromFilename('C:\\art\\Walk Cycle.gif')).toBe('walk-cycle');
    expect(slugFromFilename('./frames/idle.webp')).toBe('idle');
    expect(slugFromFilename('123.gif')).toBe('anim-123');
  });
});
