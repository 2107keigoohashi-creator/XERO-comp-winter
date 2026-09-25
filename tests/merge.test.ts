import { describe, expect, it } from 'vitest';
import { mergeReplays } from '../src/core/merge';
import type { ParsedReplay } from '../src/core/types';
import { player } from './helpers';

const replay = (players: ParsedReplay['players']): ParsedReplay => ({ sessionId: 's1', parser: 'test', players });

describe('mergeReplays', () => {
  it('1本だけならそのまま返す', () => {
    const r = replay([player({ name: 'A', placement: 1, kills: 2 })]);
    expect(mergeReplays([r]).players).toEqual(r.players);
  });

  it('片方にしかいないプレイヤーも含め、欠損値を補完する', () => {
    const a = replay([
      player({ name: 'A', epicId: 'id-a', partyNumber: 1, placement: 1, kills: 3, isReplayOwner: true }),
      player({ name: 'B', epicId: 'id-b', partyNumber: 2, placement: null, kills: null }),
    ]);
    const b = replay([
      player({ name: 'B', epicId: 'ID-B', partyNumber: 2, placement: 5, kills: 2, isReplayOwner: true }),
      player({ name: 'C', epicId: 'id-c', partyNumber: 3, placement: 9, kills: 0 }),
    ]);
    const { players, issues } = mergeReplays([a, b]);
    expect(players.map((p) => [p.name, p.placement, p.kills])).toEqual([
      ['A', 1, 3],
      ['B', 5, 2],
      ['C', 9, 0],
    ]);
    expect(issues).toEqual([]);
  });

  it('キル数が食い違う場合は最大値を採用して情報通知する', () => {
    const { players, issues } = mergeReplays([
      replay([player({ name: 'A', epicId: 'x', kills: 2, placement: 3 })]),
      replay([player({ name: 'A', epicId: 'x', kills: 5, placement: 3 })]),
    ]);
    expect(players[0].kills).toBe(5);
    expect(issues).toEqual([{ level: 'info', code: 'MERGE_KILLS_DIFFER', params: { player: 'A', values: '2/5', chosen: 5 } }]);
  });

  it('順位が食い違う場合はリプレイ所有者チームの値を優先する', () => {
    const { players, issues } = mergeReplays([
      replay([player({ name: 'A', epicId: 'x', partyNumber: 1, placement: 4 }), player({ name: 'Owner1', partyNumber: 9, isReplayOwner: true })]),
      replay([player({ name: 'A', epicId: 'x', partyNumber: 1, placement: 6 }), player({ name: 'Mate', partyNumber: 1, isReplayOwner: true })]),
    ]);
    expect(players.find((p) => p.name === 'A')?.placement).toBe(6);
    expect(issues.find((i) => i.code === 'MERGE_PLACEMENT_CONFLICT')?.params.chosen).toBe(6);
  });

  it('所有者チームの値が無ければ多数決、同数なら良い方を採用する', () => {
    const r = (placement: number) => replay([player({ name: 'A', epicId: 'x', partyNumber: 1, placement })]);
    expect(mergeReplays([r(7), r(4), r(7)]).players[0].placement).toBe(7);
    expect(mergeReplays([r(7), r(4)]).players[0].placement).toBe(4);
  });

  it('Epic ID が無いプレイヤーは表示名で同一視する', () => {
    const { players } = mergeReplays([
      replay([player({ name: 'NoId', kills: 1 })]),
      replay([player({ name: ' noid ', kills: 1, placement: 2 })]),
    ]);
    expect(players).toHaveLength(1);
    expect(players[0].placement).toBe(2);
  });
});
