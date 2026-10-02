import { rmSync } from "node:fs";
import { openDatabase } from "./db.js";
import { SrsService } from "./srs.js";

function brief(cards: Array<{ id: number; front: string; due_date: string }>): string {
  if (cards.length === 0) return "（空）";
  return cards.map((c) => `#${c.id} ${c.front}[到期 ${c.due_date}]`).join("；");
}

/** 端到端虚构日期演示：逾期、遗忘回退、连续熟练、跨月/闰日、暂停恢复。 */
export function runDemo(dbPath: string): void {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    // 文件不存在即可
  }
  const db = openDatabase(dbPath);
  const svc = new SrsService(db);
  console.log("=== 闪卡间隔复习 · 虚构日期演示（UTC 自然日）===\n");

  const deck = svc.createDeck("日语 N5") as { id: number };
  const cards = svc.importCards(
    deck.id,
    [
      { front: "犬 (いぬ)", back: "狗" },
      { front: "猫 (ねこ)", back: "猫" },
      { front: "鳥 (とり)", back: "鸟" },
    ],
    "2024-02-28",
  );
  const [c1, c2, c3] = cards as Array<{ id: number }>;
  if (!c1 || !c2 || !c3) throw new Error("演示需要 3 张卡片");
  console.log("2024-02-28 导入 3 张新卡，新卡导入即视为当天到期。");

  const show = (day: string) => {
    console.log(`\n--- ${day} 队列 ---`);
    console.log("到期  :", brief(svc.due(day)));
    console.log("未到期:", brief(svc.upcoming(day)));
  };

  show("2024-02-28");
  // c1 熟练：新卡 -> 间隔 1，2024-02-29 到期（闰日）
  svc.review(c1.id, "easy", "2024-02-28");
  // c2 忘记：新卡 -> 间隔 1，2024-02-29 到期
  svc.review(c2.id, "forgot", "2024-02-28");
  // 同日重复提交 c1（模拟网络重试）
  try {
    svc.review(c1.id, "easy", "2024-02-28");
  } catch (e) {
    console.log(`\n重复提交被拒绝: ${(e as Error).message}`);
  }

  show("2024-02-29");
  // c1 第 2 次连续熟练（阶梯第 2 档）-> 7 天 -> 2024-03-07（跨月）
  svc.review(c1.id, "easy", "2024-02-29");
  // c2 勉强记住 -> 回退为 1 天 -> 2024-03-01
  svc.review(c2.id, "hard", "2024-02-29");

  show("2024-03-01");
  // c2 忘记 -> 仍然 1 天 -> 2024-03-02
  svc.review(c2.id, "forgot", "2024-03-01");
  // c3 暂停：不进入任何队列，学习记录为空也保留
  svc.suspend(c3.id);
  console.log(`暂停 #${c3.id}：后续到期队列中看不到它。`);

  show("2024-03-02");
  // c2 勉强 -> 1 天 -> 2024-03-03
  svc.review(c2.id, "hard", "2024-03-02");

  show("2024-03-03");
  // c1 当前应到日为 2024-03-07；03-03 时它仍是未到期卡
  // 恢复 c3：到期日仍是导入日 2024-02-28，表现为逾期，立即出现在队列
  svc.resume(c3.id);
  console.log(`恢复 #${c3.id}：记录与到期日保留，作为逾期卡重新入队。`);

  show("2024-03-04");
  // 逾期卡复习：熟练（新卡首次）-> 复习日 +1 = 2024-03-05，不会早于复习日
  svc.review(c3.id, "easy", "2024-03-04");
  console.log("\n逾期的 #3 在 2024-03-04 复习后，新到期日为 2024-03-05（复习日+1，不追溯）。");
  show("2024-03-07");
  // c1 当天熟练（第 3 次连续熟练，阶梯第 3 档）-> 14 天 -> 2024-03-21
  svc.review(c1.id, "easy", "2024-03-07");
  console.log("#1 在 2024-03-07 熟练后，新到期日为 2024-03-21（+14 天）。");

  console.log("\n--- #1 犬 的复习历史（含当时内容快照）---");
  for (const r of svc.history(c1.id)) {
    console.log(
      `${r.review_date} 自评=${r.rating} 间隔=${r.interval_days}天 下次=${r.due_after} 正面当时="${r.front_snapshot}"`,
    );
  }

  console.log("\n--- 牌组统计（以 2024-03-05 计）---");
  console.log(JSON.stringify(svc.stats("2024-03-05"), null, 2));
  console.log(`\n演示数据库已写入: ${dbPath}`);
  console.log("可重启服务后执行: node dist/cli.js queue due --date 2024-03-05");
  db.close();
}
