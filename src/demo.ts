/**
 * 端到端虚构日期演示（不依赖真实时间、不改系统时间）。
 * 运行: npm run demo
 */
import { openDatabase } from './db.js';
import { ReviewService } from './service.js';
import { intervalDaysAtStep } from './scheduler.js';

const db = openDatabase(':memory:');
const svc = new ReviewService(db);

function line(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function queue(deckId: number, date: string): void {
  const rows = svc.dueQueue(deckId, date);
  console.log(
    `[${date}] 到期 ${rows.length} 张:`,
    rows.map((c) => `#${c.id}(${c.front},due=${c.due},step=${c.step})`).join(' ') ||
      '(空)',
  );
}

function rate(cardId: number, rating: 'again' | 'hard' | 'easy', date: string): void {
  const { card, review } = svc.submitReview(cardId, rating, date);
  console.log(
    `[${date}] #${cardId} 评 ${rating.padEnd(5)} -> 间隔 ${review.interval_days} 天, 下次到期 ${review.due_after}, step=${card.step}`,
  );
}

const deck = svc.createDeck('日语 N5 演示');

line('间隔档位表（斐波那契，封顶 365 天）');
const seq = Array.from({ length: 14 }, (_, i) => intervalDaysAtStep(i));
console.log('step:', Array.from({ length: 14 }, (_, i) => i).join('  '));
console.log('天数:', seq.join('  '));

line('2024-02-28 导入 4 张新卡（新卡 due=导入日）');
const cards = svc.importCards(
  deck.id,
  [
    { front: '犬', back: '狗' },
    { front: '猫', back: '猫' },
    { front: '鳥', back: '鸟' },
    { front: '水', back: '水' },
  ],
  '2024-02-28',
);
const [c1, c2, c3, c4] = cards.map((c) => c.id);

line('Day 1：验证闰日与首次评分');
queue(deck.id, '2024-02-28');
rate(c1, 'easy', '2024-02-28'); // 新卡 easy -> step1, 2 天 -> 2024-03-01
rate(c2, 'hard', '2024-02-28'); // 新卡 hard -> step0, 1 天 -> 2024-02-29(闰日)
rate(c3, 'again', '2024-02-28'); // 新卡 again -> 1 天 -> 2024-02-29

line('Day 2（闰日 2024-02-29）');
queue(deck.id, '2024-02-29'); // c2,c3,c4 到期；c1 到期日为 03-01

line('模拟“忘记后回退”：c3 先练熟再遗忘');
rate(c3, 'easy', '2024-02-29'); // step2 -> 3 天 -> 2024-03-03
rate(c3, 'easy', '2024-03-02'); // 逾期补记(03-03 前一天) -> step3,5天 -> 03-07
rate(c3, 'easy', '2024-03-07'); // step5 -> 13 天 -> 2024-03-20
line('   2024-03-20 当天忘记(again)：step 5 -> 3，间隔从 13 天退回 5 天');
rate(c3, 'again', '2024-03-20'); // step 5-2=3 -> 5 天 -> 2024-03-25

line('模拟“逾期卡片”：c4 一直不复习，直到 2024-03-10');
queue(deck.id, '2024-03-10'); // c4(due 02-28, 逾期) 与 c1(due 03-01, 逾期)
rate(c4, 'hard', '2024-03-10'); // 新卡 hard -> 1 天 -> 2024-03-11（不早于复习日之后）

line('模拟“连续熟练延长 + 最大间隔”：c1 持续 easy');
let day = '2024-03-01';
for (let i = 0; i < 9; i++) {
  const dueNow = svc.dueQueue(deck.id, day).some((c) => c.id === c1);
  if (!dueNow) break;
  rate(c1, 'easy', day);
  day = svc.getCard(c1).due; // 直接跳到下一次到期日复习
}
console.log('   c1 最终:', {
  step: svc.getCard(c1).step,
  interval: svc.getCard(c1).interval_days,
  due: svc.getCard(c1).due,
  easeStreak: svc.getCard(c1).ease_streak,
});

line('模拟“暂停 / 恢复”：暂停 c2');
console.log(svc.pauseCard(c2));
queue(deck.id, '2024-03-11'); // c2 不进队列
console.log('在 2024-03-20 恢复 c2（其 due=2024-02-29 已逾期 -> 重置为恢复当天）:');
console.log(svc.resumeCard(c2, '2024-03-20'));
queue(deck.id, '2024-03-20'); // c2 立即在队

line('同日重复提交限制');
try {
  svc.submitReview(c2, 'easy', '2024-03-20');
  svc.submitReview(c2, 'easy', '2024-03-20'); // 重试放大间隔?
} catch (err) {
  console.log('第二次提交被拒绝:', (err as Error).message);
}
console.log('c2 到期日仍为:', svc.getCard(c2).due, '（未被第二次提交放大）');

line('牌组统计（按当前 UTC 日计 due）');
console.log(JSON.stringify(svc.deckStats(deck.id), null, 2));

line('导出 c3 的复习历史（含当时内容快照）');
console.log(JSON.stringify(svc.cardHistory(c3), null, 2));

line('修改 c3 内容后，历史快照保留旧内容');
svc.updateCard(c3, { front: '鳥（改）', back: '小鸟' });
const hist = svc.cardHistory(c3);
console.log('最近一条历史快照:', hist[hist.length - 1].content_snapshot);
console.log('当前卡片内容:', svc.getCard(c3).front, '/', svc.getCard(c3).back);

db.close();
console.log('\n演示结束。');
