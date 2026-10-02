import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ApiError } from "./dates.js";

export type Rating = "forgot" | "hard" | "easy";
export const RATINGS: readonly Rating[] = ["forgot", "hard", "easy"];

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
  status: "active" | "suspended";
  created_at: string;
  last_review_date: string | null;
  interval_days: number;
  ease_streak: number;
  due_date: string;
}

export interface ReviewRow {
  id: number;
  card_id: number;
  review_date: string;
  rating: Rating;
  interval_days: number;
  due_after: string;
  front_snapshot: string;
  back_snapshot: string;
  created_at: string;
}

let dbCounter = 0;

/** 打开（必要时创建并迁移）SQLite 数据库。 */
export function openDatabase(path: string): DatabaseSync {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
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
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
      created_at TEXT NOT NULL,
      last_review_date TEXT,
      interval_days INTEGER NOT NULL DEFAULT 0,
      ease_streak INTEGER NOT NULL DEFAULT 0,
      due_date TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cards_queue ON cards(status, due_date);
    CREATE INDEX IF NOT EXISTS idx_cards_deck ON cards(deck_id);
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      review_date TEXT NOT NULL,
      rating TEXT NOT NULL CHECK (rating IN ('forgot','hard','easy')),
      interval_days INTEGER NOT NULL,
      due_after TEXT NOT NULL,
      front_snapshot TEXT NOT NULL,
      back_snapshot TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (card_id, review_date)
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_card ON reviews(card_id, review_date);
  `);
}

export function createDeck(db: DatabaseSync, name: string, now: Date): DeckRow {
  if (!name || !name.trim()) throw new ApiError("INVALID_NAME", "牌组名称不能为空");
  try {
    const r = db
      .prepare("INSERT INTO decks (name, created_at) VALUES (?, ?)")
      .run(name.trim(), now.toISOString());
    return getDeck(db, Number(r.lastInsertRowid))!;
  } catch (e) {
    if (String((e as Error).message).includes("UNIQUE")) {
      throw new ApiError("DECK_EXISTS", `牌组已存在: ${name}`, 409);
    }
    throw e;
  }
}

export function getDeck(db: DatabaseSync, id: number): DeckRow | null {
  return (db.prepare("SELECT * FROM decks WHERE id = ?").get(id) as unknown as DeckRow | undefined) ?? null;
}

export function requireDeck(db: DatabaseSync, id: number): DeckRow {
  const deck = getDeck(db, id);
  if (!deck) throw new ApiError("DECK_NOT_FOUND", `牌组不存在: #${id}`, 404);
  return deck;
}

export function listDecks(db: DatabaseSync): DeckRow[] {
  return db.prepare("SELECT * FROM decks ORDER BY id").all() as unknown as DeckRow[];
}

export function createCard(
  db: DatabaseSync,
  deckId: number,
  front: string,
  back: string,
  createdDay: string,
): CardRow {
  requireDeck(db, deckId);
  if (!front || !front.trim()) throw new ApiError("INVALID_CARD", "卡片正面不能为空");
  if (!back || !back.trim()) throw new ApiError("INVALID_CARD", "卡片背面不能为空");
  const r = db
    .prepare(
      `INSERT INTO cards (deck_id, front, back, status, created_at, due_date)
       VALUES (?, ?, ?, 'active', ?, ?)`,
    )
    .run(deckId, front.trim(), back.trim(), new Date().toISOString(), createdDay);
  return getCard(db, Number(r.lastInsertRowid))!;
}

export function getCard(db: DatabaseSync, id: number): CardRow | null {
  return (db.prepare("SELECT * FROM cards WHERE id = ?").get(id) as unknown as CardRow | undefined) ?? null;
}

export function requireCard(db: DatabaseSync, id: number): CardRow {
  const card = getCard(db, id);
  if (!card) throw new ApiError("CARD_NOT_FOUND", `卡片不存在: #${id}`, 404);
  return card;
}

export function listCards(
  db: DatabaseSync,
  opts: { deckId?: number; status?: "active" | "suspended" } = {},
): CardRow[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (opts.deckId !== undefined) {
    where.push("deck_id = ?");
    params.push(opts.deckId);
  }
  if (opts.status) {
    where.push("status = ?");
    params.push(opts.status);
  }
  const sql =
    "SELECT * FROM cards" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY deck_id, id";
  return db.prepare(sql).all(...params) as unknown as CardRow[];
}

