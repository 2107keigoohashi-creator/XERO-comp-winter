import { normalizeEpicId, normalizeName } from './normalize';
import type { Issue, ParsedPlayer, RegisteredTeam, TeamMatchResult } from './types';

export interface MatchedPlayer {
  parsed: ParsedPlayer;
  teamId: number;
  playerId: number;
  matchedBy: 'epicId' | 'name';
}

export interface MatchOutcome {
  matched: MatchedPlayer[];
  unknown: ParsedPlayer[];
  /** 登録済みだがリプレイ上に見つからなかったプレイヤー */
  missing: { teamId: number; teamName: string; epicName: string }[];
  results: TeamMatchResult[];
  issues: Issue[];
}

/**
 * リプレイ上のプレイヤーを登録チームに紐付け、チーム単位の順位・キル数を算出する。
 * 照合は Epic Account ID を優先し、ID が無い/一致しない場合は表示名（正規化後）で照合する。
 */
export function matchPlayersToTeams(players: ParsedPlayer[], teams: RegisteredTeam[]): MatchOutcome {
  const byEpicId = new Map<string, { teamId: number; playerId: number }>();
  const byName = new Map<string, { teamId: number; playerId: number }>();
  for (const team of teams) {
    for (const p of team.players) {
      const id = normalizeEpicId(p.epicId);
      if (id) byEpicId.set(id, { teamId: team.id, playerId: p.id });
      byName.set(normalizeName(p.epicName), { teamId: team.id, playerId: p.id });
    }
  }

  const matched: MatchedPlayer[] = [];
  const unknown: ParsedPlayer[] = [];
  const usedPlayerIds = new Set<number>();

  for (const parsed of players.filter((p) => !p.isBot)) {
    const id = normalizeEpicId(parsed.epicId);
    let hit = id ? byEpicId.get(id) : undefined;
    let matchedBy: MatchedPlayer['matchedBy'] = 'epicId';
    if (!hit) {
      hit = byName.get(normalizeName(parsed.name));
      matchedBy = 'name';
    }
    if (!hit || usedPlayerIds.has(hit.playerId)) {
      unknown.push(parsed);
      continue;
    }
    usedPlayerIds.add(hit.playerId);
    matched.push({ parsed, teamId: hit.teamId, playerId: hit.playerId, matchedBy });
  }

  const issues: Issue[] = [];
  for (const u of unknown) {
    issues.push({ level: 'warning', code: 'UNKNOWN_PLAYER', params: { player: u.name || '(unknown)', epicId: u.epicId ?? '-' } });
  }

  const missing: MatchOutcome['missing'] = [];
  const results: TeamMatchResult[] = [];

  for (const team of teams) {
    const members = matched.filter((m) => m.teamId === team.id);
    for (const p of team.players) {
      if (!usedPlayerIds.has(p.id)) missing.push({ teamId: team.id, teamName: team.name, epicName: p.epicName });
    }
    if (members.length === 0) {
      issues.push({ level: 'warning', code: 'TEAM_NOT_FOUND', params: { team: team.name } });
      continue;
    }

    const parties = new Set(members.map((m) => m.parsed.partyNumber).filter((n) => n != null));
    if (parties.size > 1) {
      issues.push({ level: 'error', code: 'TEAM_SPLIT', params: { team: team.name, parties: [...parties].join(',') } });
    }

    const placements = members.map((m) => m.parsed.placement).filter((p): p is number => p != null);
    const distinct = new Set(placements);
    if (distinct.size > 1) {
      issues.push({ level: 'warning', code: 'PLACEMENT_MISMATCH_IN_TEAM', params: { team: team.name, values: [...distinct].join('/') } });
    }
    // 個人キルの合計と、リプレイ上のチームキルの大きい方を採用（遠くのメンバーの個人キルが欠ける場合の補完）
    const kills = members.map((m) => m.parsed.kills);
    const teamKills = members.map((m) => m.parsed.teamKills).filter((k): k is number => k != null);
    const killSum = kills.reduce<number>((s, k) => s + (k ?? 0), 0);
    if (kills.every((k) => k == null) && teamKills.length === 0) {
      issues.push({ level: 'info', code: 'MISSING_KILLS', params: { team: team.name } });
    }
    results.push({
      teamId: team.id,
      placement: placements.length ? Math.min(...placements) : null,
      kills: Math.max(killSum, ...teamKills),
    });
  }

  for (const m of missing) {
    issues.push({ level: 'warning', code: 'MISSING_PLAYER', params: { team: m.teamName, player: m.epicName } });
  }

  return { matched, unknown, missing, results, issues };
}
