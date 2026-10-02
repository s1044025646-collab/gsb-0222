import { DatabaseSync } from "node:sqlite";
import {
  CardRow,
  RATINGS,
  Rating,
  applyReview,
  createCard,
  createDeck,
  deckStats,
  getCard,
  listCards,
  listDecks,
  listReviews,
  queryQueue,
  requireCard,
  setCardStatus,
  updateCardContent,
} from "./db.js";
import {
  ApiError,
  addDays,
  diffDays,
  formatDate,
  parseDate,
  todayUtc,
} from "./dates.js";

/**
 * 间隔规则（确定、可手算；所有日期为 UTC 自然日）
 *
 * 新卡（从未复习过，interval=0）：
 *   forgot / hard / easy 之后间隔均为 1 天（新卡先让它明天再来）。
 *
 * 新卡首次复习为 easy 时，连续熟练计数预置为 1（间隔仍为 1 天），
 * 次日再熟练即进入阶梯第 1 档（3 天）；首次为 forgot/hard 则计数为 0。
 *
 * 老卡（至少复习过一次之后）：
 *   forgot：回退，间隔 = 1，连续熟练计数清零；
 *   hard：间隔 = 1，连续熟练计数清零（原地重来，保守起步）；
 *   easy：连续熟练，间隔按阶梯增长：
 *           第 1 次连续熟练（第 2 次复习即熟练）→ 3 天
 *           streak=2 → 7 天
 *           streak=3 → 14 天
 *           streak=4 → 30 天
 *           streak=5 → 60 天
 *           streak=6 → 120 天
 *           streak=7 → 240 天
 *           streak≥8 → 365 天（最大间隔）
 *
 * 下一次到期日 = 实际复习日（UTC）+ 间隔；逾期卡也一样，不会产生早于复习日的日期。
 * 同一张卡每个 UTC 自然日只能提交一次（重复提交返回 409 ALREADY_REVIEWED_TODAY），
 * 网络重试不会放大间隔。
 */
export const EASE_LADDER = [3, 7, 14, 30, 60, 120, 240, 365] as const;
export const MAX_INTERVAL_DAYS = 365;

/** 纯函数：根据卡片状态、自评和复习日计算（间隔、到期日、新连续计数）。 */
export function schedule(
  card: Pick<CardRow, "interval_days" | "ease_streak">,
  rating: Rating,
  reviewDay: Date,
): { interval: number; dueAfter: Date; easeStreak: number } {
  let interval: number;
  let easeStreak: number;
  if (card.interval_days === 0) {
    interval = 1;
    easeStreak = rating === "easy" ? 1 : 0;
  } else if (rating === "easy") {
    easeStreak = card.ease_streak + 1;
    interval = EASE_LADDER[Math.min(easeStreak - 1, EASE_LADDER.length - 1)]!;
  } else {
    interval = 1;
    easeStreak = 0;
  }
  interval = Math.min(interval, MAX_INTERVAL_DAYS);
  return { interval, dueAfter: addDays(reviewDay, interval), easeStreak };
}

function parseDay(s: string | undefined): Date {
  if (!s) return todayUtc();
  const d = parseDate(s);
  if (!d) throw new ApiError("INVALID_DATE", `非法日期: ${s}（要求 YYYY-MM-DD）`);
  return d!;
}

export class SrsService {
  constructor(private readonly db: DatabaseSync) {}

 createDeck(name: string): unknown {
    return createDeck(this.db, name, new Date());
  }

  listDecks() {
    return listDecks(this.db);
  }

  importCards(deckId: number, cards: Array<{ front: string; back: string }>, dayArg?: string) {
    const day = parseDay(dayArg);
    if (!Array.isArray(cards) || cards.length === 0) {
      throw new ApiError("INVALID_CARD", "导入列表为空，需要 front/back 数组");
    }
    const created: CardRow[] = [];
    for (const item of cards) {
      if (!item || typeof item.front !== "string" || typeof item.back !== "string") {
        throw new ApiError("INVALID_CARD", "每张卡都必须有字符串字段 front 与 back");
      }
      created.push(createCard(this.db, deckId, item.front, item.back, formatDate(day)));
    }
    return created;
  }

