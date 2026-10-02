import type { DatabaseSync } from 'node:sqlite';

/** 轻量查询辅助：收敛 node:sqlite 行类型。 */
export function queryAll<T>(
  db: DatabaseSync,
  sql: string,
  params: unknown[] = [],
): T[] {
  return db.prepare(sql).all(...(params as never[])) as unknown as T[];
}

export function queryOne<T>(
  db: DatabaseSync,
  sql: string,
  params: unknown[] = [],
): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as unknown as T | undefined;
}

export function run(
  db: DatabaseSync,
  sql: string,
  params: unknown[] = [],
): { lastInsertRowid: number | bigint; changes: number | bigint } {
  return db.prepare(sql).run(...(params as never[]));
}
