import { getTournament } from '../config';
import type { AppContext } from '../context';
import { computePoints } from '../core/scoring';
import type { TeamMatchResult } from '../core/types';
import type { NewMatchResult } from '../db';
import { t } from '../i18n';
import { createLogger } from '../logger';
import { notifyCaster } from '../utils/discord';
import { updateStandingsMessage } from './standingsService';

const log = createLogger('result');

export function toResultRows(matchId: number, results: TeamMatchResult[]): NewMatchResult[] {
  const scoring = getTournament().scoring;
  return results.map((r) => ({
    matchId,
    teamId: r.teamId,
    placement: r.placement,
    kills: r.kills,
    ...computePoints(r.placement, r.kills, scoring),
  }));
}

/** 解析結果（プレビュー）を確定して順位表に反映する */
export async function approveMatch(ctx: AppContext, matchId: number, results: TeamMatchResult[], actorId: string): Promise<void> {
  const match = await ctx.repo.getMatch(matchId);
  if (!match) throw new Error(`match ${matchId} not found`);
  const rows = toResultRows(matchId, results);
  await ctx.repo.replaceResults(matchId, rows);
  await ctx.repo.updateMatch(matchId, {
    status: 'approved',
    approvedBy: actorId,
    approvedAt: new Date().toISOString(),
    playedAt: match.playedAt ?? new Date().toISOString(),
  });
  await ctx.repo.audit('match.approve', actorId, { matchId, matchNumber: match.matchNumber, results: rows });
  log.info(`match ${match.matchNumber} approved by ${actorId}`);
  await updateStandingsMessage(ctx);

  const teams = new Map((await ctx.repo.listTeams(['active', 'cancelled'])).map((team) => [team.id, team.name]));
  const winner = results.find((r) => r.placement === 1);
  await notifyCaster(
    ctx.client,
    t('result.casterMatchApproved', { match: match.matchNumber, winner: winner ? (teams.get(winner.teamId) ?? '-') : '-' }),
  );
}

export async function rejectMatch(ctx: AppContext, matchId: number, actorId: string): Promise<void> {
  await ctx.repo.updateMatch(matchId, { status: 'rejected' });
  await ctx.repo.audit('match.reject', actorId, { matchId });
}

/**
 * 手動修正（またはリプレイ解析が使えない場合の手動入力）。
 * 試合が未作成なら作成し、手動入力の試合として即確定扱いにする。
 */
export async function fixResult(
  ctx: AppContext,
  input: { matchNumber: number; teamId: number; placement?: number | null; kills?: number | null; remove?: boolean; reason: string; actorId: string },
): Promise<{ placement: number | null; kills: number | null; totalPoints: number } | null> {
  const match = await ctx.repo.getOrCreateMatch(input.matchNumber);
  const before = (await ctx.repo.listResults(match.id)).find((r) => r.teamId === input.teamId) ?? null;

  let after: NewMatchResult | null = null;
  if (input.remove) {
    await ctx.repo.deleteResult(match.id, input.teamId);
  } else {
    const placement = input.placement !== undefined ? input.placement : (before?.placement ?? null);
    const kills = input.kills !== undefined ? input.kills : (before?.kills ?? null);
    after = toResultRows(match.id, [{ teamId: input.teamId, placement, kills }])[0];
    await ctx.repo.upsertResult(after);
  }
  if (match.status !== 'approved') {
    await ctx.repo.updateMatch(match.id, {
      status: 'approved',
      source: match.status === 'collecting' && !match.previewJson ? 'manual' : match.source,
      approvedBy: input.actorId,
      approvedAt: new Date().toISOString(),
      playedAt: match.playedAt ?? new Date().toISOString(),
    });
  }
  await ctx.repo.audit('result.fix', input.actorId, { matchNumber: input.matchNumber, teamId: input.teamId, reason: input.reason, before, after });
  await updateStandingsMessage(ctx);
  return after ? { placement: after.placement, kills: after.kills, totalPoints: after.totalPoints } : null;
}

/** 保存済みの順位・キル数から、現在のルールでポイントを再計算する */
export async function recalculateAll(ctx: AppContext, actorId: string): Promise<number> {
  const results = await ctx.repo.listResults();
  const scoring = getTournament().scoring;
  for (const r of results) {
    const points = computePoints(r.placement, r.kills, scoring);
    await ctx.repo.upsertResult({ matchId: r.matchId, teamId: r.teamId, placement: r.placement, kills: r.kills, ...points });
  }
  await ctx.repo.audit('result.recalculate', actorId, { count: results.length, scoring });
  await updateStandingsMessage(ctx);
  return results.length;
}
