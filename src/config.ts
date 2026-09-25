import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ quiet: true } as dotenv.DotenvConfigOptions);

export type TeamFormat = 'solo' | 'duo' | 'trio' | 'squad';

export const TEAM_SIZE: Record<TeamFormat, number> = { solo: 1, duo: 2, trio: 3, squad: 4 };

export type TiebreakerKey =
  | 'victory_royales'
  | 'avg_kills'
  | 'avg_placement'
  | 'total_kills'
  | 'last_match_placement';

export interface RoundConfig {
  round: number;
  name: string;
  startAt: string;
  matches: number[];
  checkinOpenMinutesBefore: number;
  checkinCloseMinutesBefore: number;
  reminderMinutesBefore: number[];
}

export interface ScoringConfig {
  placementPoints: Record<string, number>;
  pointsPerKill: number;
  killCap: number | null;
  tiebreakers: TiebreakerKey[];
}

export interface TournamentConfig {
  name: string;
  language: 'ja' | 'en';
  format: TeamFormat;
  totalMatches: number;
  entry: {
    open: boolean;
    deadline: string | null;
    maxTeams: number;
    requireEpicId: boolean;
  };
  scoring: ScoringConfig;
  rounds: RoundConfig[];
  standings: { displayTop: number };
  validation: { maxKillsPerPlayer: number; minLobbyPlayers: number };
}

/** Fortnite 公式ルールに準拠したデフォルトのタイブレーク順 */
export const DEFAULT_TIEBREAKERS: TiebreakerKey[] = ['victory_royales', 'avg_kills', 'avg_placement', 'last_match_placement'];

const TIEBREAKER_KEYS: TiebreakerKey[] = ['victory_royales', 'avg_kills', 'avg_placement', 'total_kills', 'last_match_placement'];

function list(value: string | undefined): string[] {
  return (value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
}

function optional(value: string | undefined): string | null {
  return value && value.trim() ? value.trim() : null;
}

export const env = {
  token: process.env.DISCORD_TOKEN ?? '',
  clientId: process.env.DISCORD_CLIENT_ID ?? '',
  guildId: process.env.DISCORD_GUILD_ID ?? '',
  opsRoleIds: list(process.env.OPS_ROLE_IDS),
  hostRoleIds: list(process.env.HOST_ROLE_IDS),
  participantRoleId: optional(process.env.PARTICIPANT_ROLE_ID),
  opsChannelId: optional(process.env.OPS_CHANNEL_ID),
  checkinChannelId: optional(process.env.CHECKIN_CHANNEL_ID),
  standingsChannelId: optional(process.env.STANDINGS_CHANNEL_ID),
  announceChannelId: optional(process.env.ANNOUNCE_CHANNEL_ID),
  casterChannelId: optional(process.env.CASTER_CHANNEL_ID),
  tournamentConfigPath: process.env.TOURNAMENT_CONFIG_PATH ?? 'config/tournament.json',
  dataDir: process.env.DATA_DIR ?? 'data',
  logDir: process.env.LOG_DIR ?? 'logs',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  replayParser: process.env.REPLAY_PARSER ?? 'fortnite-replay-analysis',
  replayParserBin: optional(process.env.REPLAY_PARSER_BIN),
  replayMaxSizeMb: Number(process.env.REPLAY_MAX_SIZE_MB ?? 500),
  replayConcurrency: Math.max(1, Number(process.env.REPLAY_CONCURRENCY ?? 1)),
};

/** 設定ファイルを検証して返す。不正な値はここで弾き、起動時に気付けるようにする。 */
export function validateTournamentConfig(raw: unknown): TournamentConfig {
  // JSON 由来で欠けている項目があり得るため、ここでは緩い型で扱う
  const c = raw as any;
  const errors: string[] = [];
  if (!c || typeof c !== 'object') throw new Error('tournament config must be an object');
  if (!c.name) errors.push('name is required');
  if (!(c.format in TEAM_SIZE)) errors.push(`format must be one of ${Object.keys(TEAM_SIZE).join(', ')}`);
  if (!Number.isInteger(c.totalMatches) || c.totalMatches < 1) errors.push('totalMatches must be a positive integer');
  if (!c.entry || !Number.isInteger(c.entry.maxTeams) || c.entry.maxTeams < 1) errors.push('entry.maxTeams must be a positive integer');
  if (c.entry?.deadline && Number.isNaN(Date.parse(c.entry.deadline))) errors.push('entry.deadline must be an ISO date');
  if (!c.scoring?.placementPoints) errors.push('scoring.placementPoints is required');
  for (const [k, v] of Object.entries<unknown>(c.scoring?.placementPoints ?? {})) {
    if (!Number.isInteger(Number(k)) || typeof v !== 'number') errors.push(`scoring.placementPoints.${k} is invalid`);
  }
  if (typeof c.scoring?.pointsPerKill !== 'number') errors.push('scoring.pointsPerKill must be a number');
  if (c.scoring?.killCap != null && (!Number.isInteger(c.scoring.killCap) || c.scoring.killCap < 0)) {
    errors.push('scoring.killCap must be null or a non-negative integer');
  }
  const tiebreakers: TiebreakerKey[] = c.scoring?.tiebreakers ?? DEFAULT_TIEBREAKERS;
  for (const tb of tiebreakers) {
    if (!TIEBREAKER_KEYS.includes(tb)) errors.push(`unknown tiebreaker: ${tb}`);
  }
  for (const r of (c.rounds ?? []) as RoundConfig[]) {
    if (Number.isNaN(Date.parse(r.startAt))) errors.push(`rounds[${r.round}].startAt must be an ISO date`);
  }
  if (errors.length) throw new Error(`Invalid tournament config:\n - ${errors.join('\n - ')}`);

  return {
    ...c,
    language: c.language ?? 'ja',
    entry: { open: true, deadline: null, requireEpicId: false, ...c.entry },
    scoring: { killCap: null, ...c.scoring, tiebreakers },
    rounds: ((c.rounds ?? []) as Partial<RoundConfig>[]).map((r) => ({
      checkinOpenMinutesBefore: 60,
      checkinCloseMinutesBefore: 15,
      reminderMinutesBefore: [],
      matches: [],
      ...r,
    })),
    standings: { displayTop: 20, ...c.standings },
    validation: { maxKillsPerPlayer: 40, minLobbyPlayers: 10, ...c.validation },
  };
}

let tournament: TournamentConfig | null = null;

export function loadTournamentConfig(file = env.tournamentConfigPath): TournamentConfig {
  const full = path.resolve(file);
  tournament = validateTournamentConfig(JSON.parse(fs.readFileSync(full, 'utf8')));
  return tournament;
}

export function getTournament(): TournamentConfig {
  return tournament ?? loadTournamentConfig();
}

export function teamSize(): number {
  return TEAM_SIZE[getTournament().format];
}
