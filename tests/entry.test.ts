import { describe, expect, it } from 'vitest';
import { parseEpicInput } from '../src/services/entryService';
import { toDirectUrl } from '../src/replay/download';

describe('parseEpicInput', () => {
  it('表示名のみ', () => {
    expect(parseEpicInput('  Player One ')).toEqual({ epicName: 'Player One', epicId: null });
  });
  it('表示名, Epic ID', () => {
    const id = '0123456789ABCDEF0123456789abcdef';
    expect(parseEpicInput(`Player, One , ${id}`)).toEqual({ epicName: 'Player, One', epicId: id.toLowerCase() });
  });
  it('ID 形式でなければ表示名として扱う', () => {
    expect(parseEpicInput('Name, notanid')).toEqual({ epicName: 'Name, notanid', epicId: null });
  });
});

describe('toDirectUrl', () => {
  it('Google Drive の共有リンクを直リンクに変換する', () => {
    expect(toDirectUrl('https://drive.google.com/file/d/AbC-123_x/view?usp=sharing')).toBe(
      'https://drive.usercontent.google.com/download?id=AbC-123_x&export=download&confirm=t',
    );
  });
  it('Dropbox は dl=1 にする', () => {
    expect(toDirectUrl('https://www.dropbox.com/s/abc/file.replay?dl=0')).toBe('https://www.dropbox.com/s/abc/file.replay?dl=1');
  });
});
