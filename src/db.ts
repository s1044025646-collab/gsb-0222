import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DeckRow {
  id: number;
  name: string;
  created_at: string;
}

export interface CardRow {
  id: number;
  deck_id: number;
  front: string;
  back: string;
  /** 每次评分时面对的正反面内容快照（JSON: {front,back}）。 */
  content_snapshot: string;
  status: 'new' | 'learning' | 'paused';
  step: number;
  interval_days: number;
  ease_streak: number;
  /** 到期日 UTC YYYY-MM-DD；新卡为创建日。 */
  due: string;
  created_at: string;
}

export interface ReviewRow {
  id: number;
  card_id: number;
  reviewed_on: string;
  rating: 'again' | 'hard' | 'easy';
  interval_days: number;
  due_after: string;
  content_snapshot: string;
  created_at: string;
}

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

/** 手动事务（新版 node:sqlite 无 transaction() 辅助方法）。 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function migrate(db: DatabaseSync): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS decks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    front TEXT NOT NULL,
    back TEXT NOT NULL,
    content_snapshot TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('new','learning','paused')),
    step INTEGER NOT NULL DEFAULT 0,
    interval_days INTEGER NOT NULL DEFAULT 0,
    ease_streak INTEGER NOT NULL DEFAULT 0,
    due TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(deck_id, status, due);
  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    reviewed_on TEXT NOT NULL,
    rating TEXT NOT NULL CHECK (rating IN ('again','hard','easy')),
    interval_days INTEGER NOT NULL,
    due_after TEXT NOT NULL,
    content_snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (card_id, reviewed_on)
  );
  CREATE INDEX IF NOT EXISTS idx_reviews_card ON reviews(card_id, reviewed_on);
  `);
}
