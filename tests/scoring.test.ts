import { describe, expect, it } from 'vitest';
import { computePoints } from '../src/core/scoring';
import { scoring } from './helpers';

describe('computePoints', () => {
  it('順位ポイントとキルポイントを合算する', () => {
    expect(computePoints(1, 5, scoring)).toEqual({ placementPoints: 11, killPoints: 5, totalPoints: 16 });
    expect(computePoints(3, 2, scoring)).toEqual({ placementPoints: 5, killPoints: 2, totalPoints: 7 });
  });

  it('ポイント表にない順位は 0 点', () => {
    expect(computePoints(25, 1, scoring).placementPoints).toBe(0);
  });

  it('キル上限を適用する', () => {
    expect(computePoints(2, 12, { ...scoring, killCap: 8 })).toEqual({ placementPoints: 6, killPoints: 8, totalPoints: 14 });
  });

  it('1キルあたりのポイントを反映する', () => {
    expect(computePoints(null, 3, { ...scoring, pointsPerKill: 2 })).toEqual({ placementPoints: 0, killPoints: 6, totalPoints: 6 });
  });

  it('欠損値は 0 扱い', () => {
    expect(computePoints(null, null, scoring).totalPoints).toBe(0);
  });
});
