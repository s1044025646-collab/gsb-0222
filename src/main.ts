import { openDatabase } from './db.js';
import { createApp, listen } from './server.js';

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? '0');
  const host = process.env.HOST ?? '127.0.0.1';
  const dbPath = process.env.FLASHCARD_DB ?? 'data/flashcards.db';
  const db = openDatabase(dbPath);
  const server = createApp(db);
  const actualPort = await listen(server, port, host);
  console.log(`闪卡复习服务已启动: http://${host}:${actualPort}`);
  console.log(`数据文件: ${dbPath}`);
  console.log('健康检查: GET /health');

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
