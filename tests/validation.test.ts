import { describe, expect, it } from 'vitest';
import { validateMatch } from '../src/core/validation';
import { player } from './helpers';

const names = new Map([
  [1, 'Alpha'],
  [2, 'Bravo'],
]);
const opts = { maxKillsPerPlayer: 40, minLobbyPlayers: 2 };

describe('validateMatch', () => {
  const lobby = [player({ name: 'a', partyNumber: 1 }), player({ name: 'b', partyNumber: 2 })];

  it('正常な結果では問題なし', () => {
    expect(validateMatch(lobby, [{ teamId: 1, placement: 1, kills: 3 }, { teamId: 2, placement: 2, kills: 0 }], names, opts)).toEqual([]);
  });

  it('欠損値・重複順位・不自然な値を検出する', () => {
    const issues = validateMatch(
      [...lobby, player({ name: 'cheater', kills: 99 })],
      [
        { teamId: 1, placement: null, kills: null },
        { teamId: 2, placement: 3, kills: 500 },
        { teamId: 3, placement: 3, kills: 1 },
      ],
      names,
      opts,
    ).map((i) => i.code);
    expect(issues).toEqual(expect.arrayContaining(['MISSING_PLACEMENT', 'MISSING_KILLS', 'KILLS_TOO_HIGH', 'DUPLICATE_PLACEMENT']));
  });

  it('ロビー人数が少なすぎると警告', () => {
    expect(validateMatch([lobby[0]], [], names, opts).map((i) => i.code)).toEqual(['LOBBY_TOO_SMALL']);
  });
});
