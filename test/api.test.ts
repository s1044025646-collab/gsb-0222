import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createApp, listen } from '../src/server.js';
import type { DatabaseSync } from 'node:sqlite';
import type { Server } from 'node:http';

let db: DatabaseSync;
let server: Server;
let base: string;

before(async () => {
  db = openDatabase(':memory:');
  server = createApp(db);
  const port = await listen(server, 0);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
});

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; payload: any }> {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json();
  return { status: res.status, payload };
}

test('完整 HTTP 流程与错误码', async () => {
  const health = await call('GET', '/health');
  assert.equal(health.status, 200);

  const created = await call('POST', '/api/decks', { name: 'API 牌组' });
  assert.equal(created.status, 200);
  const deckId = created.payload.data.id;

  const dup = await call('POST', '/api/decks', { name: 'API 牌组' });
  assert.equal(dup.status, 409);
  assert.equal(dup.payload.error.code, 'DECK_EXISTS');

  const imp = await call('POST', `/api/decks/${deckId}/cards/import`, {
    date: '2024-08-01',
    cards: [
      { front: '一', back: '1' },
      { front: '二', back: '2' },
    ],
  });
  assert.equal(imp.status, 200);
  assert.equal(imp.payload.data.length, 2);

  const badBody = await call('POST', `/api/decks/${deckId}/cards/import`, {
    date: '2024-08-01',
    cards: [],
  });
  assert.equal(badBody.status, 400);

  const queue = await call('GET', `/api/decks/${deckId}/queue?date=2024-08-01`);
  assert.equal(queue.payload.data.length, 2);

  const cardId = queue.payload.data[0].id;
  const review = await call('POST', `/api/cards/${cardId}/reviews`, {
    rating: 'easy',
    date: '2024-08-01',
  });
  assert.equal(review.status, 200);
  assert.equal(review.payload.data.card.due, '2024-08-03');

  const again = await call('POST', `/api/cards/${cardId}/reviews`, {
    rating: 'easy',
    date: '2024-08-01',
  });
  assert.equal(again.status, 409);
  assert.equal(again.payload.error.code, 'ALREADY_REVIEWED');

  const badDate = await call('GET', `/api/decks/${deckId}/queue?date=2024-02-30`);
  assert.equal(badDate.status, 400);
  assert.equal(badDate.payload.error.code, 'INVALID_DATE');

  const pause = await call('POST', `/api/cards/${cardId}/pause`);
  assert.equal(pause.status, 200);
  const queuePaused = await call('GET', `/api/decks/${deckId}/queue?date=2024-08-10`);
  assert.equal(queuePaused.payload.data.some((c: any) => c.id === cardId), false);

  const resume = await call('POST', `/api/cards/${cardId}/resume?date=2024-08-10`);
  assert.equal(resume.status, 200);
  assert.equal(resume.payload.data.due, '2024-08-10');

  const stats = await call('GET', `/api/decks/${deckId}/stats`);
  assert.equal(stats.status, 200);
  assert.equal(typeof stats.payload.data.ratings.easy, 'number');

  const hist = await call('GET', `/api/cards/${cardId}/history`);
  assert.equal(hist.payload.data.length, 1);

  const notFound = await call('GET', '/api/cards/999999');
  assert.equal(notFound.status, 404);
  assert.equal(notFound.payload.error.code, 'CARD_NOT_FOUND');

  const noRoute = await call('GET', '/nope');
  assert.equal(noRoute.status, 404);
  assert.equal(noRoute.payload.error.code, 'NOT_FOUND');
});
