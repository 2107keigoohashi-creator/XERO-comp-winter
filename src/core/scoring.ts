import type { ScoringConfig } from '../config';

export interface PointBreakdown {
  placementPoints: number;
  killPoints: number;
  totalPoints: number;
}

export function placementPointsFor(placement: number | null, scoring: ScoringConfig): number {
  if (placement == null) return 0;
  return scoring.placementPoints[String(placement)] ?? 0;
}

export function countedKills(kills: number | null, scoring: ScoringConfig): number {
  const k = Math.max(0, kills ?? 0);
  return scoring.killCap != null ? Math.min(k, scoring.killCap) : k;
}

/** 1試合分のポイント内訳を計算する */
export function computePoints(placement: number | null, kills: number | null, scoring: ScoringConfig): PointBreakdown {
  const placementPoints = placementPointsFor(placement, scoring);
  const killPoints = countedKills(kills, scoring) * scoring.pointsPerKill;
  return { placementPoints, killPoints, totalPoints: placementPoints + killPoints };
}
