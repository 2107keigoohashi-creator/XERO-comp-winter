import { describe, expect, it } from 'vitest';
import { computeStandings, type ResultRow } from '../src/core/standings';

const teams = [
  { id: 1, name: 'Alpha' },
  { id: 2, name: 'Bravo' },
  { id: 3, name: 'Charlie' },
];

const r = (teamId: number, matchNumber: number, placement: number, kills: number, totalPoints: number): ResultRow => ({
  teamId,
  matchNumber,
  placement,
  kills,
  totalPoints,
});

describe('computeStandings', () => {
  it('合計ポイント順に並べる', () => {
    const rows = computeStandings(teams, [r(1, 1, 3, 1, 6), r(2, 1, 1, 4, 15), r(3, 1, 2, 0, 6)], [], ['victory_royales']);
    expect(rows.map((x) => x.teamName)).toEqual(['Bravo', 'Alpha', 'Charlie']);
    expect(rows[0]).toMatchObject({ rank: 1, totalPoints: 15, victoryRoyales: 1, totalKills: 4, matches: 1 });
  });

  it('同点時はビクロイ数 → 平均キル → 平均順位 → 最終試合順位の順で比較する', () => {
    // 全員 20pt
    const results = [
      r(1, 1, 1, 0, 11), r(1, 2, 9, 7, 9), // Alpha: ビクロイ1
      r(2, 1, 2, 10, 16), r(2, 2, 5, 0, 4), // Bravo: ビクロイ0, 平均キル5
      r(3, 1, 3, 10, 15), r(3, 2, 10, 4, 5), // Charlie: ビクロイ0, 平均キル7
    ];
    const rows = computeStandings(teams, results, [], ['victory_royales', 'avg_kills', 'avg_placement', 'last_match_placement']);
    expect(rows.map((x) => x.teamName)).toEqual(['Alpha', 'Charlie', 'Bravo']);
    expect(rows.map((x) => x.rank)).toEqual([1, 2, 3]);
  });

  it('タイブレークの順番を設定で変更できる', () => {
    const results = [r(1, 1, 1, 0, 11), r(2, 1, 5, 7, 11)];
    const byWins = computeStandings(teams.slice(0, 2), results, [], ['victory_royales']);
    const byKills = computeStandings(teams.slice(0, 2), results, [], ['total_kills']);
    expect(byWins[0].teamName).toBe('Alpha');
    expect(byKills[0].teamName).toBe('Bravo');
  });

  it('最終試合の順位で比較する', () => {
    const results = [r(1, 1, 2, 0, 6), r(1, 2, 8, 0, 2), r(2, 1, 8, 0, 2), r(2, 2, 2, 0, 6)];
    const rows = computeStandings(teams.slice(0, 2), results, [], ['last_match_placement']);
    expect(rows[0].teamName).toBe('Bravo');
  });

  it('全指標が同じなら同順位', () => {
    const rows = computeStandings(teams.slice(0, 2), [r(1, 1, 4, 2, 6), r(2, 1, 4, 2, 6)], [], ['victory_royales', 'avg_kills']);
    expect(rows.map((x) => x.rank)).toEqual([1, 1]);
  });

  it('ペナルティを減点する', () => {
    const rows = computeStandings(teams.slice(0, 2), [r(1, 1, 1, 0, 11), r(2, 1, 2, 0, 6)], [{ teamId: 1, points: 10 }], []);
    expect(rows[0]).toMatchObject({ teamName: 'Bravo', totalPoints: 6 });
    expect(rows[1]).toMatchObject({ teamName: 'Alpha', totalPoints: 1, penaltyPoints: 10, matchPoints: 11 });
  });

  it('試合に出ていないチームも 0pt で並ぶ', () => {
    const rows = computeStandings(teams, [r(1, 1, 1, 0, 11)], [], ['victory_royales']);
    expect(rows).toHaveLength(3);
    expect(rows[2].matches).toBe(0);
  });
});
