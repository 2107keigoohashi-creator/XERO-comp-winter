/**
 * DB アクセス層のインターフェース。
 * Bot 本体はこのインターフェースだけに依存するので、将来 Supabase(Postgres) に移行する際は
 * 同じインターフェースを実装したクラスを追加し、src/db/index.ts で差し替えるだけでよい。
 * （そのため better-sqlite3 は同期 API だが、あえて全メソッドを Promise で返している）
 */
import type { RegisteredTeam } from '../core/types';

export type TeamStatus = 'active' | 'waitlist' | 'cancelled';
export type MatchStatus = 'collecting' | 'pending' | 'approved' | 'rejected';
export type ParseStatus = 'queued' | 'parsing' | 'parsed' | 'failed';
export type CheckinStatus = 'checked_in' | 'absent';

export interface Team {
  id: number;
  name: string;
  status: TeamStatus;
  captainDiscordId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Player {
  id: number;
  teamId: number;
  discordId: string;
  epicName: string;
  epicId: string | null;
}

export interface TeamWithPlayers extends Team {
  players: Player[];
}

export interface Match {
  id: number;
  matchNumber: number;
  sessionId: string | null;
  status: MatchStatus;
  source: 'replay' | 'manual';
  previewJson: string | null;
  previewMessageId: string | null;
  playedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface Replay {
  id: number;
  matchId: number;
  filePath: string;
  sourceUrl: string | null;
  fileHash: string;
  uploadedBy: string;
  sessionId: string | null;
  parseStatus: ParseStatus;
  parsedAt: string | null;
  parsedJsonPath: string | null;
  error: string | null;
  excluded: boolean;
  createdAt: string;
}

export interface MatchResult {
  id: number;
  matchId: number;
  matchNumber: number;
  teamId: number;
  placement: number | null;
  kills: number | null;
  placementPoints: number;
  killPoints: number;
  totalPoints: number;
}

export type NewMatchResult = Omit<MatchResult, 'id' | 'matchNumber'>;

export interface Penalty {
  id: number;
  teamId: number;
  points: number;
  reason: string;
  createdBy: string;
  createdAt: string;
}

export interface Checkin {
  id: number;
  teamId: number;
  round: number;
  status: CheckinStatus;
  discordId: string | null;
  checkedInAt: string;
}

export interface Template {
  id: number;
  name: string;
  body: string;
  channelId: string;
  createdBy: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: number;
  action: string;
  actorId: string;
  detail: string;
  createdAt: string;
}

export interface NewTeamInput {
  name: string;
  status: TeamStatus;
  captainDiscordId: string;
  players: { discordId: string; epicName: string; epicId: string | null }[];
}

export interface Repository {
  // teams / players
  createTeam(input: NewTeamInput): Promise<TeamWithPlayers>;
  getTeam(id: number): Promise<TeamWithPlayers | null>;
  getTeamByName(name: string): Promise<TeamWithPlayers | null>;
  /** 有効（active / waitlist）なチームのうち、指定ユーザーが所属するもの */
  findTeamByDiscordId(discordId: string): Promise<TeamWithPlayers | null>;
  listTeams(statuses?: TeamStatus[]): Promise<TeamWithPlayers[]>;
  countTeams(status: TeamStatus): Promise<number>;
  updateTeam(id: number, patch: Partial<Pick<Team, 'name' | 'status' | 'captainDiscordId'>>): Promise<void>;
  updatePlayer(id: number, patch: Partial<Pick<Player, 'discordId' | 'epicName' | 'epicId'>>): Promise<void>;
  /** 照合用: active なチームとメンバー */
  listRegisteredTeams(): Promise<RegisteredTeam[]>;
  firstWaitlistTeam(): Promise<TeamWithPlayers | null>;

  // matches
  getMatch(id: number): Promise<Match | null>;
  getMatchByNumber(matchNumber: number): Promise<Match | null>;
  getOrCreateMatch(matchNumber: number): Promise<Match>;
  findMatchBySession(sessionId: string): Promise<Match | null>;
  updateMatch(id: number, patch: Partial<Omit<Match, 'id' | 'matchNumber'>>): Promise<void>;
  listMatches(): Promise<Match[]>;

  // replays
  createReplay(input: Pick<Replay, 'matchId' | 'filePath' | 'sourceUrl' | 'fileHash' | 'uploadedBy'>): Promise<Replay>;
  getReplay(id: number): Promise<Replay | null>;
  updateReplay(id: number, patch: Partial<Omit<Replay, 'id' | 'matchId' | 'createdAt'>>): Promise<void>;
  listReplays(matchId: number): Promise<Replay[]>;
  findReplayByHash(hash: string): Promise<Replay | null>;

  // results
  replaceResults(matchId: number, rows: NewMatchResult[]): Promise<void>;
  upsertResult(row: NewMatchResult): Promise<void>;
  deleteResult(matchId: number, teamId: number): Promise<void>;
  listResults(matchId?: number): Promise<MatchResult[]>;
  /** 承認済みの試合の結果のみ（順位表計算用） */
  listApprovedResults(): Promise<MatchResult[]>;

  // penalties
  addPenalty(input: Omit<Penalty, 'id' | 'createdAt'>): Promise<Penalty>;
  deletePenalty(id: number): Promise<Penalty | null>;
  listPenalties(teamId?: number): Promise<Penalty[]>;

  // checkins
  upsertCheckin(input: Omit<Checkin, 'id' | 'checkedInAt'>): Promise<void>;
  listCheckins(round: number): Promise<Checkin[]>;

  // templates
  createTemplate(input: Omit<Template, 'id' | 'updatedAt'>): Promise<Template>;
  updateTemplate(id: number, patch: Partial<Pick<Template, 'name' | 'body' | 'channelId'>>): Promise<void>;
  deleteTemplate(id: number): Promise<void>;
  getTemplate(id: number): Promise<Template | null>;
  getTemplateByName(name: string): Promise<Template | null>;
  listTemplates(): Promise<Template[]>;

  // audit / settings
  audit(action: string, actorId: string, detail: unknown): Promise<void>;
  listAudit(limit: number): Promise<AuditEntry[]>;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string | null): Promise<void>;

  close(): void;
}
