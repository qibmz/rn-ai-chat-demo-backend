import {
  getShanghaiWeekInfo,
  roundRatio4,
  spendRedisKey,
} from './week-quota.util.js';

describe('week-quota.util', () => {
  it('builds spend redis key', () => {
    expect(spendRedisKey('user-1', '2026-W41')).toBe(
      'chat:spend:user-1:2026-W41',
    );
  });

  it('rounds to 4 decimal places', () => {
    expect(roundRatio4(0.123456)).toBe(0.1235);
  });

  it('computes period and positive resetsInSeconds', () => {
    const info = getShanghaiWeekInfo(new Date('2026-10-10T12:00:00.000Z'));
    expect(info.period).toMatch(/^\d{4}-W\d{2}$/);
    expect(info.resetsAt.toISOString()).toBeTruthy();
    expect(info.resetsInSeconds).toBeGreaterThan(0);
  });
});
