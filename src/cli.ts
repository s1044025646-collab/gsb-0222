#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { openDatabase } from './db.js';
import { ReviewService } from './service.js';

const args = process.argv.slice(2);
const command = args.shift();

const dbPath = process.env.FLASHCARD_DB ?? 'data/flashcards.db';

function out(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function fail(message: string): never {
  console.error(`错误: ${message}`);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function requireArg(name: string): string {
  const value = arg(name);
  if (value === undefined) fail(`缺少参数 ${name}`);
  return value;
}

function parseCardsJson(path: string): { front: string; back: string }[] {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw);
  const cards = Array.isArray(parsed) ? parsed : parsed.cards;
  if (!Array.isArray(cards)) fail('导入文件应为数组或 {cards:[...]}');
  return cards;
}

const db = openDatabase(dbPath);
const service = new ReviewService(db);

try {
  switch (command) {
    case 'deck-create':
      out(service.createDeck(requireArg('--name')));
      break;
    case 'deck-list':
      out(service.listDecks());
      break;
    case 'deck-stats':
      out(service.deckStats(Number(requireArg('--deck'))));
      break;
    case 'import': {
      const deckId = Number(requireArg('--deck'));
      const file = requireArg('--file');
      out(service.importCards(deckId, parseCardsJson(file), arg('--date')));
      break;
    }
    case 'cards':
      out(service.listCards(Number(requireArg('--deck')), arg('--status')));
      break;
    case 'queue':
      out(service.dueQueue(Number(requireArg('--deck')), arg('--date')));
      break;
    case 'upcoming':
      out(service.upcoming(Number(requireArg('--deck')), arg('--date')));
      break;
    case 'review':
      out(
        service.submitReview(
          Number(requireArg('--card')),
          requireArg('--rating'),
          arg('--date'),
        ),
      );
      break;
    case 'pause':
      out(service.pauseCard(Number(requireArg('--card'))));
      break;
    case 'resume':
      out(service.resumeCard(Number(requireArg('--card')), arg('--date')));
      break;
    case 'history':
      out(service.cardHistory(Number(requireArg('--card'))));
      break;
    case 'export-history':
      out(service.exportHistory(Number(requireArg('--deck'))));
      break;
    default:
      printHelp();
  }
} catch (err) {
  fail((err as Error).message);
} finally {
  db.close();
}

function printHelp(): void {
  console.log(`闪卡复习 CLI（数据文件可用 FLASHCARD_DB 覆盖，默认 data/flashcards.db）

  deck-create --name <名称>
  deck-list
  deck-stats --deck <id>
  import --deck <id> --file <cards.json> [--date YYYY-MM-DD]
  cards --deck <id> [--status new|learning|paused]
  queue --deck <id> [--date YYYY-MM-DD]      今日(或指定日)到期队列
  upcoming --deck <id> [--date YYYY-MM-DD]   未到期列表
  review --card <id> --rating again|hard|easy [--date YYYY-MM-DD]
  pause --card <id>
  resume --card <id> [--date YYYY-MM-DD]
  history --card <id>
  export-history --deck <id>

日期统一为 UTC 自然日 YYYY-MM-DD；可用于演示与补测，不修改系统时间。`);
}
