import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { ApiError, ReviewService } from '../src/service.js';
import type { DatabaseSync } from 'node:sqlite';

let dir: string;
let dbPath: string;
let db: DatabaseSync;
let svc: ReviewService;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'flashcard-'));
  dbPath = join(dir, 'test.db');
  db = openDatabase(dbPath);
  svc = new ReviewService(db);
});

after(() => {
  try {
    db.close();
  } catch {
    /* 重启测试中已关闭 */
  }
  rmSync(dir, { recursive: true, force: true });
});

test('建牌组、导入卡片、重复牌组名报错', () => {
  const deck = svc.createDeck('德语');
  assert.ok(deck.id > 0);
  assert.throws(() => svc.createDeck('德语'), (e: ApiError) => e.code === 'DECK_EXISTS');
  const cards = svc.importCards(deck.id, [
    { front: 'Hund', back: '狗' },
    { front: 'Katze', back: '猫' },
  ], '2024-05-01');
  assert.equal(cards.length, 2);
  assert.equal(cards[0].status, 'new');
  assert.equal(cards[0].due, '2024-05-01');
  assert.throws(
    () => svc.importCards(deck.id, [], '2024-05-01'),
    (e: ApiError) => e.code === 'INVALID_CARDS',
  );
});

test('到期队列只含 due<=当日 且排序稳定（due,id）', () => {
  const deck = svc.listDecks()[0];
  const [a, b] = svc.listCards(deck.id).map((c) => c.id);
  // a 在 05-01 评 easy -> due 05-03
  svc.submitReview(a, 'easy', '2024-05-01');
  // b 保持新卡 due 05-01
  let q = svc.dueQueue(deck.id, '2024-05-01').map((c) => c.id);
  assert.deepEqual(q, [b]);
  // 05-02 仍只有 b（逾期，仍在队列）
  q = svc.dueQueue(deck.id, '2024-05-02').map((c) => c.id);
  assert.deepEqual(q, [b]);
  // 05-03 a、b 都到期；b(due05-01) 排在 a(due05-03) 前
  q = svc.dueQueue(deck.id, '2024-05-03').map((c) => c.id);
  assert.deepEqual(q, [b, a]);
});

test('同日重复提交被拒，不放大间隔', () => {
  const deck = svc.listDecks()[0];
  const [a] = svc.listCards(deck.id).map((c) => c.id);
  const first = svc.submitReview(a, 'hard', '2024-05-03');
  const dueAfterFirst = first.card.due;
  assert.throws(
    () => svc.submitReview(a, 'easy', '2024-05-03'),
    (e: ApiError) => e.code === 'ALREADY_REVIEWED' && e.status === 409,
  );
  assert.equal(svc.getCard(a).due, dueAfterFirst);
  assert.equal(svc.cardHistory(a).filter((h) => h.reviewed_on === '2024-05-03').length, 1);
});

test('逾期卡复习不会产生早于复习日的到期', () => {
  const deck = svc.listDecks()[0];
  const [, b] = svc.listCards(deck.id).map((c) => c.id);
  // b 仍 due 05-01，在 05-10 复习
  const r = svc.submitReview(b, 'easy', '2024-05-10');
  assert.ok(r.card.due >= '2024-05-10');
  assert.equal(r.card.due, '2024-05-12'); // 新卡首次 easy：step1，间隔 2 天
});

