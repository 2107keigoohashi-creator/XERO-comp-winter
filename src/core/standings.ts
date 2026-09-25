import type { TiebreakerKey } from '../config';

export interface ResultRow {
  teamId: number;
  matchNumber: number;
  placement: number | null;
  kills: number | null;
  totalPoints: number;
}

export interface PenaltyRow {
  teamId: number;
  points: number;
}

export interface StandingRow {
  rank: number;
  teamId: number;
  teamName: string;
  totalPoints: number;
  matchPoints: number;
  penaltyPoints: number;
  matches: number;
  victoryRoyales: number;
  totalKills: number;
  avgKills: number;
  avgPlacement: number;
  lastMatchPlacement: number | null;
}

type Comparator = (a: StandingRow, b: StandingRow) => number;

/** 各タイブレーク指標の比較（負なら a が上位） */
const TIEBREAKERS: Record<TiebreakerKey, Comparator> = {
  victory_royales: (a, b) => b.victoryRoyales - a.victoryRoyales,
  avg_kills: (a, b) => b.avgKills - a.avgKills,
  avg_placement: (a, b) => a.avgPlacement - b.avgPlacement,
  total_kills: (a, b) => b.totalKills - a.totalKills,
  last_match_placement: (a, b) => (a.lastMatchPlacement ?? Infinity) - (b.lastMatchPlacement ?? Infinity),
};

const EPSILON = 1e-9;
function sign(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.abs(n) < EPSILON ? 0 : n;
}

/**
 * 順位表を計算する。
 * - 合計ポイント = 試合ポイント合計 - ペナルティ
 * - 同点時は tiebreakers の順に比較。全て同じなら同順位。
 * - last_match_placement は「全体で最後に行われた試合（最大の試合番号）」での順位を比較する。
 */
export function computeStandings(
  teams: { id: number; name: string }[],
  results: ResultRow[],
  penalties: PenaltyRow[],
  tiebreakers: TiebreakerKey[],
): StandingRow[] {
  const lastMatch = results.reduce((m, r) => Math.max(m, r.matchNumber), 0);

  const rows: StandingRow[] = teams.map((team) => {
    const own = results.filter((r) => r.teamId === team.id);
    const placements = own.map((r) => r.placement).filter((p): p is number => p != null);
    const matchPoints = own.reduce((s, r) => s + r.totalPoints, 0);
    const penaltyPoints = penalties.filter((p) => p.teamId === team.id).reduce((s, p) => s + p.points, 0);
    const totalKills = own.reduce((s, r) => s + (r.kills ?? 0), 0);
    return {
      rank: 0,
      teamId: team.id,
      teamName: team.name,
      matchPoints,
      penaltyPoints,
      totalPoints: matchPoints - penaltyPoints,
      matches: own.length,
      victoryRoyales: own.filter((r) => r.placement === 1).length,
      totalKills,
      avgKills: own.length ? totalKills / own.length : 0,
      avgPlacement: placements.length ? placements.reduce((s, p) => s + p, 0) / placements.length : Infinity,
      lastMatchPlacement: own.find((r) => r.matchNumber === lastMatch)?.placement ?? null,
    };
  });

  const comparators: Comparator[] = [(a, b) => b.totalPoints - a.totalPoints, ...tiebreakers.map((k) => TIEBREAKERS[k])];
  const compare = (a: StandingRow, b: StandingRow): number => {
    for (const c of comparators) {
      const d = sign(c(a, b));
      if (d !== 0) return d;
    }
    return 0;
  };

  rows.sort((a, b) => compare(a, b) || a.teamName.localeCompare(b.teamName));
  rows.forEach((row, i) => {
    row.rank = i > 0 && compare(rows[i - 1], row) === 0 ? rows[i - 1].rank : i + 1;
  });
  return rows;
}
