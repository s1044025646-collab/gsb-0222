import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type CardRow } from "./db.js";
import { SrsService, EASE_LADDER, schedule } from "./srs.js";
import { parseDate, formatDate, ApiError } from "./dates.js";

function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "srs-test-"));
  const path = join(dir, "t.db");
  return {
    path,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows 上刚关闭的 SQLite 文件可能短暂被系统占用，临时目录残留不影响断言
      }
    },
  };
}

function newSvc(path: string): SrsService {
  return new SrsService(openDatabase(path));
}

function firstCard(svc: SrsService, deckId: number, day: string): CardRow {
  const cards = svc.importCards(deckId, [{ front: "a", back: "b" }], day) as CardRow[];
  return cards[0]!;
}

function newDeck(svc: SrsService): number {
  return (svc.createDeck(`d-${Math.random()}`) as { id: number }).id;
}

function expectApiError(fn: () => unknown, code: string): ApiError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ApiError, `期望 ApiError，实际 ${String(e)}`);
    assert.equal(e.code, code);
    return e;
  }
  throw new assert.AssertionError({ message: `期望抛出 ${code}，但未抛错` });
}

test("纯函数 schedule：新卡三档均为 1 天（含闰日）", () => {
  const fresh = { interval_days: 0, ease_streak: 0 };
  const day = parseDate("2024-02-28")!;
  for (const rating of ["forgot", "hard", "easy"] as const) {
    const r = schedule(fresh, rating, day);
    assert.equal(r.interval, 1);
    assert.equal(formatDate(r.dueAfter), "2024-02-29");
  }
});

test("连续熟练的手算阶梯 3,7,14,30,60,120,240,365，封顶 365", () => {
  assert.deepEqual([...EASE_LADDER], [3, 7, 14, 30, 60, 120, 240, 365]);
  const day = parseDate("2025-01-01")!;
  let card = { interval_days: 1, ease_streak: 0 };
  for (let i = 0; i < EASE_LADDER.length + 2; i++) {
    const r = schedule(card, "easy", day);
    assert.equal(r.interval, EASE_LADDER[Math.min(i, EASE_LADDER.length - 1)]);
    card = { interval_days: r.interval, ease_streak: r.easeStreak };
  }
  assert.equal(card.interval_days, 365);
});

test("忘记与勉强都回退到 1 天并清零熟练计数", () => {
  const day = parseDate("2025-05-10")!;
  for (const rating of ["forgot", "hard"] as const) {
    const r = schedule({ interval_days: 120, ease_streak: 6 }, rating, day);
    assert.equal(r.interval, 1);
    assert.equal(r.easeStreak, 0);
    assert.equal(formatDate(r.dueAfter), "2025-05-11");
  }
});

test("逾期卡复习不会产生早于复习日的到期日", () => {
  const { path, cleanup } = tempDb();
  const svc = newSvc(path);
  const card = firstCard(svc, newDeck(svc), "2025-01-31");
  svc.review(card.id, "easy", "2025-01-31"); // -> 02-01
  svc.review(card.id, "easy", "2025-02-01"); // 第2次熟练，阶梯档2 -> 7 -> 02-08
  svc.review(card.id, "easy", "2025-02-20"); // 逾期，第3次熟练 -> 14 -> 03-06
  const r = svc.review(card.id, "easy", "2025-03-06"); // 第4次熟练 -> 30 -> 04-05
  assert.equal((r.review as { due_after: string }).due_after, "2025-04-05");
  assert.equal((r.card as CardRow).due_date, "2025-04-05");
  cleanup();
});

test("间隔跨月按 UTC 自然日推进", () => {
  const { path, cleanup } = tempDb();
  const svc = newSvc(path);
  const card = firstCard(svc, newDeck(svc), "2024-01-31");
  svc.review(card.id, "easy", "2024-01-31"); // -> 02-01
  const r = svc.review(card.id, "easy", "2024-02-01"); // 第2次熟练 +7 -> 02-08
  assert.equal((r.review as { due_after: string }).due_after, "2024-02-08");
  const r2 = svc.review(card.id, "easy", "2024-02-08"); // 第3次熟练 +14 -> 02-22
  assert.equal((r2.review as { due_after: string }).due_after, "2024-02-22");
  cleanup();
});

test("同一天重复提交被拒绝且不放大间隔（含重开连接模拟重试）", () => {
  const { path, cleanup } = tempDb();
  const svc = newSvc(path);
  const card = firstCard(svc, newDeck(svc), "2025-03-01");
  svc.review(card.id, "easy", "2025-03-01"); // -> 03-02
  expectApiError(() => svc.review(card.id, "easy", "2025-03-01"), "ALREADY_REVIEWED_TODAY");
  const reopened = newSvc(path);
  expectApiError(() => reopened.review(card.id, "easy", "2025-03-01"), "ALREADY_REVIEWED_TODAY");
  const stored = reopened.listCards()[0]!;
  assert.equal(stored.due_date, "2025-03-02");
  assert.equal(stored.ease_streak, 1);
  assert.equal(reopened.history(card.id).length, 1);
  cleanup();
});

