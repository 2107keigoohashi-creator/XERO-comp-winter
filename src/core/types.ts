/** 解析エンジンに依存しない、正規化済みのリプレイ上のプレイヤー情報 */
export interface ParsedPlayer {
  epicId: string | null;
  name: string;
  /** リプレイ上のチーム番号（TeamIndex） */
  partyNumber: number | null;
  placement: number | null;
  /** 個人キル。Fortnite のリプレイでは 0 キルの場合に記録されず null になる */
  kills: number | null;
  /** リプレイ上のチーム合計キル（取得できれば） */
  teamKills?: number | null;
  isBot: boolean;
  isReplayOwner: boolean;
}

export interface ParsedReplay {
  sessionId: string | null;
  parser: string;
  players: ParsedPlayer[];
}

export interface RegisteredPlayer {
  id: number;
  discordId: string;
  epicName: string;
  epicId: string | null;
}

export interface RegisteredTeam {
  id: number;
  name: string;
  players: RegisteredPlayer[];
}

export interface TeamMatchResult {
  teamId: number;
  placement: number | null;
  kills: number | null;
}

export type IssueLevel = 'error' | 'warning' | 'info';

export type IssueCode =
  | 'UNKNOWN_PLAYER'
  | 'MISSING_PLAYER'
  | 'TEAM_NOT_FOUND'
  | 'MISSING_PLACEMENT'
  | 'MISSING_KILLS'
  | 'KILLS_TOO_HIGH'
  | 'PLACEMENT_OUT_OF_RANGE'
  | 'DUPLICATE_PLACEMENT'
  | 'TEAM_SPLIT'
  | 'PLACEMENT_MISMATCH_IN_TEAM'
  | 'LOBBY_TOO_SMALL'
  | 'NO_SESSION_ID'
  | 'DUPLICATE_SESSION'
  | 'SESSION_MISMATCH'
  | 'DUPLICATE_FILE'
  | 'MERGE_PLACEMENT_CONFLICT'
  | 'MERGE_KILLS_DIFFER';

export interface Issue {
  level: IssueLevel;
  code: IssueCode;
  params: Record<string, string | number>;
}
