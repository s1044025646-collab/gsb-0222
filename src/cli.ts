#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { openDatabase } from "./db.js";
import { SrsService } from "./srs.js";
import { runDemo } from "./demo.js";
import { parseCsvFile } from "./csv.js";
import { ApiError } from "./dates.js";
import { createApp, pickFreePort } from "./server.js";

function usage(): void {
  console.log(`闪卡间隔复习 CLI

用法:
  flashcards serve [--port 端口] [--db 路径]      启动 HTTP API（默认自动选空闲端口）
  flashcards deck new <名称> [--db 路径]
  flashcards deck list [--db 路径]
  flashcards card import <牌组id> <文件.json|.csv> [--date YYYY-MM-DD] [--db 路径]
  flashcards card list [--deck 牌组id] [--all] [--db 路径]
  flashcards queue due|upcoming [--date YYYY-MM-DD] [--deck 牌组id] [--db 路径]
  flashcards review <卡片id> forgot|hard|easy [--date YYYY-MM-DD] [--db 路径]
  flashcards card suspend|resume <卡片id> [--db 路径]
  flashcards card edit <卡片id> --front 文本 --back 文本 [--db 路径]
  flashcards history [卡片id] [--db 路径]
  flashcards stats [--date YYYY-MM-DD] [--db 路径]
  flashcards demo                                运行虚构日期端到端演示

日期一律为 UTC 自然日；省略 --date 时使用今天（UTC）。
JSON 导入格式: [{ "front": "...", "back": "..." }]
CSV 导入格式: 表头 front,back`);
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function printJson(x: unknown): void {
  console.log(JSON.stringify(x, null, 2));
}

function loadCardsFile(path: string): Array<{ front: string; back: string }> {
  if (path.toLowerCase().endsWith(".csv")) return parseCsvFile(path);
  const data = JSON.parse(readFileSync(path, "utf-8"));
  if (!Array.isArray(data)) throw new ApiError("INVALID_JSON", "JSON 导入文件必须是数组");
  return data as Array<{ front: string; back: string }>;
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const globalDb = extractOption(rawArgs, "--db");
  const args = rawArgs;
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    usage();
    return;
  }
  const dbPath = globalDb ?? "data/flashcards.db";
  const cmd = args.shift()!;

  if (cmd === "demo") {
    runDemo(dbPath);
    return;
  }

  if (cmd === "serve") {
    const port = Number(option(args, "--port") ?? (await pickFreePort()));
    const { server } = createApp(dbPath);
    server.listen(port, "127.0.0.1", () => {
      console.log(`闪卡复习服务已启动: http://127.0.0.1:${port}（数据库 ${dbPath}）`);
    });
    return;
  }

  const db = openDatabase(dbPath);
  const svc = new SrsService(db);
  try {
    switch (cmd) {
      case "deck": {
        const sub = args.shift();
        if (sub === "new") printJson(svc.createDeck(args[0] ?? ""));
        else if (sub === "list") printJson(svc.listDecks());
        else throw new ApiError("USAGE", "子命令: deck new|list");
        break;
      }
      case "card": {
        const sub = args.shift();
        if (sub === "import") {
          const [deckIdStr, file] = args;
          if (!deckIdStr || !file) throw new ApiError("USAGE", "用法: card import <牌组id> <文件>");
          printJson(svc.importCards(Number(deckIdStr), loadCardsFile(file), option(args, "--date")));
        } else if (sub === "list") {
          const deckOpt = option(args, "--deck");
          printJson(svc.listCards(deckOpt === undefined ? undefined : Number(deckOpt), args.includes("--all")));
        } else if (sub === "suspend") {
          printJson(svc.suspend(Number(args[0]!)));
        } else if (sub === "resume") {
          printJson(svc.resume(Number(args[0]!)));
        } else if (sub === "edit") {
          const id = Number(args[0]!);
          const front = option(args, "--front");
          const back = option(args, "--back");
          if (!front || !back) throw new ApiError("USAGE", "需要 --front 与 --back");
          printJson(svc.editCard(id, front, back));
        } else {
          throw new ApiError("USAGE", "子命令: card import|list|suspend|resume|edit");
        }
        break;
      }
      case "queue": {
        const kind = args.shift();
        const deck = option(args, "--deck");
        const deckId = deck === undefined ? undefined : Number(deck);
        if (kind === "due") printJson(svc.due(option(args, "--date"), deckId));
        else if (kind === "upcoming") printJson(svc.upcoming(option(args, "--date"), deckId));
        else throw new ApiError("USAGE", "子命令: queue due|upcoming");
        break;
      }
      case "review": {
        const [cardId, rating] = args;
        if (!cardId || !rating) throw new ApiError("USAGE", "用法: review <卡片id> forgot|hard|easy");
        printJson(svc.review(Number(cardId), rating, option(args, "--date")));
        break;
      }
      case "history": {
        printJson(svc.history(args[0] === undefined ? undefined : Number(args[0])));
        break;
      }
      case "stats": {
        printJson(svc.stats(option(args, "--date")));
        break;
      }
      default:
        throw new ApiError("USAGE", `未知命令: ${cmd}`);
    }
  } finally {
    db.close();
  }
}

/** 取出 `--name value` 形式的全局选项（位置无关），并从数组中移除。 */
function extractOption(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

main().catch((e: unknown) => {
  if (e instanceof ApiError) {
    console.error(`错误 [${e.code}] ${e.message}`);
  } else {
    console.error("错误:", (e as Error).message);
  }
  process.exitCode = 1;
});
