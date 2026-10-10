import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service.js';
import {
  getShanghaiWeekInfo,
  roundRatio4,
  spendRedisKey,
} from './utils/week-quota.util.js';

export type ChatQuotaDto = {
  usedPercent: number;
  remainingPercent: number;
  usedRatio: number;
  period: string;
  resetsAt: string;
  resetsInSeconds: number;
};

@Injectable()
export class ChatQuotaService {
  constructor(
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
  ) {}

  async getQuota(userId: string): Promise<ChatQuotaDto> {
    const week = getShanghaiWeekInfo();
    const key = spendRedisKey(userId, week.redisWeekKey);
    const raw = await this.redis.get(key);
    const spendMicros = BigInt(raw && /^\d+$/.test(raw) ? raw : '0');

    const budgetCny = Number(
      this.configService.get('CHAT_USER_WEEKLY_BUDGET_CNY', '10'),
    );
    const budgetMicros = BigInt(Math.max(0, budgetCny)) * 1_000_000n;

    let usedRatio = 0;
    if (budgetMicros > 0n) {
      usedRatio = Number(spendMicros) / Number(budgetMicros);
    }

    usedRatio = roundRatio4(usedRatio);
    const usedPercent = roundRatio4(usedRatio * 100);
    const remainingPercent = roundRatio4(Math.max(0, 100 - usedPercent));

    return {
      usedPercent,
      remainingPercent,
      usedRatio,
      period: week.period,
      resetsAt: week.resetsAt.toISOString(),
      resetsInSeconds: week.resetsInSeconds,
    };
  }
}