test('暂停不进队列，恢复保留记录且逾期重置到恢复日', () => {
  const deck = svc.listDecks()[0];
  const [a] = svc.listCards(deck.id).map((c) => c.id);
  const beforePause = svc.getCard(a);
  svc.pauseCard(a);
  assert.throws(() => svc.pauseCard(a), (e: ApiError) => e.code === 'CARD_PAUSED');
  assert.throws(
    () => svc.submitReview(a, 'easy', '2024-05-20'),
    (e: ApiError) => e.code === 'CARD_PAUSED',
  );
  // 暂停期间任何日期都不在队列
  assert.equal(svc.dueQueue(deck.id, '2024-12-31').some((c) => c.id === a), false);
  const resumed = svc.resumeCard(a, '2024-05-20');
  // 记录保留
  assert.equal(resumed.step, beforePause.step);
  assert.equal(resumed.ease_streak, beforePause.ease_streak);
  // due 已逾期 -> 重置到恢复当天
  assert.equal(resumed.due, '2024-05-20');
  assert.ok(svc.dueQueue(deck.id, '2024-05-20').some((c) => c.id === a));
});

test('未来到期的卡恢复后沿用原到期日', () => {
  const deck = svc.createDeck('法语');
  const [card] = svc.importCards(deck.id, [{ front: 'eau', back: '水' }], '2024-06-01');
  const r = svc.submitReview(card.id, 'easy', '2024-06-01'); // due 06-03
  svc.pauseCard(card.id);
  const resumed = svc.resumeCard(card.id, '2024-06-02'); // 恢复日早于 due
  assert.equal(resumed.due, r.card.due);
  assert.equal(svc.dueQueue(deck.id, '2024-06-02').length, 0);
});

test('内容修改后历史保留当时快照', () => {
  const deck = svc.listDecks()[0];
  const [a] = svc.listCards(deck.id).map((c) => c.id);
  const hist = svc.cardHistory(a);
  assert.ok(hist.length > 0);
  svc.updateCard(a, { front: 'Hund（新）' });
  const snap = JSON.parse(hist[0].content_snapshot);
  assert.equal(snap.front, 'Hund');
  assert.equal(svc.getCard(a).front, 'Hund（新）');
});

test('非法日期与非法评分返回明确错误码', () => {
  const deck = svc.listDecks()[0];
  const [a] = svc.listCards(deck.id).map((c) => c.id);
  assert.throws(
    () => svc.dueQueue(deck.id, '2024-02-30'),
    (e: ApiError) => e.code === 'INVALID_DATE' || e.message.includes('非法日期'),
  );
  assert.throws(
    () => svc.submitReview(a, 'perfect', '2024-05-21'),
    (e: ApiError) => e.code === 'INVALID_RATING',
  );
  assert.throws(() => svc.getCard(999_999), (e: ApiError) => e.code === 'CARD_NOT_FOUND');
});

test('统计各档自评次数与到期数', () => {
  const deck = svc.createDeck('西语');
  const [x, y] = svc.importCards(deck.id, [
    { front: 'gato', back: '猫' },
    { front: 'perro', back: '狗' },
  ], '2024-07-01');
  svc.submitReview(x.id, 'easy', '2024-07-01');
  svc.submitReview(y.id, 'again', '2024-07-01');
  svc.submitReview(y.id, 'hard', '2024-07-02');
  const stats = svc.deckStats(deck.id);
  assert.equal(stats.ratings.easy >= 1, true);
  assert.equal(stats.ratings.again >= 1, true);
  assert.equal(stats.ratings.hard >= 1, true);
  assert.equal(stats.total, 2);
});

test('服务重启后到期结果一致（持久化）', () => {
  db.close();
  const db2 = openDatabase(dbPath);
  const svc2 = new ReviewService(db2);
  const deck = svc2.listDecks().find((d) => d.name === '德语')!;
  assert.ok(deck);
  const [a, b] = svc2.listCards(deck.id).map((c) => c.id);
  // 与重启前完全一致的队列
  const q = svc2.dueQueue(deck.id, '2024-05-20').map((c) => c.id);
  assert.deepEqual(q.sort(), [a, b].sort());
  // 历史仍在，且同日重复提交约束仍生效
  assert.throws(
    () => svc2.submitReview(a, 'easy', '2024-05-03'),
    (e: ApiError) => e.code === 'ALREADY_REVIEWED',
  );
  db2.close();
});
