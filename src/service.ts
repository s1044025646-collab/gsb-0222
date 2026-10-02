import type { DatabaseSync } from 'node:sqlite';
import {
  type CardRow,
  type DeckRow,
  type ReviewRow,
  withTransaction,
} from './db.js';
import { queryAll, queryOne, run } from './sql.js';
import {
  type Rating,
  RATINGS,
  assertUtcDate,
  compareUtcDate,
  isValidUtcDate,
  nextSchedule,
  todayUtc,
} from './scheduler.js';

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export interface CardInput {
  front: string;
  back: string;
}

export class ReviewService {
  constructor(private db: DatabaseSync) {}

  createDeck(name: string): DeckRow {
    name = str(name, 'name');
    if (queryOne<{ id: number }>(this.db, 'SELECT id FROM decks WHERE name = ?', [name])) {
      throw new ApiError('DECK_EXISTS', `牌组已存在: ${name}`, 409);
    }
    const info = run(this.db, 'INSERT INTO decks (name, created_at) VALUES (?, ?)', [
      name,
      new Date().toISOString(),
    ]);
    return this.getDeck(Number(info.lastInsertRowid));
  }

  listDecks(): DeckRow[] {
    return queryAll<DeckRow>(this.db, 'SELECT * FROM decks ORDER BY id');
  }

  getDeck(id: number): DeckRow {
    const row = queryOne<DeckRow>(this.db, 'SELECT * FROM decks WHERE id = ?', [id]);
    if (!row) throw new ApiError('DECK_NOT_FOUND', `牌组不存在: ${id}`, 404);
    return row;
  }

  importCards(deckId: number, cards: CardInput[], onDate?: string): CardRow[] {
    this.getDeck(deckId);
    if (!Array.isArray(cards) || cards.length === 0) {
      throw new ApiError('INVALID_CARDS', 'cards 必须是非空数组');
    }
    const due = onDate ? assertUtcDate(onDate) : todayUtc();
    const now = new Date().toISOString();
    const created: CardRow[] = [];
    withTransaction(this.db, () => {
      for (const c of cards) {
        const front = str(c?.front, 'front');
        const back = str(c?.back, 'back');
        const info = run(
          this.db,
          `INSERT INTO cards
           (deck_id, front, back, content_snapshot, status, step, interval_days, ease_streak, due, created_at)
           VALUES (?, ?, ?, ?, 'new', 0, 0, 0, ?, ?)`,
          [deckId, front, back, JSON.stringify({ front, back }), due, now],
        );
        created.push(this.getCard(Number(info.lastInsertRowid)));
      }
    });
    return created;
  }

  getCard(id: number): CardRow {
    const row = queryOne<CardRow>(this.db, 'SELECT * FROM cards WHERE id = ?', [id]);
    if (!row) throw new ApiError('CARD_NOT_FOUND', `卡片不存在: ${id}`, 404);
    return row;
  }

  /** 修改卡片内容；历史评价保留各自当时的 content_snapshot 不变。 */
  updateCard(id: number, patch: Partial<CardInput>): CardRow {
    const card = this.getCard(id);
    const front = patch.front !== undefined ? str(patch.front, 'front') : card.front;
    const back = patch.back !== undefined ? str(patch.back, 'back') : card.back;
    run(this.db, 'UPDATE cards SET front = ?, back = ?, content_snapshot = ? WHERE id = ?', [
      front,
      back,
      JSON.stringify({ front, back }),
      id,
    ]);
    return this.getCard(id);
  }

  listCards(deckId: number, status?: string): CardRow[] {
    this.getDeck(deckId);
    let sql = 'SELECT * FROM cards WHERE deck_id = ?';
    const params: unknown[] = [deckId];
    if (status) {
      if (!['new', 'learning', 'paused'].includes(status)) {
        throw new ApiError('INVALID_STATUS', `非法状态: ${status}`);
      }
      sql += ' AND status = ?';
      params.push(status);
    }
    sql += ' ORDER BY id';
    return queryAll<CardRow>(this.db, sql, params);
  }

  /** 到期队列：非暂停且 due <= onDate。稳定排序 due ASC, id ASC。 */
  dueQueue(deckId: number, onDate?: string): CardRow[] {
    this.getDeck(deckId);
    const day = onDate ? assertUtcDate(onDate) : todayUtc();
    return queryAll<CardRow>(
      this.db,
      `SELECT * FROM cards
       WHERE deck_id = ? AND status != 'paused' AND due <= ?
       ORDER BY due ASC, id ASC`,
      [deckId, day],
    );
  }

  /** 未到期列表：非暂停且 due > onDate。 */
  upcoming(deckId: number, onDate?: string): CardRow[] {
    this.getDeck(deckId);
    const day = onDate ? assertUtcDate(onDate) : todayUtc();
    return queryAll<CardRow>(
      this.db,
      `SELECT * FROM cards
       WHERE deck_id = ? AND status != 'paused' AND due > ?
       ORDER BY due ASC, id ASC`,
      [deckId, day],
    );
  }

