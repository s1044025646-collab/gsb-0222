import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { ApiError, ReviewService, parseDateParam } from './service.js';

interface RequestContext {
  service: ReviewService;
  body: unknown;
  query: URLSearchParams;
}

type Handler = (ctx: RequestContext, ids: Record<string, string>) => Promise<unknown> | unknown;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' +
      path.replace(/:([a-zA-Z]+)/g, (_, key) => {
        keys.push(key);
        return '([^/]+)';
      }) +
      '$',
  );
  return { method, pattern, keys, handler };
}

const routes: Route[] = [
  route('GET', '/health', () => ({ ok: true })),
  route('POST', '/api/decks', (ctx) =>
    ctx.service.createDeck((ctx.body as { name?: string })?.name as string)),
  route('GET', '/api/decks', (ctx) => ctx.service.listDecks()),
  route('GET', '/api/decks/:id', (ctx, ids) =>
    ctx.service.getDeck(idNum(ids.id!))),
  route('GET', '/api/decks/:id/stats', (ctx, ids) =>
    ctx.service.deckStats(idNum(ids.id!))),
  route('GET', '/api/decks/:id/history', (ctx, ids) =>
    ctx.service.exportHistory(idNum(ids.id!))),
  route('POST', '/api/decks/:id/cards/import', (ctx, ids) =>
    ctx.service.importCards(
      idNum(ids.id!),
      (ctx.body as { cards?: unknown }).cards as never,
      parseDateParam((ctx.body as { date?: string })?.date),
    )),
  route('GET', '/api/decks/:id/cards', (ctx, ids) =>
    ctx.service.listCards(
      idNum(ids.id!),
      ctx.query.get('status') ?? undefined,
    )),
  route('GET', '/api/decks/:id/queue', (ctx, ids) =>
    ctx.service.dueQueue(idNum(ids.id!), parseDateParam(ctx.query.get('date')))),
  route('GET', '/api/decks/:id/upcoming', (ctx, ids) =>
    ctx.service.upcoming(idNum(ids.id!), parseDateParam(ctx.query.get('date')))),
  route('GET', '/api/cards/:id', (ctx, ids) =>
    ctx.service.getCard(idNum(ids.id!))),
  route('PATCH', '/api/cards/:id', (ctx, ids) =>
    ctx.service.updateCard(idNum(ids.id!), ctx.body as never)),
  route('GET', '/api/cards/:id/history', (ctx, ids) =>
    ctx.service.cardHistory(idNum(ids.id!))),
  route('POST', '/api/cards/:id/reviews', (ctx, ids) => {
    const b = ctx.body as { rating?: unknown; date?: string };
    return ctx.service.submitReview(
      idNum(ids.id!),
      b.rating,
      parseDateParam(b.date),
    );
  }),
  route('POST', '/api/cards/:id/pause', (ctx, ids) =>
    ctx.service.pauseCard(idNum(ids.id!))),
  route('POST', '/api/cards/:id/resume', (ctx, ids) =>
    ctx.service.resumeCard(idNum(ids.id!), parseDateParam(ctx.query.get('date')))),
];

function idNum(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ApiError('INVALID_ID', `非法 ID: ${value}`);
  }
  return n;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_048_576) reject(new ApiError('BODY_TOO_LARGE', '请求体超过 1MB', 413));
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ApiError('INVALID_JSON', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function createApp(db: DatabaseSync): Server {
  const service = new ReviewService(db);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let body: unknown = {};
      if (req.method && ['POST', 'PATCH', 'PUT'].includes(req.method)) {
        body = await readBody(req);
      }
      const matched = routes.find(
        (r) => r.method === req.method && r.pattern.test(url.pathname),
      );
      if (!matched) {
        return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '路由不存在' } });
      }
      const match = url.pathname.match(matched.pattern)!;
      const ids: Record<string, string> = {};
      matched.keys.forEach((key, i) => (ids[key] = decodeURIComponent(match[i + 1])));
      const data = await matched.handler(
        { service, body, query: url.searchParams },
        ids,
      );
      sendJson(res, 200, { data });
    } catch (err) {
      if (err instanceof ApiError) {
        return sendJson(res, err.status, {
          error: { code: err.code, message: err.message },
        });
      }
      sendJson(res, 500, {
        error: { code: 'INTERNAL', message: (err as Error).message },
      });
    }
  });
  return server;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** 端口为 0 或未指定时，由操作系统分配空闲端口。 */
export function listen(server: Server, port: number, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address() as AddressInfo;
      resolve(addr.port);
    });
  });
}
