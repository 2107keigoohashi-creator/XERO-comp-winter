import type { Issue, ParsedPlayer, TeamMatchResult } from './types';

export interface ValidationOptions {
  maxKillsPerPlayer: number;
  minLobbyPlayers: number;
}

/** 欠損値・不自然な値を検出する */
export function validateMatch(
  players: ParsedPlayer[],
  results: TeamMatchResult[],
  teamNames: Map<number, string>,
  opts: ValidationOptions,
): Issue[] {
  const issues: Issue[] = [];
  const humans = players.filter((p) => !p.isBot);

  if (humans.length < opts.minLobbyPlayers) {
    issues.push({ level: 'warning', code: 'LOBBY_TOO_SMALL', params: { count: humans.length, min: opts.minLobbyPlayers } });
  }

  for (const p of humans) {
    if (p.kills != null && (p.kills < 0 || p.kills > opts.maxKillsPerPlayer)) {
      issues.push({ level: 'error', code: 'KILLS_TOO_HIGH', params: { target: p.name, kills: p.kills } });
    }
  }

  const seen = new Map<number, number[]>();

  for (const r of results) {
    const team = teamNames.get(r.teamId) ?? String(r.teamId);
    if (r.placement == null) {
      issues.push({ level: 'error', code: 'MISSING_PLACEMENT', params: { team } });
    } else {
      if (r.placement < 1 || r.placement > 100) {
        issues.push({ level: 'error', code: 'PLACEMENT_OUT_OF_RANGE', params: { team, placement: r.placement } });
      }
      seen.set(r.placement, [...(seen.get(r.placement) ?? []), r.teamId]);
    }
    if (r.kills == null) {
      issues.push({ level: 'error', code: 'MISSING_KILLS', params: { team } });
    } else if (r.kills < 0 || r.kills > opts.maxKillsPerPlayer * 4) {
      issues.push({ level: 'error', code: 'KILLS_TOO_HIGH', params: { target: team, kills: r.kills } });
    }
  }

  for (const [placement, teamIds] of seen) {
    if (teamIds.length > 1) {
      issues.push({
        level: 'error',
        code: 'DUPLICATE_PLACEMENT',
        params: { placement, teams: teamIds.map((id) => teamNames.get(id) ?? id).join(', ') },
      });
    }
  }
  return issues;
}
