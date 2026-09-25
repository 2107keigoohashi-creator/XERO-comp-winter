import { playerKey } from './normalize';
import type { Issue, ParsedPlayer, ParsedReplay } from './types';

export interface MergeResult {
  players: ParsedPlayer[];
  issues: Issue[];
}

/**
 * 同じ試合の複数リプレイ（別クライアント視点）を統合する。
 *
 * 統合ルール:
 *  1. プレイヤーは Epic ID（なければ表示名）で同一視する。どれか1つのリプレイにいれば結果に含める。
 *  2. 順位: null 以外の値を採用。リプレイ間で食い違う場合は
 *     (a) そのプレイヤーのチームがリプレイ所有者（録画者）のチームであるリプレイの値
 *     (b) それが無ければ多数決
 *     (c) 多数決でも決まらなければ小さい（良い）方
 *     の順で採用し、MERGE_PLACEMENT_CONFLICT として警告する。
 *  3. キル数: 遠くのプレイヤーのキルは取りこぼされる（減る方向にしかズレない）ため最大値を採用。
 *     値が異なる場合は MERGE_KILLS_DIFFER として情報通知する。
 *  4. その他の項目（チーム番号・Epic ID・表示名）は最初に見つかった null 以外の値。
 */
export function mergeReplays(replays: ParsedReplay[]): MergeResult {
  const issues: Issue[] = [];
  if (replays.length === 0) return { players: [], issues };
  if (replays.length === 1) return { players: replays[0].players.map((p) => ({ ...p })), issues };

  interface Observation {
    player: ParsedPlayer;
    fromOwnerTeam: boolean;
  }
  const observations = new Map<string, Observation[]>();
  const order: string[] = [];

  for (const replay of replays) {
    const owner = replay.players.find((p) => p.isReplayOwner);
    for (const player of replay.players) {
      const key = playerKey(player);
      if (!observations.has(key)) {
        observations.set(key, []);
        order.push(key);
      }
      observations.get(key)!.push({
        player,
        fromOwnerTeam: owner != null && owner.partyNumber != null && owner.partyNumber === player.partyNumber,
      });
    }
  }

  const players = order.map((key) => {
    const obs = observations.get(key)!;
    const first = <K extends keyof ParsedPlayer>(k: K): ParsedPlayer[K] | null =>
      obs.map((o) => o.player[k]).find((v) => v != null && v !== '') ?? null;

    const merged: ParsedPlayer = {
      epicId: first('epicId'),
      name: first('name') ?? '',
      partyNumber: first('partyNumber'),
      placement: resolvePlacement(obs, key, issues),
      kills: resolveKills(obs, key, issues),
      teamKills: maxOrNull(obs.map((o) => o.player.teamKills)),
      isBot: obs.some((o) => o.player.isBot),
      isReplayOwner: obs.some((o) => o.player.isReplayOwner),
    };
    return merged;
  });

  return { players, issues };

  function resolvePlacement(obs: Observation[], key: string, out: Issue[]): number | null {
    const values = obs.filter((o) => o.player.placement != null);
    if (values.length === 0) return null;
    const distinct = [...new Set(values.map((o) => o.player.placement!))];
    if (distinct.length === 1) return distinct[0];

    let chosen: number;
    const ownerValues = [...new Set(values.filter((o) => o.fromOwnerTeam).map((o) => o.player.placement!))];
    if (ownerValues.length === 1) {
      chosen = ownerValues[0];
    } else {
      const counts = new Map<number, number>();
      for (const v of values) counts.set(v.player.placement!, (counts.get(v.player.placement!) ?? 0) + 1);
      const max = Math.max(...counts.values());
      chosen = Math.min(...[...counts.entries()].filter(([, c]) => c === max).map(([p]) => p));
    }
    out.push({
      level: 'warning',
      code: 'MERGE_PLACEMENT_CONFLICT',
      params: { player: displayName(obs, key), values: distinct.join('/'), chosen },
    });
    return chosen;
  }

  function resolveKills(obs: Observation[], key: string, out: Issue[]): number | null {
    const values = obs.map((o) => o.player.kills).filter((k): k is number => k != null);
    if (values.length === 0) return null;
    const max = Math.max(...values);
    if (new Set(values).size > 1) {
      out.push({
        level: 'info',
        code: 'MERGE_KILLS_DIFFER',
        params: { player: displayName(obs, key), values: [...new Set(values)].join('/'), chosen: max },
      });
    }
    return max;
  }
}

function maxOrNull(values: (number | null | undefined)[]): number | null {
  const nums = values.filter((v): v is number => v != null);
  return nums.length ? Math.max(...nums) : null;
}

function displayName(obs: { player: ParsedPlayer }[], key: string): string {
  return obs.find((o) => o.player.name)?.player.name ?? key;
}
