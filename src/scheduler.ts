/**
 * 确定性间隔调度器。
 *
 * 日期一律使用 UTC 自然日，字符串格式 YYYY-MM-DD。
 *
 * 间隔档位（斐波那契式增长，单位：天）：
 *   index:  0   1   2   3   4   5   6   7    8    9    10   11 ...
 *   days:   1   2   3   5   8  13  21  34   55   89  144  233 377
 * 当档位天数超过 MAX_INTERVAL_DAYS(365) 时一律取 365，因此后续档位恒为 365。
 *
 * 三档自评对“档位”的影响：
 *   again（忘记）       : 新卡仍在学习步 -> 明天(1天)；否则档位 -2（最低回到档0）
 *   hard（勉强记住）    : 档位 +1
 *   easy（熟练）        : 档位 +2
 * 新卡首次评分前 step=0、interval=0（表示“今天到期的新卡”）。
 * 新卡首次 again/hard 都给 1 天（避免一紧张就把新卡越推越远），easy 给 2 天。
 */

export type Rating = 'again' | 'hard' | 'easy';
export const RATINGS: Rating[] = ['again', 'hard', 'easy'];

export const MAX_INTERVAL_DAYS = 365;

/** 生成第 n 档的间隔天数（已按最大间隔封顶）。 */
export function intervalDaysAtStep(step: number): number {
  if (step <= 0) return 1;
  let prev = 1;
  let curr = 2;
  for (let i = 1; i < step; i++) {
    const next = prev + curr;
    prev = curr;
    curr = next;
    if (curr >= MAX_INTERVAL_DAYS) return MAX_INTERVAL_DAYS;
  }
  return Math.min(curr, MAX_INTERVAL_DAYS);
}

export interface CardScheduleState {
  /** 当前已达到的档位（新卡为 0）。 */
  step: number;
  /** 已连续熟练(easy)次数，仅用于展示，不参与计算。 */
  easeStreak: number;
}

export interface ScheduleResult {
  step: number;
  intervalDays: number;
  /** 下一次到期日（UTC 自然日 YYYY-MM-DD）。 */
  due: string;
  easeStreak: number;
}

/**
 * 根据自评计算新的调度状态。
 * @param state 复习前的卡片调度状态
 * @param rating 三档自评
 * @param reviewedOn 实际复习日（UTC YYYY-MM-DD），间隔从该日起算
 */
export function nextSchedule(
  state: CardScheduleState,
  rating: Rating,
  reviewedOn: string,
): ScheduleResult {
  assertUtcDate(reviewedOn);
  const isNew = state.step === 0 && state.easeStreak === 0;

  let step: number;
  let easeStreak: number;

  if (rating === 'again') {
    step = isNew ? 0 : Math.max(0, state.step - 2);
    easeStreak = 0;
  } else if (rating === 'hard') {
    step = isNew ? 0 : state.step + 1;
    easeStreak = 0;
  } else {
    // easy
    step = state.step + (isNew ? 1 : 2);
    easeStreak = state.easeStreak + 1;
  }

  const intervalDays = intervalDaysAtStep(step);
  const due = addUtcDays(reviewedOn, intervalDays);
  return { step, intervalDays, due, easeStreak };
}

/** 校验并规范化 UTC 日期字符串，非法日期抛出 Error（供上层映射错误码）。 */
export function assertUtcDate(value: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`非法日期: ${String(value)}，应为 YYYY-MM-DD`);
  }
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) {
    throw new Error(`非法日期: ${value}（该月不存在这一天）`);
  }
  return value;
}

export function isValidUtcDate(value: string): boolean {
  try {
    assertUtcDate(value);
    return true;
  } catch {
    return false;
  }
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 返回某 UTC 日期加 n 天后的 YYYY-MM-DD（自动处理跨月与闰日）。 */
export function addUtcDays(date: string, days: number): string {
  assertUtcDate(date);
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const dt = new Date(t);
  return toUtcDate(dt);
}

/** 比较两个 UTC 日期：a<b 为负，a==b 为 0，a>b 为正。 */
export function compareUtcDate(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function toUtcDate(dt: Date): string {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 当前 UTC 自然日（服务运行时使用；演示/测试可显式传日期）。 */
export function todayUtc(): string {
  return toUtcDate(new Date());
}
