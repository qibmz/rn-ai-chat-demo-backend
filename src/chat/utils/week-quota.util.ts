const MS_PER_DAY = 86_400_000;

export type ShanghaiWeekInfo = {
  period: string;
  redisWeekKey: string;
  resetsAt: Date;
  resetsInSeconds: number;
};

function shanghaiParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour'),
    minute: pick('minute'),
    second: pick('second'),
  };
}

/** UTC instant for a calendar date at 00:00:00 in Asia/Shanghai. */
function shanghaiMidnightUtc(year: number, month: number, day: number): Date {
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  for (let offsetHours = -12; offsetHours <= 14; offsetHours += 1) {
    const candidate = new Date(guess - offsetHours * 3_600_000);
    const p = shanghaiParts(candidate);
    if (p.year === year && p.month === month && p.day === day && p.hour === 0) {
      return candidate;
    }
  }
  return new Date(guess - 8 * 3_600_000);
}

function isoWeekFromYmd(
  year: number,
  month: number,
  day: number,
): {
  isoYear: number;
  isoWeek: number;
} {
  const d = new Date(Date.UTC(year, month - 1, day));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / MS_PER_DAY + 1) / 7,
  );
  return { isoYear, isoWeek };
}

function padWeek(week: number): string {
  return week.toString().padStart(2, '0');
}

export function getShanghaiWeekInfo(now = new Date()): ShanghaiWeekInfo {
  const { year, month, day } = shanghaiParts(now);
  const { isoYear, isoWeek } = isoWeekFromYmd(year, month, day);
  const period = `${isoYear}-W${padWeek(isoWeek)}`;
  const redisWeekKey = `${isoYear}-W${padWeek(isoWeek)}`;

  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const isoWeekday = weekday === 0 ? 7 : weekday;
  const daysSinceMonday = isoWeekday - 1;
  const mondayDay = day - daysSinceMonday;
  const thisMonday = shanghaiMidnightUtc(year, month, mondayDay);

  let resetsAt: Date;
  if (now.getTime() >= thisMonday.getTime()) {
    resetsAt = new Date(thisMonday.getTime() + 7 * MS_PER_DAY);
  } else {
    resetsAt = thisMonday;
  }

  const resetsInSeconds = Math.max(
    0,
    Math.floor((resetsAt.getTime() - now.getTime()) / 1000),
  );

  return { period, redisWeekKey, resetsAt, resetsInSeconds };
}

export function spendRedisKey(userId: string, weekKey: string): string {
  return `chat:spend:${userId}:${weekKey}`;
}

export function roundRatio4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
