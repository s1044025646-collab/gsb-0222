import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { pathToFileURL } from "node:url";
import { openDatabase } from "./db.js";
import { SrsService } from "./srs.js";
import { ApiError } from "./dates.js";
import { runDemo } from "./demo.js";

export interface AppContext {
  service: SrsService;
}

interface Route {
  method: string;
  pattern: RegExp;
  handler: (ctx: AppContext, req: IncomingMessage, res: ServerResponse, groups: RegExpExecArray) => Promise<void> | void;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError("INVALID_JSON", "请求体不是合法 JSON");
  }
}

/** 查询参数 date 优先；也可用请求头 X-Demo-Date 指定演示日期。 */
function demoDate(req: IncomingMessage, url: URL): string | undefined {
  return url.searchParams.get("date") ?? req.headers["x-demo-date"]?.toString() ?? undefined;
}

const routes: Route[] = [
  {
    method: "POST",
    pattern: /^\/api\/decks$/,
    handler: async (ctx, req, res) => {
      const body = await readJson(req);
      send(res, 201, ctx.service.createDeck(String(body.name ?? "")));
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/decks$/,
    handler: (ctx, _req, res) => send(res, 200, ctx.service.listDecks()),
  },
  {
    method: "POST",
    pattern: /^\/api\/decks\/(\d+)\/cards$/,
    handler: async (ctx, req, res, g) => {
      const url = new URL(req.url!, "http://x");
      const body = await readJson(req);
      const cards = Array.isArray(body) ? body : body.cards;
      send(res, 201, ctx.service.importCards(Number(g[1]!), cards, demoDate(req, url)));
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/cards$/,
    handler: (ctx, req, res) => {
      const url = new URL(req.url!, "http://x");
      const deckId = url.searchParams.get("deckId");
      const includeSuspended = url.searchParams.get("includeSuspended") === "1";
      send(res, 200, ctx.service.listCards(deckId === null ? undefined : Number(deckId), includeSuspended));
    },
  },
  {
    method: "PATCH",
    pattern: /^\/api\/cards\/(\d+)$/,
    handler: async (ctx, req, res, g) => {
      const body = await readJson(req);
      send(res, 200, ctx.service.editCard(Number(g[1]!), String(body.front ?? ""), String(body.back ?? "")));
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/queue\/(due|upcoming)$/,
    handler: (ctx, req, res, g) => {
      const url = new URL(req.url!, "http://x");
      const deckId = url.searchParams.get("deckId");
      const result =
        g[1] === "due"
          ? ctx.service.due(demoDate(req, url), deckId === null ? undefined : Number(deckId))
          : ctx.service.upcoming(demoDate(req, url), deckId === null ? undefined : Number(deckId));
      send(res, 200, result);
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/cards\/(\d+)\/reviews$/,
    handler: async (ctx, req, res, g) => {
      const url = new URL(req.url!, "http://x");
      const body = await readJson(req);
      send(
        res,
        201,
        ctx.service.review(Number(g[1]!), String(body.rating ?? ""), demoDate(req, url)),
      );
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/cards\/(\d+)\/(suspend|resume)$/,
    handler: (ctx, _req, res, g) => {
      send(res, 200, g[2] === "suspend" ? ctx.service.suspend(Number(g[1]!)) : ctx.service.resume(Number(g[1]!)));
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/reviews$/,
    handler: (ctx, req, res) => {
      const url = new URL(req.url!, "http://x");
      const cardId = url.searchParams.get("cardId");
      send(res, 200, ctx.service.history(cardId === null ? undefined : Number(cardId)));
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/stats$/,
    handler: (ctx, req, res) => {
      const url = new URL(req.url!, "http://x");
      send(res, 200, ctx.service.stats(demoDate(req, url)));
    },
  },
];

export function createApp(dbPath: string): { server: Server; ctx: AppContext } {
  const db = openDatabase(dbPath);
  const ctx: AppContext = { service: new SrsService(db) };
  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === "GET" && req.url === "/") {
          send(res, 200, {
            name: "flashcards-srs",
            endpoints: routes.map((r) => `${r.method} ${r.pattern.source.replace(/[\\^$]/g, "")}`),
          });
          return;
        }
        const pathname = new URL(req.url!, "http://x").pathname;
        for (const route of routes) {
          if (route.method !== req.method) continue;
          const m = route.pattern.exec(pathname);
          if (m) {
            await route.handler(ctx, req, res, m);
            return;
          }
        }
        send(res, 404, { error: { code: "NOT_FOUND", message: `无此路由: ${req.method} ${pathname}` } });
      } catch (e) {
        if (e instanceof ApiError) {
          send(res, e.status, { error: { code: e.code, message: e.message } });
        } else {
          send(res, 500, { error: { code: "INTERNAL", message: (e as Error).message } });
        }
      }
    })();
  });
  return { server, ctx };
}

/** 请求系统分配一个空闲 TCP 端口（端口 0）。 */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("无法获取空闲端口"));
      }
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const portArg = args.indexOf("--port");
  const dbArg = args.indexOf("--db");
  const requestedPort = portArg >= 0 ? Number(args[portArg + 1]) : undefined;
  const dbPath = dbArg >= 0 ? args[dbArg + 1]! : "data/flashcards.db";
  const port = requestedPort ?? (await pickFreePort());
  const { server } = createApp(dbPath);
  server.listen(port, "127.0.0.1", () => {
    console.log(`闪卡复习服务已启动: http://127.0.0.1:${port}`);
    console.log(`数据库: ${dbPath}`);
    console.log("演示日期: 请求加 ?date=YYYY-MM-DD 或头 X-Demo-Date");
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath === import.meta.url) {
  void main();
}

export { runDemo };
