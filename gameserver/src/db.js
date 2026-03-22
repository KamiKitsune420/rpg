import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'gameserver.db');

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

// WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    UNIQUE NOT NULL,
    display_name TEXT    NOT NULL,
    api_secret   TEXT    NOT NULL,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS versions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id       INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    version       TEXT    NOT NULL,
    download_url  TEXT,
    release_notes TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS license_keys (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    key        TEXT    UNIQUE NOT NULL,
    note       TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Max 5 rows per key_id (enforced in application logic with rolling eviction)
  CREATE TABLE IF NOT EXISTS activations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    key_id       INTEGER NOT NULL REFERENCES license_keys(id) ON DELETE CASCADE,
    machine_id   TEXT    NOT NULL,
    activated_at TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(key_id, machine_id)
  );

  CREATE TABLE IF NOT EXISTS motd (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    type       TEXT    NOT NULL CHECK(type IN ('text', 'audio')),
    content    TEXT    NOT NULL,
    audio_url  TEXT,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS gifts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    code        TEXT    UNIQUE NOT NULL,
    description TEXT    NOT NULL,
    reward_data TEXT    NOT NULL,
    max_claims  INTEGER NOT NULL DEFAULT 0,
    expires_at  TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS gift_claims (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    gift_id    INTEGER NOT NULL REFERENCES gifts(id) ON DELETE CASCADE,
    machine_id TEXT    NOT NULL,
    claimed_at TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(gift_id, machine_id)
  );

  -- One score entry per player per game.
  -- Submitting again replaces the previous score (INSERT OR REPLACE).
  -- score is REAL so games can use decimals (e.g. times like 12.345).
  CREATE TABLE IF NOT EXISTS scores (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id      INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    machine_id   TEXT    NOT NULL,
    player_name  TEXT    NOT NULL,
    score        REAL    NOT NULL,
    submitted_at TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(game_id, machine_id)
  );
`);

export default db;
