/** SQLite スキーマ。Postgres でもほぼそのまま使えるよう標準的な型だけを使う。 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active','waitlist','cancelled')),
    captain_discord_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_teams_status ON teams(status);

  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL REFERENCES teams(id),
    discord_id TEXT NOT NULL,
    epic_name TEXT NOT NULL,
    epic_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_players_team ON players(team_id);
  CREATE INDEX IF NOT EXISTS idx_players_discord ON players(discord_id);

  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_number INTEGER NOT NULL UNIQUE,
    session_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('collecting','pending','approved','rejected')),
    source TEXT NOT NULL DEFAULT 'replay',
    preview_json TEXT,
    preview_message_id TEXT,
    played_at TEXT,
    approved_by TEXT,
    approved_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_matches_session ON matches(session_id);

  CREATE TABLE IF NOT EXISTS replays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id INTEGER NOT NULL REFERENCES matches(id),
    file_path TEXT NOT NULL,
    source_url TEXT,
    file_hash TEXT NOT NULL,
    uploaded_by TEXT NOT NULL,
    session_id TEXT,
    parse_status TEXT NOT NULL CHECK (parse_status IN ('queued','parsing','parsed','failed')),
    parsed_at TEXT,
    parsed_json_path TEXT,
    error TEXT,
    excluded INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_replays_match ON replays(match_id);
  CREATE INDEX IF NOT EXISTS idx_replays_hash ON replays(file_hash);

  CREATE TABLE IF NOT EXISTS match_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id INTEGER NOT NULL REFERENCES matches(id),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    placement INTEGER,
    kills INTEGER,
    placement_points REAL NOT NULL DEFAULT 0,
    kill_points REAL NOT NULL DEFAULT 0,
    total_points REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    UNIQUE (match_id, team_id)
  );

  CREATE TABLE IF NOT EXISTS penalties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL REFERENCES teams(id),
    points REAL NOT NULL,
    reason TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS checkins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL REFERENCES teams(id),
    round INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('checked_in','absent')),
    discord_id TEXT,
    checked_in_at TEXT NOT NULL,
    UNIQUE (team_id, round)
  );

  CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    body TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  `,
];
