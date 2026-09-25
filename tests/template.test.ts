import { describe, expect, it } from 'vitest';
import { toCsv } from '../src/core/csv';
import { renderTemplate, templateVariables } from '../src/core/template';

describe('renderTemplate', () => {
  it('変数を置換し、未定義の変数は残す', () => {
    expect(renderTemplate('第{match_number}試合 {start_time} 開始 {unknown}', { match_number: 3, start_time: '20:00' })).toBe(
      '第3試合 20:00 開始 {unknown}',
    );
  });

  it('使われている変数を列挙する', () => {
    expect(templateVariables('{a} {b} {a}')).toEqual(['a', 'b']);
  });
});

describe('toCsv', () => {
  it('カンマや改行を含む値をエスケープする', () => {
    expect(toCsv(['a', 'b'], [['x,y', 'he said "hi"']])).toBe('﻿a,b\r\n"x,y","he said ""hi"""\r\n');
  });
});