  listCards(deckId?: number, includeSuspended = false) {
    const id = deckId === undefined ? undefined : Number(deckId);
    if (deckId !== undefined && !Number.isInteger(id)) {
      throw new ApiError("INVALID_ID", "deckId 必须是整数");
    }
    return listCards(this.db, {
      deckId: id,
      status: includeSuspended ? undefined : "active",
    });
  }

  due(dayArg: string | undefined, deckId?: number) {
    const day = parseDay(dayArg);
    return queryQueue(this.db, formatDate(day), "due", deckId);
  }

  upcoming(dayArg: string | undefined, deckId?: number) {
    const day = parseDay(dayArg);
    return queryQueue(this.db, formatDate(day), "upcoming", deckId);
  }

  review(cardId: number, rating: string, dayArg?: string) {
    const id = Number(cardId);
    if (!Number.isInteger(id)) throw new ApiError("INVALID_ID", "cardId 必须是整数");
    if (!RATINGS.includes(rating as Rating)) {
      throw new ApiError(
        "INVALID_RATING",
        `自评必须是 ${RATINGS.join("/")} 之一，收到: ${String(rating)}`,
      );
    }
    const card = requireCard(this.db, id);
    const day = parseDay(dayArg);
    if (card.status === "suspended") {
      throw new ApiError("CARD_SUSPENDED", `卡片已暂停，请先恢复: #${id}`, 409);
    }
    const dayStr = formatDate(day);
    if (card.last_review_date !== null) {
      if (dayStr < card.last_review_date) {
        throw new ApiError(
          "DATE_BEFORE_LAST_REVIEW",
          `复习日 ${dayStr} 早于该卡上次复习日 ${card.last_review_date}`,
          422,
        );
      }
      if (dayStr === card.last_review_date) {
        throw new ApiError(
          "ALREADY_REVIEWED_TODAY",
          `卡片 #${id} 在 ${dayStr} 已提交过复习，每个 UTC 自然日限一次`,
          409,
        );
      }
    }
    const { interval, dueAfter, easeStreak } = schedule(card, rating as Rating, day);
    const review = applyReview(this.db, card, {
      reviewDay: dayStr,
      rating: rating as Rating,
      interval,
      easeStreak,
      dueAfter: formatDate(dueAfter),
      now: new Date(),
    });
    return { review, card: getCard(this.db, id) };
  }

  suspend(cardId: number) {
    const card = requireCard(this.db, Number(cardId));
    if (card.status === "suspended") {
      throw new ApiError("CARD_SUSPENDED", `卡片已处于暂停状态: #${card.id}`, 409);
    }
    setCardStatus(this.db, card.id, "suspended");
    return getCard(this.db, card.id);
  }

  resume(cardId: number) {
    const card = requireCard(this.db, Number(cardId));
    if (card.status === "active") {
      throw new ApiError("CARD_ACTIVE", `卡片未暂停，无需恢复: #${card.id}`, 409);
    }
    // 恢复只改状态：学习记录、间隔与到期日原样保留。
    setCardStatus(this.db, card.id, "active");
    return getCard(this.db, card.id);
  }

  editCard(cardId: number, front: string, back: string) {
    const card = requireCard(this.db, Number(cardId));
    if (typeof front !== "string" || typeof back !== "string") {
      throw new ApiError("INVALID_CARD", "front 与 back 必须是字符串");
    }
    return updateCardContent(this.db, card, front, back);
  }

  history(cardId?: number) {
    return listReviews(this.db, cardId === undefined ? undefined : Number(cardId));
  }

  stats(dayArg?: string) {
    return deckStats(this.db, formatDate(parseDay(dayArg)));
  }

  /** 逾期天数（0 表示今日到期或尚未到）；新卡当天导入视为当天到期，逾期为 0。 */
  static overdueDays(card: CardRow, day: Date): number {
    const due = parseDate(card.due_date)!;
    return Math.max(0, diffDays(due, day));
  }
}