  /**
   * 提交复习。同一 UTC 自然日重复提交返回 409，不重复放大间隔。
   * 复习事件与新到期日期在同一个事务中写入。
   */
  submitReview(
    cardId: number,
    rating: unknown,
    reviewedOn?: string,
  ): { card: CardRow; review: ReviewRow } {
    const day = reviewedOn ? assertUtcDate(reviewedOn) : todayUtc();
    if (!RATINGS.includes(rating as Rating)) {
      throw new ApiError(
        'INVALID_RATING',
        `rating 必须是 again / hard / easy，收到: ${String(rating)}`,
      );
    }
    const card = this.getCard(cardId);
    if (card.status === 'paused') {
      throw new ApiError('CARD_PAUSED', `卡片已暂停，无法复习: ${cardId}`, 409);
    }
    if (
      queryOne<{ id: number }>(
        this.db,
        'SELECT id FROM reviews WHERE card_id = ? AND reviewed_on = ?',
        [cardId, day],
      )
    ) {
      throw new ApiError(
        'ALREADY_REVIEWED',
        `卡片 ${cardId} 在 ${day} 已提交过复习，同一 UTC 自然日只能评分一次`,
        409,
      );
    }

    const result = nextSchedule(
      { step: card.step, easeStreak: card.ease_streak },
      rating as Rating,
      day,
    );

    const reviewId = withTransaction(this.db, () => {
      const info = run(
        this.db,
        `INSERT INTO reviews
         (card_id, reviewed_on, rating, interval_days, due_after, content_snapshot, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          cardId,
          day,
          rating,
          result.intervalDays,
          result.due,
          card.content_snapshot,
          new Date().toISOString(),
        ],
      );
      run(
        this.db,
        `UPDATE cards
         SET status = 'learning', step = ?, interval_days = ?, ease_streak = ?, due = ?
         WHERE id = ?`,
        [result.step, result.intervalDays, result.easeStreak, result.due, cardId],
      );
      return Number(info.lastInsertRowid);
    });
    return { card: this.getCard(cardId), review: this.getReview(reviewId) };
  }

  getReview(id: number): ReviewRow {
    const row = queryOne<ReviewRow>(this.db, 'SELECT * FROM reviews WHERE id = ?', [id]);
    if (!row) throw new ApiError('REVIEW_NOT_FOUND', `复习记录不存在: ${id}`, 404);
    return row;
  }

  cardHistory(cardId: number): ReviewRow[] {
    this.getCard(cardId);
    return queryAll<ReviewRow>(
      this.db,
      'SELECT * FROM reviews WHERE card_id = ? ORDER BY reviewed_on ASC, id ASC',
      [cardId],
    );
  }

  /** 暂停：不进入到期队列；保留全部学习状态与历史。 */
  pauseCard(cardId: number): CardRow {
    const card = this.getCard(cardId);
    if (card.status === 'paused') {
      throw new ApiError('CARD_PAUSED', `卡片已处于暂停状态: ${cardId}`, 409);
    }
    run(this.db, "UPDATE cards SET status = 'paused' WHERE id = ?", [cardId]);
    return this.getCard(cardId);
  }

  /**
   * 恢复：保留学习记录。原到期日仍在未来则沿用；若暂停期间已逾期，
   * 则到期日重置为恢复当天（不会产生早于恢复日的到期日）。
   */
  resumeCard(cardId: number, onDate?: string): CardRow {
    const day = onDate ? assertUtcDate(onDate) : todayUtc();
    const card = this.getCard(cardId);
    if (card.status !== 'paused') {
      throw new ApiError('CARD_NOT_PAUSED', `卡片未暂停: ${cardId}`, 409);
    }
    const newDue = compareUtcDate(card.due, day) < 0 ? day : card.due;
    const newStatus = card.step === 0 && card.interval_days === 0 ? 'new' : 'learning';
    run(this.db, 'UPDATE cards SET status = ?, due = ? WHERE id = ?', [
      newStatus,
      newDue,
      cardId,
    ]);
    return this.getCard(cardId);
  }

  deckStats(deckId: number): {
    deck: DeckRow;
    total: number;
    due: number;
    newCards: number;
    learning: number;
    paused: number;
    ratings: { again: number; hard: number; easy: number };
  } {
    const deck = this.getDeck(deckId);
    const day = todayUtc();
    const counts = queryAll<{ status: string; n: number }>(
      this.db,
      'SELECT status, COUNT(*) AS n FROM cards WHERE deck_id = ? GROUP BY status',
      [deckId],
    );
    const byStatus = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
    const due =
      queryOne<{ n: number }>(
        this.db,
        `SELECT COUNT(*) AS n FROM cards
         WHERE deck_id = ? AND status != 'paused' AND due <= ?`,
        [deckId, day],
      )?.n ?? 0;
    const ratings = queryAll<{ rating: Rating; n: number }>(
      this.db,
      `SELECT rating, COUNT(*) AS n FROM reviews r
       JOIN cards c ON c.id = r.card_id
       WHERE c.deck_id = ? GROUP BY rating`,
      [deckId],
    );
    const ratingCount = (r: Rating) => ratings.find((x) => x.rating === r)?.n ?? 0;
    return {
      deck,
      total: byStatus('new') + byStatus('learning') + byStatus('paused'),
      due,
      newCards: byStatus('new'),
      learning: byStatus('learning'),
      paused: byStatus('paused'),
      ratings: {
        again: ratingCount('again'),
        hard: ratingCount('hard'),
        easy: ratingCount('easy'),
      },
    };
  }

  /** 导出牌组全部复习历史（含当时内容快照）。 */
  exportHistory(deckId: number): { deck: DeckRow; reviews: ReviewRow[] } {
    const deck = this.getDeck(deckId);
    const reviews = queryAll<ReviewRow>(
      this.db,
      `SELECT r.* FROM reviews r
       JOIN cards c ON c.id = r.card_id
       WHERE c.deck_id = ?
       ORDER BY r.reviewed_on ASC, r.id ASC`,
      [deckId],
    );
    return { deck, reviews };
  }
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError('INVALID_FIELD', `字段 ${field} 必须是非空字符串`);
  }
  return value.trim();
}

export function parseDateParam(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !isValidUtcDate(value)) {
    throw new ApiError('INVALID_DATE', `非法日期: ${String(value)}，应为 YYYY-MM-DD`);
  }
  return value;
}
