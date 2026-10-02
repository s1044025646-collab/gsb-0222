/**
 * 所有日期一律按 UTC 自然日处理，对外统一使用 'YYYY-MM-DD' 字符串。
 */

/** 以毫秒表示的一个 UTC 自然日。 */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** 将任意 Date 规整为当天 UTC 00:00 的 Date。 */
export function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** 今天的 UTC 自然日（演示日期未指定时使用）。 */
export function todayUtc(now: Date = new Date()): Date {
  return utcMidnight(now);
}

/** 两个 UTC 自然日相差的天数（b - a），可为负。 */
export function diffDays(a: Date, b: Date): number {
  return Math.round((utcMidnight(b).getTime() - utcMidnight(a).getTime()) / DAY_MS);
}

/** 在某个 UTC 自然日上加减天数。 */
export function addDays(d: Date, days: number): Date {
  return new Date(utcMidnight(d).getTime() + days * DAY_MS);
}

/** 格式化为 'YYYY-MM-DD'（UTC）。 */
export function formatDate(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 解析 'YYYY-MM-DD'。非法或不存在的日期（如 2023-02-29、2023-13-01）
 * 一律返回 null，由上层转为 INVALID_DATE。
 */
export function parseDate(s: string): Date | null {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (formatDate(date) !== s) return null; // 拒绝进位，如 2023-02-29
  return date;
}

/** 解析日期；非法时抛出带错误码的异常。 */
export function requireDate(s: string | undefined, field: string, fallback?: Date): Date {
  if (s === undefined || s === "") {
    if (fallback) return fallback;
    throw new ApiError("INVALID_DATE", `缺少日期参数: ${field}`);
  }
  const d = parseDate(s);
  if (!d) throw new ApiError("INVALID_DATE", `非法日期: ${s}（要求 YYYY-MM-DD 且真实存在）`);
  return d;
}

/** 统一业务错误：携带稳定错误码。 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