test("非法日期与不存在日期被拒绝", () => {
  const { path, cleanup } = tempDb();
  const svc = newSvc(path);
  const card = firstCard(svc, newDeck(svc), "2023-01-01");
  for (const bad of ["2023-13-01", "2023-02-29", "2023/01/01", "not-a-date", "2023-1-1"]) {
    expectApiError(() => svc.review(card.id, "easy", bad), "INVALID_DATE");
  }
  cleanup();
});

test("复习日早于上次复习日被拒绝", () => {
  const { path, cleanup } = tempDb();
  const svc = newSvc(path);
  const card = firstCard(svc, newDeck(svc), "2025-03-01");
  svc.review(card.id, "easy", "2025-03-02");
  expectApiError(() => svc.review(card.id, "forgot", "2025-03-01"), "DATE_BEFORE_LAST_REVIEW");
  cleanup();
});

test("队列稳定排序：due_date 升序、同日 id 升序；暂停卡不入队", () => {
  const { path, cleanup } = tempDb();
  const svc = newSvc(path);
  const deckId = newDeck(svc);
  const cards = svc.importCards(
    deckId,
    [
      { front: "a", back: "1" },
      { front: "b", back: "2" },
      { front: "c", back: "3" },
    ],
    "2025-03-01",
  ) as CardRow[];
  svc.suspend(cards[2]!.id);
  assert.deepEqual(svc.due("2025-03-01").map((c) => c.id), [cards[0]!.id, cards[1]!.id]);
  assert.equal(svc.upcoming("2025-03-01").length, 0);
  cleanup();
});

test("暂停后恢复保留学习记录与到期日", () => {
  const { path, cleanup } = tempDb();
  const svc = newSvc(path);
  const card = firstCard(svc, newDeck(svc), "2025-03-01");
  svc.review(card.id, "easy", "2025-03-01");
  svc.suspend(card.id);
  assert.equal(svc.due("2025-03-05").filter((c) => c.id === card.id).length, 0);
  const resumed = svc.resume(card.id) as CardRow;
  assert.equal(resumed.interval_days, 1);
  assert.equal(resumed.ease_streak, 1);
  assert.equal(resumed.due_date, "2025-03-02");
  assert.equal(svc.history(card.id).length, 1);
  cleanup();
});

test("修改卡片内容不影响历史快照", () => {
  const { path, cleanup } = tempDb();
  const svc = newSvc(path);
  const deckId = newDeck(svc);
  const card = (svc.importCards(deckId, [{ front: "旧正面", back: "旧背面" }], "2025-03-01") as CardRow[])[0]!;
  svc.review(card.id, "hard", "2025-03-01");
  svc.editCard(card.id, "新正面", "新背面");
  const h = svc.history(card.id)[0]!;
  assert.equal(h.front_snapshot, "旧正面");
  assert.equal(h.back_snapshot, "旧背面");
  cleanup();
});

test("服务重启后到期结果一致（持久化）", () => {
  const { path, cleanup } = tempDb();
  const svc = newSvc(path);
  const deckId = newDeck(svc);
  const cards = svc.importCards(
    deckId,
    [
      { front: "a", back: "1" },
      { front: "b", back: "2" },
    ],
    "2025-03-01",
  ) as CardRow[];
  svc.review(cards[0]!.id, "easy", "2025-03-01");
  svc.review(cards[1]!.id, "forgot", "2025-03-01");
  const svc2 = newSvc(path);
  assert.deepEqual(
    svc2.due("2025-03-02").map((c) => c.id).sort((a, b) => a - b),
    cards.map((c) => c.id),
  );
  const stats = svc2.stats("2025-03-02")[0]!;
  assert.equal(stats.ratings.easy, 1);
  assert.equal(stats.ratings.forgot, 1);
  assert.equal(stats.due, 2);
  cleanup();
});

test("非法自评与暂停卡复习被拒绝", () => {
  const { path, cleanup } = tempDb();
  const svc = newSvc(path);
  const card = firstCard(svc, newDeck(svc), "2025-03-01");
  expectApiError(() => svc.review(card.id, "maybe", "2025-03-01"), "INVALID_RATING");
  svc.suspend(card.id);
  expectApiError(() => svc.review(card.id, "easy", "2025-03-02"), "CARD_SUSPENDED");
  cleanup();
});