/** 稳定排序的队列：先到期在前，同日按卡片 id。可选择只看到期或未到期。 */
export function queryQueue(
  db: DatabaseSync,
  day: string,
  kind: "due" | "upcoming",
  deckId?: number,
): CardRow[] {
  const where = ["status = 'active'", kind === "due" ? "due_date <= ?" : "due_date > ?"];
  const params: Array<string | number> = [day];
  if (deckId !== undefined) {
    where.push("deck_id = ?");
    params.push(deckId);
  }
  return db
    .prepare(
      `SELECT * FROM cards WHERE ${where.join(" AND ")} ORDER BY due_date ASC, id ASC`,
    )
    .all(...params) as unknown as CardRow[];
}

export function listReviews(db: DatabaseSync, cardId?: number): ReviewRow[] {
  if (cardId !== undefined) {
    return db
      .prepare("SELECT * FROM reviews WHERE card_id = ? ORDER BY review_date, id")
      .all(cardId) as unknown as ReviewRow[];
  }
  return db.prepare("SELECT * FROM reviews ORDER BY card_id, review_date, id").all() as unknown as ReviewRow[];
}

/**
 * 在一个事务内写入复习事件并更新卡片状态，
 * 保证历史记录与新的 due_date / interval 始终一致。
 */
export function applyReview(
  db: DatabaseSync,
  card: CardRow,
  p: {
    reviewDay: string;
    rating: Rating;
    interval: number;
    easeStreak: number;
    dueAfter: string;
    now: Date;
  },
): ReviewRow {
  const txName = `review_${dbCounter++}`;
  db.exec(`SAVEPOINT ${txName}`);
  try {
    const r = db
      .prepare(
        `INSERT INTO reviews
           (card_id, review_date, rating, interval_days, due_after, front_snapshot, back_snapshot, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        card.id,
        p.reviewDay,
        p.rating,
        p.interval,
        p.dueAfter,
        card.front,
        card.back,
        p.now.toISOString(),
      );
    const newStreak = p.easeStreak;
    db.prepare(
      `UPDATE cards SET last_review_date = ?, interval_days = ?, ease_streak = ?, due_date = ?
       WHERE id = ?`,
    ).run(p.reviewDay, p.interval, newStreak, p.dueAfter, card.id);
    db.exec(`RELEASE SAVEPOINT ${txName}`);
    return db
      .prepare("SELECT * FROM reviews WHERE id = ?")
      .get(Number(r.lastInsertRowid)) as unknown as ReviewRow;
  } catch (e) {
    db.exec(`ROLLBACK TO SAVEPOINT ${txName}`);
    db.exec(`RELEASE SAVEPOINT ${txName}`);
    throw e;
  }
}

export function setCardStatus(db: DatabaseSync, cardId: number, status: "active" | "suspended"): void {
  db.prepare("UPDATE cards SET status = ? WHERE id = ?").run(status, cardId);
}

export function updateCardContent(
  db: DatabaseSync,
  card: CardRow,
  front: string,
  back: string,
): CardRow {
  if (!front.trim() || !back.trim()) throw new ApiError("INVALID_CARD", "卡片正反面不能为空");
  db.prepare("UPDATE cards SET front = ?, back = ? WHERE id = ?").run(
    front.trim(),
    back.trim(),
    card.id,
  );
  return getCard(db, card.id)!;
}

/** 各牌组：总数、暂停数、到期数（相对给定日期）、三档自评累计次数。 */
export function deckStats(db: DatabaseSync, day: string) {
  const decks = db
    .prepare(
      `SELECT d.id, d.name,
         COUNT(c.id) AS total,
         COALESCE(SUM(CASE WHEN c.status='suspended' THEN 1 ELSE 0 END),0) AS suspended,
         COALESCE(SUM(CASE WHEN c.status='active' AND c.due_date <= ? THEN 1 ELSE 0 END),0) AS due
       FROM decks d LEFT JOIN cards c ON c.deck_id = d.id
       GROUP BY d.id ORDER BY d.id`,
    )
    .all(day) as unknown as Array<{ id: number; name: string; total: number; suspended: number; due: number }>;
  const ratings = db
    .prepare(
      `SELECT c.deck_id AS deck_id, r.rating AS rating, COUNT(*) AS n
       FROM reviews r JOIN cards c ON c.id = r.card_id
       GROUP BY c.deck_id, r.rating`,
    )
    .all() as unknown as Array<{ deck_id: number; rating: Rating; n: number }>;
  return decks.map((d) => {
    const count = (rating: Rating) =>
      ratings.find((x) => x.deck_id === d.id && x.rating === rating)?.n ?? 0;
    return {
      ...d,
      ratings: { forgot: count("forgot"), hard: count("hard"), easy: count("easy") },
    };
  });
}
