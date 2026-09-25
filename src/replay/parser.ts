import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { env } from '../config';
import type { ParsedPlayer, ParsedReplay } from '../core/types';

const execFileAsync = promisify(execFile);

/** リプレイ解析エンジンの共通インターフェース */
export interface ReplayParser {
  readonly name: string;
  parse(filePath: string): Promise<ParsedReplay>;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * fortnite-replay-analysis の PlayerData（C# 側の出力 = FortniteReplayDecompressor ベース）を正規化する。
 * 外部バイナリ方式でも同じ JSON 形式（{ GameData, PlayerData, KillFeed }）を想定する。
 */
export function normalizePlayerData(players: any[], sessionId: string | null, parser: string): ParsedReplay {
  const normalized: ParsedPlayer[] = players.map((p) => ({
    epicId: p.EpicId ? String(p.EpicId) : null,
    name: String(p.PlayerName ?? p.epicName ?? ''),
    partyNumber: num(p.TeamIndex ?? p.partyNumber),
    placement: num(p.Placement),
    kills: num(p.Kills),
    teamKills: num(p.TeamKills),
    isBot: !!p.IsBot,
    isReplayOwner: !!p.IsReplayOwner,
  }));
  return { sessionId, parser, players: normalized };
}

/**
 * 第一候補: fortnite-replay-analysis (yuyutti/Fortnite_Replay_Analysis)
 * - 自己完結バイナリ同梱（Linux x64 / Windows x64）で .NET ランタイムのインストール不要
 * - Placement が欠けている場合は KillFeed から順位を復元した値（hybrid）を使う
 */
export class FortniteReplayAnalysisParser implements ReplayParser {
  readonly name = 'fortnite-replay-analysis';

  async parse(filePath: string): Promise<ParsedReplay> {
    // CommonJS パッケージ。バイナリのパスを process.cwd() から解決するため、Bot はプロジェクト直下で起動すること。
    const { ReplayAnalysis } = await import('fortnite-replay-analysis');
    const result = await ReplayAnalysis(filePath, { bot: true, sort: true });
    const sessionId = result.rawReplayData?.GameData?.GameSessionId ?? null;
    const players: ParsedPlayer[] = result.processedPlayerInfo.hybrid.map((p) => ({
      epicId: p.EpicId,
      name: p.PlayerName ?? '',
      partyNumber: p.partyNumber,
      placement: p.Placement,
      kills: p.Kills,
      teamKills: p.TeamKills,
      isBot: p.IsBot,
      isReplayOwner: p.IsReplayOwner,
    }));
    return { sessionId: sessionId ? String(sessionId) : null, parser: this.name, players };
  }
}

/**
 * 代替: 任意の外部バイナリ（例: FortniteReplayDecompressor を使った自作 .NET CLI）を子プロセスで呼び出す。
 * `<bin> <replayPath>` で { GameData: { GameSessionId }, PlayerData: [...] } 形式の JSON を標準出力する想定。
 */
export class ExternalBinaryParser implements ReplayParser {
  readonly name = 'external';

  constructor(private readonly bin: string) {}

  async parse(filePath: string): Promise<ParsedReplay> {
    const { stdout } = await execFileAsync(this.bin, [filePath], { maxBuffer: 1024 * 1024 * 200, timeout: 10 * 60 * 1000 });
    const json = JSON.parse(stdout);
    if (!Array.isArray(json.PlayerData)) throw new Error('Unexpected parser output: PlayerData is not an array');
    const sessionId = json.GameData?.GameSessionId ? String(json.GameData.GameSessionId) : null;
    return normalizePlayerData(json.PlayerData, sessionId, this.name);
  }
}

export function createParser(): ReplayParser {
  if (env.replayParser === 'external') {
    if (!env.replayParserBin) throw new Error('REPLAY_PARSER=external requires REPLAY_PARSER_BIN');
    return new ExternalBinaryParser(env.replayParserBin);
  }
  return new FortniteReplayAnalysisParser();
}
