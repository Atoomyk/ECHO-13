/**
 * Хранилище рекордов PULSE.
 *
 * По умолчанию SQLite через `node:sqlite` (Node >= 22.5): один файл на диске,
 * без отдельного сервера БД. Если модуль недоступен, прозрачно переключаемся
 * на JSON-файл, чтобы сервис поднимался в любом окружении.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scores (
  id           TEXT PRIMARY KEY,
  mode         TEXT NOT NULL,
  player       TEXT NOT NULL,
  score        INTEGER NOT NULL,
  elapsed_sec  REAL NOT NULL DEFAULT 0,
  clean_dodges INTEGER NOT NULL DEFAULT 0,
  hits         INTEGER NOT NULL DEFAULT 0,
  day          INTEGER,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scores_mode_score ON scores (mode, score DESC);
CREATE INDEX IF NOT EXISTS idx_scores_day_score ON scores (day, score DESC);
`;

/** Хранилище на JSON-файле — резервный вариант без внешних зависимостей. */
class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.kind = 'json';
    this._ensureFile();
  }

  _ensureFile() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) fs.writeFileSync(this.filePath, '[]', 'utf8');
  }

  _read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  _write(rows) {
    fs.writeFileSync(this.filePath, JSON.stringify(rows), 'utf8');
  }

  insert(entry) {
    const rows = this._read();
    rows.push(entry);
    this._write(rows);
  }

  top({ mode, day, limit }) {
    return this._read()
      .filter((row) => row.mode === mode && (day === null || row.day === day))
      .sort((a, b) => b.score - a.score || a.created_at.localeCompare(b.created_at))
      .slice(0, limit);
  }

  stats(mode) {
    const rows = this._read().filter((row) => row.mode === mode);
    if (rows.length === 0) return { games: 0, best: 0, average: 0 };
    const best = rows.reduce((max, row) => Math.max(max, row.score), 0);
    const total = rows.reduce((sum, row) => sum + row.score, 0);
    return { games: rows.length, best, average: Math.round(total / rows.length) };
  }
}

/** Хранилище на SQLite из стандартной библиотеки Node. */
class SqliteStore {
  /**
   * @param {string} filePath
   * @param {typeof import('node:sqlite').DatabaseSync} DatabaseSync
   */
  constructor(filePath, DatabaseSync) {
    this.filePath = filePath;
    this.kind = 'sqlite';
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    this.db = new DatabaseSync(filePath);
    // WAL переживает перезапуск и не блокирует чтения во время записи.
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 3000;');
    this.db.exec(SCHEMA);
  }

  insert(entry) {
    const statement = this.db.prepare(`
      INSERT INTO scores (id, mode, player, score, elapsed_sec, clean_dodges, hits, day, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    statement.run(
      entry.id,
      entry.mode,
      entry.player,
      entry.score,
      entry.elapsed_sec,
      entry.clean_dodges,
      entry.hits,
      entry.day,
      entry.created_at,
    );
  }

  top({ mode, day, limit }) {
    const query =
      day === null
        ? `SELECT * FROM scores WHERE mode = ? ORDER BY score DESC, created_at ASC LIMIT ?`
        : `SELECT * FROM scores WHERE mode = ? AND day = ? ORDER BY score DESC, created_at ASC LIMIT ?`;
    const statement = this.db.prepare(query);
    return day === null ? statement.all(mode, limit) : statement.all(mode, day, limit);
  }

  stats(mode) {
    const statement = this.db.prepare(
      `SELECT COUNT(*) AS games, COALESCE(MAX(score), 0) AS best, COALESCE(AVG(score), 0) AS average
       FROM scores WHERE mode = ?`,
    );
    const row = statement.get(mode);
    return {
      games: Number(row?.games ?? 0),
      best: Number(row?.best ?? 0),
      average: Math.round(Number(row?.average ?? 0)),
    };
  }
}

/**
 * Открыть хранилище: сначала пробуем SQLite, при неудаче — JSON.
 * @param {string} filePath
 * @returns {Promise<JsonStore|SqliteStore>}
 */
export async function openStore(filePath) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return new SqliteStore(filePath, DatabaseSync);
  } catch {
    return new JsonStore(filePath.replace(/\.db$/, '.json'));
  }
}

/**
 * Нормализовать запись перед сохранением.
 * @param {object} input
 * @returns {object}
 */
export function makeEntry(input) {
  return {
    id: randomUUID(),
    mode: input.mode,
    player: input.player,
    score: input.score,
    elapsed_sec: input.elapsedSec,
    clean_dodges: input.cleanDodges,
    hits: input.hits,
    day: input.day ?? null,
    created_at: new Date().toISOString(),
  };
}

/** Показать запись в формате, который ждёт клиент. */
export function toPublic(row) {
  return {
    player: row.player,
    score: Number(row.score),
    elapsedSec: Number(row.elapsed_sec ?? 0),
    cleanDodges: Number(row.clean_dodges ?? 0),
    hits: Number(row.hits ?? 0),
  };
}

export { JsonStore, SqliteStore };