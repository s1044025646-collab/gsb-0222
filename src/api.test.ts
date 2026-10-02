import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "./server.js";

const dir = mkdtempSync(join(tmpdir(), "srs-api-"));
const dbPath = join(dir, "api.db");
const app = createApp(dbPath);

const server = app.server.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

after(async () => {
  server.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows 上 SQLite 句柄可能短暂延迟释放，忽略临时目录清理失败
  }
});

async function api(method: string, path: string, body?: unknown, date?: string) {
  const res = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(date ? { "X-Demo-Date": date } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

test("HTTP 全流程：建牌组→导入→队列→复习→重复 409→历史→统计", async () => {
  const created = await api("POST", "/api/decks", { name: "法语" });
  assert.equal(created.status, 201);
  const deckId = created.json.id as number;

  const dup = await api("POST", "/api/decks", { name: "法语" });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, "DECK_EXISTS");

  const imported = await api(
    "POST",
    `/api/decks/${deckId}/cards?date=2025-04-30`,
    [{ front: "bonjour", back: "你好" }],
  );
  assert.equal(imported.status, 201);
  const cardId = imported.json[0].id as number;

  const due = await api("GET", "/api/queue/due?date=2025-04-30");
  assert.equal(due.json.length, 1);

  const r1 = await api("POST", `/api/cards/${cardId}/reviews`, { rating: "easy" }, "2025-04-30");
  assert.equal(r1.status, 201);
  assert.equal(r1.json.review.due_after, "2025-05-01"); // 跨月

  const r2 = await api("POST", `/api/cards/${cardId}/reviews`, { rating: "easy" }, "2025-04-30");
  assert.equal(r2.status, 409);
  assert.equal(r2.json.error.code, "ALREADY_REVIEWED_TODAY");

  const bad = await api("POST", `/api/cards/${cardId}/reviews`, { rating: "nope" }, "2025-05-01");
  assert.equal(bad.json.error.code, "INVALID_RATING");

  const badDate = await api("GET", "/api/queue/due?date=2025-02-30");
  assert.equal(badDate.status, 400);
  assert.equal(badDate.json.error.code, "INVALID_DATE");

  const hist = await api("GET", `/api/reviews?cardId=${cardId}`);
  assert.equal(hist.json.length, 1);
  assert.equal(hist.json[0].front_snapshot, "bonjour");

  const stats = await api("GET", "/api/stats?date=2025-05-01");
  assert.equal(stats.json[0].due, 1);
  assert.equal(stats.json[0].ratings.easy, 1);
});

test("暂停卡不能复习，恢复后可复习且记录保留", async () => {
  const created = await api("POST", "/api/decks", { name: "西语" });
  const deckId = created.json.id as number;
  const imported = await api("POST", `/api/decks/${deckId}/cards`, [
    { front: "hola", back: "你好" },
  ], "2025-06-01");
  const cardId = imported.json[0].id as number;

  await api("POST", `/api/cards/${cardId}/reviews`, { rating: "hard" }, "2025-06-01");
  assert.equal((await api("POST", `/api/cards/${cardId}/suspend`)).status, 200);
  const blocked = await api("POST", `/api/cards/${cardId}/reviews`, { rating: "easy" }, "2025-06-02");
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error.code, "CARD_SUSPENDED");
  assert.equal((await api("POST", `/api/cards/${cardId}/resume`)).status, 200);
  const hist = await api("GET", `/api/reviews?cardId=${cardId}`);
  assert.equal(hist.json.length, 1);
});

test("未知路由返回 404，错误体含 code", async () => {
  const r = await api("GET", "/api/nope");
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, "NOT_FOUND");
});
