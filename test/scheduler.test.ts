import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addUtcDays,
  intervalDaysAtStep,
  isValidUtcDate,
  nextSchedule,
} from '../src/scheduler.js';

test('间隔档位是手算的斐波那契序列并在 365 封顶', () => {
  const expected = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 365, 365];
  expected.forEach((days, step) => {
    assert.equal(intervalDaysAtStep(step), days, `step=${step}`);
  });
});

test('新卡首次评分：again/hard=1天，easy=2天', () => {
  assert.deepEqual(
    pick(nextSchedule({ step: 0, easeStreak: 0 }, 'again', '2024-03-10')),
    { step: 0, intervalDays: 1, due: '2024-03-11', easeStreak: 0 },
  );
  assert.deepEqual(
    pick(nextSchedule({ step: 0, easeStreak: 0 }, 'hard', '2024-03-10')),
    { step: 0, intervalDays: 1, due: '2024-03-11', easeStreak: 0 },
  );
  assert.deepEqual(
    pick(nextSchedule({ step: 0, easeStreak: 0 }, 'easy', '2024-03-10')),
    { step: 1, intervalDays: 2, due: '2024-03-12', easeStreak: 1 },
  );
});

test('连续熟练：每档 +2，间隔按序列放大', () => {
  let s = { step: 0, easeStreak: 0 };
  let r = nextSchedule(s, 'easy', '2024-01-01'); // step1,2天
  assert.equal(r.intervalDays, 2);
  s = { step: r.step, easeStreak: r.easeStreak };
  r = nextSchedule(s, 'easy', r.due); // step3,5天
  assert.equal(r.intervalDays, 5);
  s = { step: r.step, easeStreak: r.easeStreak };
  r = nextSchedule(s, 'easy', r.due); // step5,13天
  assert.equal(r.intervalDays, 13);
});

test('忘记回退 2 档，最低回到档0', () => {
  const r1 = nextSchedule({ step: 4, easeStreak: 3 }, 'again', '2024-03-11');
  assert.equal(r1.step, 2);
  assert.equal(r1.intervalDays, 3);
  assert.equal(r1.easeStreak, 0);
  const r2 = nextSchedule({ step: 1, easeStreak: 0 }, 'again', '2024-03-11');
  assert.equal(r2.step, 0);
  assert.equal(r2.intervalDays, 1);
});

test('hard 只进 1 档并清零熟练连击', () => {
  const r = nextSchedule({ step: 4, easeStreak: 3 }, 'hard', '2024-03-11');
  assert.equal(r.step, 5);
  assert.equal(r.intervalDays, 13);
  assert.equal(r.easeStreak, 0);
});

test('日期跨月与闰日计算', () => {
  assert.equal(addUtcDays('2024-02-28', 1), '2024-02-29'); // 2024 闰年
  assert.equal(addUtcDays('2024-02-28', 2), '2024-03-01');
  assert.equal(addUtcDays('2023-02-28', 1), '2023-03-01'); // 2023 平年
  assert.equal(addUtcDays('2024-12-31', 1), '2025-01-01'); // 跨年
  assert.equal(addUtcDays('2024-01-31', 30), '2024-03-01');
});

test('非法日期被识别', () => {
  for (const bad of [
    '2024-13-01',
    '2024-02-30',
    '2023-02-29',
    '2024/03/01',
    'not-a-date',
    '2024-3-1',
  ]) {
    assert.equal(isValidUtcDate(bad), false, bad);
  }
  assert.equal(isValidUtcDate('2024-02-29'), true);
});

function pick(r: ReturnType<typeof nextSchedule>) {
  return {
    step: r.step,
    intervalDays: r.intervalDays,
    due: r.due,
    easeStreak: r.easeStreak,
  };
}
