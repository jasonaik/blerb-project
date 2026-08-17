import { describe, expect, it } from 'vitest';
import { bucketOf, normalizeApp } from './classify.js';

describe('normalizeApp', () => {
  it('lowercases and strips .exe', () => {
    expect(normalizeApp('Code.EXE')).toBe('code');
    expect(normalizeApp('chrome')).toBe('chrome');
  });

  it('strips paths — a full path must die at this boundary', () => {
    expect(normalizeApp('C:\\Program Files\\Slack\\slack.exe')).toBe('slack');
    expect(normalizeApp('/usr/bin/nvim')).toBe('nvim');
  });
});

describe('bucketOf', () => {
  const cls = { focus: ['Code.exe', 'NEOVIM'], elsewhere: ['slack'] };

  it('matches case-insensitively, .exe optional, on both sides', () => {
    expect(bucketOf('code', cls)).toBe('focus');
    expect(bucketOf('CODE.EXE', cls)).toBe('focus');
    expect(bucketOf('neovim.exe', cls)).toBe('focus');
    expect(bucketOf('Slack.exe', cls)).toBe('elsewhere');
  });

  it('unlisted apps are neutral — the app has no opinion', () => {
    expect(bucketOf('spotify', cls)).toBe('neutral');
  });

  it('elsewhere ships empty: nothing is pre-labelled as bad', () => {
    expect(bucketOf('anything', { focus: [], elsewhere: [] })).toBe('neutral');
  });
});
