import { describe, expect, it } from 'vitest';
import { matchPlayersToTeams } from '../src/core/matcher';
import type { RegisteredTeam } from '../src/core/types';
import { player } from './helpers';

const ID_A1 = 'a'.repeat(32);
const teams: RegisteredTeam[] = [
  {
    id: 1,
    name: 'Alpha',
    players: [
      { id: 11, discordId: 'd11', epicName: 'AlphaOne', epicId: ID_A1 },
      { id: 12, discordId: 'd12', epicName: 'Ａｌｐｈａ Two', epicId: null },
    ],
  },
  {
    id: 2,
    name: 'Bravo',
    players: [
      { id: 21, discordId: 'd21', epicName: 'BravoOne', epicId: null },
      { id: 22, discordId: 'd22', epicName: 'BravoTwo', epicId: null },
    ],
  },
];

describe('matchPlayersToTeams', () => {
  it('Epic ID を優先し、なければ表示名（全角/大文字小文字を無視）で照合する', () => {
    const outcome = matchPlayersToTeams(
      [
        player({ name: 'RenamedAlpha', epicId: ID_A1.toUpperCase(), partyNumber: 3, placement: 2, kills: 3 }),
        player({ name: 'alpha two', partyNumber: 3, placement: 2, kills: 1 }),
        player({ name: 'BravoOne', partyNumber: 5, placement: 1, kills: 4 }),
        player({ name: 'BravoTwo', partyNumber: 5, placement: 1, kills: 0 }),
      ],
      teams,
    );
    expect(outcome.matched.map((m) => [m.playerId, m.matchedBy])).toEqual([
      [11, 'epicId'],
      [12, 'name'],
      [21, 'name'],
      [22, 'name'],
    ]);
    expect(outcome.results).toEqual([
      { teamId: 1, placement: 2, kills: 4 },
      { teamId: 2, placement: 1, kills: 4 },
    ]);
    expect(outcome.issues).toEqual([]);
  });

  it('未登録プレイヤーと、見つからない登録プレイヤーを警告する', () => {
    const outcome = matchPlayersToTeams(
      [
        player({ name: 'AlphaOne', partyNumber: 1, placement: 3, kills: 0 }),
        player({ name: 'Stranger', partyNumber: 9, placement: 4, kills: 2 }),
        player({ name: 'SomeBot', isBot: true }),
      ],
      teams,
    );
    expect(outcome.unknown.map((u) => u.name)).toEqual(['Stranger']);
    const codes = outcome.issues.map((i) => `${i.code}:${i.params.player ?? i.params.team}`);
    expect(codes).toContain('UNKNOWN_PLAYER:Stranger');
    expect(codes).toContain('MISSING_PLAYER:Ａｌｐｈａ Two');
    expect(codes).toContain('TEAM_NOT_FOUND:Bravo');
    expect(codes.some((c) => c.includes('SomeBot'))).toBe(false);
  });

  it('同じチームのメンバーが別パーティにいたらエラー', () => {
    const outcome = matchPlayersToTeams(
      [player({ name: 'BravoOne', partyNumber: 1, placement: 1, kills: 0 }), player({ name: 'BravoTwo', partyNumber: 2, placement: 7, kills: 0 })],
      teams,
    );
    expect(outcome.issues.find((i) => i.code === 'TEAM_SPLIT')?.level).toBe('error');
    expect(outcome.issues.some((i) => i.code === 'PLACEMENT_MISMATCH_IN_TEAM')).toBe(true);
    expect(outcome.results.find((r) => r.teamId === 2)?.placement).toBe(1);
  });

  it('キルの記録が無ければ 0 キルとして扱い、情報として通知する', () => {
    const outcome = matchPlayersToTeams([player({ name: 'BravoOne', partyNumber: 1, placement: 4 })], teams);
    expect(outcome.results.find((r) => r.teamId === 2)).toEqual({ teamId: 2, placement: 4, kills: 0 });
    expect(outcome.issues.find((i) => i.code === 'MISSING_KILLS')?.level).toBe('info');
  });

  it('チームキルが個人キル合計より多ければチームキルを採用する', () => {
    const outcome = matchPlayersToTeams(
      [
        player({ name: 'BravoOne', partyNumber: 1, placement: 2, kills: 3, teamKills: 7 }),
        player({ name: 'BravoTwo', partyNumber: 1, placement: 2, kills: null, teamKills: 7 }),
      ],
      teams,
    );
    expect(outcome.results.find((r) => r.teamId === 2)?.kills).toBe(7);
  });
});
