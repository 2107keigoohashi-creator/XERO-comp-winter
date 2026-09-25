import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { RegisteredTeam } from '../core/types';
import { MIGRATIONS } from './schema';
import type {
  AuditEntry,
  Checkin,
  Match,
  MatchResult,
  NewMatchResult,
  NewTeamInput,
  Penalty,
  Player,
  Replay,
  Repository,
  Team,
  TeamStatus,
  TeamWithPlayers,
  Template,
} from './types';

type Row = Record<string, any>;

const now = (): string => new Date().toISOString();

/** camelCase のパッチを snake_case の UPDATE 文にする */
function buildUpdate(table: string, id: number, patch: Record<string, unknown>, columns: Record<string, string>) {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || !(k in columns)) continue;
    sets.push(`${columns[k]} = ?`);
    values.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
  }
  return { sql: `UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, values: [...values, id], empty: sets.length === 0 };
}

const toTeam = (r: Row): Team => ({
  id: r.id,
  name: r.name,
  status: r.status,
  captainDiscordId: r.captain_discord_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toPlayer = (r: Row): Player => ({ id: r.id, teamId: r.team_id, discordId: r.discord_id, epicName: r.epic_name, epicId: r.epic_id });
const toMatch = (r: Row): Match => ({
  id: r.id,
  matchNumber: r.match_number,
  sessionId: r.session_id,
  status: r.status,
  source: r.source,
  previewJson: r.preview_json,
  previewMessageId: r.preview_message_id,
  playedAt: r.played_at,
  approvedBy: r.approved_by,
  approvedAt: r.approved_at,
});
const toReplay = (r: Row): Replay => ({
  id: r.id,
  matchId: r.match_id,
  filePath: r.file_path,
  sourceUrl: r.source_url,
  fileHash: r.file_hash,
  uploadedBy: r.uploaded_by,
  sessionId: r.session_id,
  parseStatus: r.parse_status,
  parsedAt: r.parsed_at,
  parsedJsonPath: r.parsed_json_path,
  error: r.error,
  excluded: !!r.excluded,
  createdAt: r.created_at,
});
const toResult = (r: Row): MatchResult => ({
  id: r.id,
  matchId: r.match_id,
  matchNumber: r.match_number,
  teamId: r.team_id,
  placement: r.placement,
  kills: r.kills,
  placementPoints: r.placement_points,
  killPoints: r.kill_points,
  totalPoints: r.total_points,
});
const toPenalty = (r: Row): Penalty => ({
  id: r.id,
  teamId: r.team_id,
  points: r.points,
  reason: r.reason,
  createdBy: r.created_by,
  createdAt: r.created_at,
});
const toCheckin = (r: Row): Checkin => ({
  id: r.id,
  teamId: r.team_id,
  round: r.round,
  status: r.status,
  discordId: r.discord_id,
  checkedInAt: r.checked_in_at,
});
const toTemplate = (r: Row): Template => ({
  id: r.id,
  name: r.name,
  body: r.body,
  channelId: r.channel_id,
  createdBy: r.created_by,
  updatedAt: r.updated_at,
});

export class SqliteRepository implements Repository {
  private db: Database.Database;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = this.db.prepare('SELECT version FROM schema_version').get() as Row | undefined;
    let version = row?.version ?? 0;
    if (!row) this.db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
    for (; version < MIGRATIONS.length; version++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[version]);
        this.db.prepare('UPDATE schema_version SET version = ?').run(version + 1);
      })();
    }
  }

  close(): void {
    this.db.close();
  }

  // ---------- teams ----------

  private withPlayers(team: Team): TeamWithPlayers {
    const players = (this.db.prepare('SELECT * FROM players WHERE team_id = ? ORDER BY id').all(team.id) as Row[]).map(toPlayer);
    return { ...team, players };
  }

  async createTeam(input: NewTeamInput): Promise<TeamWithPlayers> {
    const id = this.db.transaction(() => {
      const ts = now();
      const res = this.db
        .prepare('INSERT INTO teams (name, status, captain_discord_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(input.name, input.status, input.captainDiscordId, ts, ts);
      const teamId = Number(res.lastInsertRowid);
      const insert = this.db.prepare('INSERT INTO players (team_id, discord_id, epic_name, epic_id) VALUES (?, ?, ?, ?)');
      for (const p of input.players) insert.run(teamId, p.discordId, p.epicName, p.epicId);
      return teamId;
    })();
    return (await this.getTeam(id))!;
  }

  async getTeam(id: number): Promise<TeamWithPlayers | null> {
    const r = this.db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as Row | undefined;
    return r ? this.withPlayers(toTeam(r)) : null;
  }

  async getTeamByName(name: string): Promise<TeamWithPlayers | null> {
    const r = this.db
      .prepare("SELECT * FROM teams WHERE name = ? COLLATE NOCASE AND status != 'cancelled' ORDER BY id DESC LIMIT 1")
      .get(name) as Row | undefined;
    return r ? this.withPlayers(toTeam(r)) : null;
  }

  async findTeamByDiscordId(discordId: string): Promise<TeamWithPlayers | null> {
    const r = this.db
      .prepare(
        `SELECT t.* FROM teams t JOIN players p ON p.team_id = t.id
         WHERE p.discord_id = ? AND t.status IN ('active','waitlist') ORDER BY t.id DESC LIMIT 1`,
      )
      .get(discordId) as Row | undefined;
    return r ? this.withPlayers(toTeam(r)) : null;
  }

  async listTeams(statuses: TeamStatus[] = ['active', 'waitlist']): Promise<TeamWithPlayers[]> {
    const rows = this.db
      .prepare(`SELECT * FROM teams WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY id`)
      .all(...statuses) as Row[];
    return rows.map((r) => this.withPlayers(toTeam(r)));
  }

  async countTeams(status: TeamStatus): Promise<number> {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM teams WHERE status = ?').get(status) as Row).c;
  }

  async updateTeam(id: number, patch: Partial<Pick<Team, 'name' | 'status' | 'captainDiscordId'>>): Promise<void> {
    const u = buildUpdate('teams', id, { ...patch, updatedAt: now() }, {
      name: 'name',
      status: 'status',
      captainDiscordId: 'captain_discord_id',
      updatedAt: 'updated_at',
    });
    this.db.prepare(u.sql).run(...u.values);
  }

  async updatePlayer(id: number, patch: Partial<Pick<Player, 'discordId' | 'epicName' | 'epicId'>>): Promise<void> {
    const u = buildUpdate('players', id, patch, { discordId: 'discord_id', epicName: 'epic_name', epicId: 'epic_id' });
    if (!u.empty) this.db.prepare(u.sql).run(...u.values);
  }

  async listRegisteredTeams(): Promise<RegisteredTeam[]> {
    const teams = await this.listTeams(['active']);
    return teams.map((t) => ({
      id: t.id,
      name: t.name,
      players: t.players.map((p) => ({ id: p.id, discordId: p.discordId, epicName: p.epicName, epicId: p.epicId })),
    }));
  }

  async firstWaitlistTeam(): Promise<TeamWithPlayers | null> {
    const r = this.db.prepare("SELECT * FROM teams WHERE status = 'waitlist' ORDER BY id LIMIT 1").get() as Row | undefined;
    return r ? this.withPlayers(toTeam(r)) : null;
  }

  // ---------- matches ----------

  async getMatch(id: number): Promise<Match | null> {
    const r = this.db.prepare('SELECT * FROM matches WHERE id = ?').get(id) as Row | undefined;
    return r ? toMatch(r) : null;
  }

  async getMatchByNumber(matchNumber: number): Promise<Match | null> {
    const r = this.db.prepare('SELECT * FROM matches WHERE match_number = ?').get(matchNumber) as Row | undefined;
    return r ? toMatch(r) : null;
  }

  async getOrCreateMatch(matchNumber: number): Promise<Match> {
    this.db
      .prepare("INSERT INTO matches (match_number, status) VALUES (?, 'collecting') ON CONFLICT(match_number) DO NOTHING")
      .run(matchNumber);
    return (await this.getMatchByNumber(matchNumber))!;
  }

  async findMatchBySession(sessionId: string): Promise<Match | null> {
    const r = this.db.prepare('SELECT * FROM matches WHERE session_id = ?').get(sessionId) as Row | undefined;
    return r ? toMatch(r) : null;
  }

  async updateMatch(id: number, patch: Partial<Omit<Match, 'id' | 'matchNumber'>>): Promise<void> {
    const u = buildUpdate('matches', id, patch, {
      sessionId: 'session_id',
      status: 'status',
      source: 'source',
      previewJson: 'preview_json',
      previewMessageId: 'preview_message_id',
      playedAt: 'played_at',
      approvedBy: 'approved_by',
      approvedAt: 'approved_at',
    });
    if (!u.empty) this.db.prepare(u.sql).run(...u.values);
  }

  async listMatches(): Promise<Match[]> {
    return (this.db.prepare('SELECT * FROM matches ORDER BY match_number').all() as Row[]).map(toMatch);
  }

  // ---------- replays ----------

  async createReplay(input: Pick<Replay, 'matchId' | 'filePath' | 'sourceUrl' | 'fileHash' | 'uploadedBy'>): Promise<Replay> {
    const res = this.db
      .prepare(
        `INSERT INTO replays (match_id, file_path, source_url, file_hash, uploaded_by, parse_status, created_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
      )
      .run(input.matchId, input.filePath, input.sourceUrl, input.fileHash, input.uploadedBy, now());
    return (await this.getReplay(Number(res.lastInsertRowid)))!;
  }

  async getReplay(id: number): Promise<Replay | null> {
    const r = this.db.prepare('SELECT * FROM replays WHERE id = ?').get(id) as Row | undefined;
    return r ? toReplay(r) : null;
  }

  async updateReplay(id: number, patch: Partial<Omit<Replay, 'id' | 'matchId' | 'createdAt'>>): Promise<void> {
    const u = buildUpdate('replays', id, patch, {
      filePath: 'file_path',
      sourceUrl: 'source_url',
      fileHash: 'file_hash',
      uploadedBy: 'uploaded_by',
      sessionId: 'session_id',
      parseStatus: 'parse_status',
      parsedAt: 'parsed_at',
      parsedJsonPath: 'parsed_json_path',
      error: 'error',
      excluded: 'excluded',
    });
    if (!u.empty) this.db.prepare(u.sql).run(...u.values);
  }

  async listReplays(matchId: number): Promise<Replay[]> {
    return (this.db.prepare('SELECT * FROM replays WHERE match_id = ? ORDER BY id').all(matchId) as Row[]).map(toReplay);
  }

  async findReplayByHash(hash: string): Promise<Replay | null> {
    const r = this.db
      .prepare("SELECT * FROM replays WHERE file_hash = ? AND parse_status != 'failed' AND excluded = 0 ORDER BY id LIMIT 1")
      .get(hash) as Row | undefined;
    return r ? toReplay(r) : null;
  }

  // ---------- results ----------

  private insertResult(row: NewMatchResult): void {
    this.db
      .prepare(
        `INSERT INTO match_results (match_id, team_id, placement, kills, placement_points, kill_points, total_points, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(match_id, team_id) DO UPDATE SET
           placement = excluded.placement, kills = excluded.kills,
           placement_points = excluded.placement_points, kill_points = excluded.kill_points,
           total_points = excluded.total_points, updated_at = excluded.updated_at`,
      )
      .run(row.matchId, row.teamId, row.placement, row.kills, row.placementPoints, row.killPoints, row.totalPoints, now());
  }

  async replaceResults(matchId: number, rows: NewMatchResult[]): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM match_results WHERE match_id = ?').run(matchId);
      for (const row of rows) this.insertResult(row);
    })();
  }

  async upsertResult(row: NewMatchResult): Promise<void> {
    this.insertResult(row);
  }

  async deleteResult(matchId: number, teamId: number): Promise<void> {
    this.db.prepare('DELETE FROM match_results WHERE match_id = ? AND team_id = ?').run(matchId, teamId);
  }

  async listResults(matchId?: number): Promise<MatchResult[]> {
    const base = 'SELECT r.*, m.match_number FROM match_results r JOIN matches m ON m.id = r.match_id';
    const rows = matchId == null
      ? (this.db.prepare(`${base} ORDER BY m.match_number, r.placement`).all() as Row[])
      : (this.db.prepare(`${base} WHERE r.match_id = ? ORDER BY r.placement`).all(matchId) as Row[]);
    return rows.map(toResult);
  }

  async listApprovedResults(): Promise<MatchResult[]> {
    return (
      this.db
        .prepare(
          `SELECT r.*, m.match_number FROM match_results r JOIN matches m ON m.id = r.match_id
           WHERE m.status = 'approved' ORDER BY m.match_number`,
        )
        .all() as Row[]
    ).map(toResult);
  }

  // ---------- penalties ----------

  async addPenalty(input: Omit<Penalty, 'id' | 'createdAt'>): Promise<Penalty> {
    const res = this.db
      .prepare('INSERT INTO penalties (team_id, points, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.teamId, input.points, input.reason, input.createdBy, now());
    return toPenalty(this.db.prepare('SELECT * FROM penalties WHERE id = ?').get(res.lastInsertRowid) as Row);
  }

  async deletePenalty(id: number): Promise<Penalty | null> {
    const r = this.db.prepare('SELECT * FROM penalties WHERE id = ?').get(id) as Row | undefined;
    if (!r) return null;
    this.db.prepare('DELETE FROM penalties WHERE id = ?').run(id);
    return toPenalty(r);
  }

  async listPenalties(teamId?: number): Promise<Penalty[]> {
    const rows = teamId == null
      ? (this.db.prepare('SELECT * FROM penalties ORDER BY id').all() as Row[])
      : (this.db.prepare('SELECT * FROM penalties WHERE team_id = ? ORDER BY id').all(teamId) as Row[]);
    return rows.map(toPenalty);
  }

  // ---------- checkins ----------

  async upsertCheckin(input: Omit<Checkin, 'id' | 'checkedInAt'>): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO checkins (team_id, round, status, discord_id, checked_in_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(team_id, round) DO UPDATE SET status = excluded.status, discord_id = excluded.discord_id,
           checked_in_at = excluded.checked_in_at`,
      )
      .run(input.teamId, input.round, input.status, input.discordId, now());
  }

  async listCheckins(round: number): Promise<Checkin[]> {
    return (this.db.prepare('SELECT * FROM checkins WHERE round = ? ORDER BY id').all(round) as Row[]).map(toCheckin);
  }

  // ---------- templates ----------

  async createTemplate(input: Omit<Template, 'id' | 'updatedAt'>): Promise<Template> {
    const res = this.db
      .prepare('INSERT INTO templates (name, body, channel_id, created_by, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.name, input.body, input.channelId, input.createdBy, now());
    return (await this.getTemplate(Number(res.lastInsertRowid)))!;
  }

  async updateTemplate(id: number, patch: Partial<Pick<Template, 'name' | 'body' | 'channelId'>>): Promise<void> {
    const u = buildUpdate('templates', id, { ...patch, updatedAt: now() }, {
      name: 'name',
      body: 'body',
      channelId: 'channel_id',
      updatedAt: 'updated_at',
    });
    this.db.prepare(u.sql).run(...u.values);
  }

  async deleteTemplate(id: number): Promise<void> {
    this.db.prepare('DELETE FROM templates WHERE id = ?').run(id);
  }

  async getTemplate(id: number): Promise<Template | null> {
    const r = this.db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as Row | undefined;
    return r ? toTemplate(r) : null;
  }

  async getTemplateByName(name: string): Promise<Template | null> {
    const r = this.db.prepare('SELECT * FROM templates WHERE name = ? COLLATE NOCASE').get(name) as Row | undefined;
    return r ? toTemplate(r) : null;
  }

  async listTemplates(): Promise<Template[]> {
    return (this.db.prepare('SELECT * FROM templates ORDER BY id').all() as Row[]).map(toTemplate);
  }

  // ---------- audit / settings ----------

  async audit(action: string, actorId: string, detail: unknown): Promise<void> {
    this.db
      .prepare('INSERT INTO audit_log (action, actor_id, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(action, actorId, JSON.stringify(detail ?? null), now());
  }

  async listAudit(limit: number): Promise<AuditEntry[]> {
    return (this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map((r) => ({
      id: r.id,
      action: r.action,
      actorId: r.actor_id,
      detail: r.detail,
      createdAt: r.created_at,
    }));
  }

  async getSetting(key: string): Promise<string | null> {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return r?.value ?? null;
  }

  async setSetting(key: string, value: string | null): Promise<void> {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }
}
