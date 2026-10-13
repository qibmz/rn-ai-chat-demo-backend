import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import {
  ChatPriceMicrosPerMTokens,
  ChatUsageForBilling,
  computeCostMicros,
} from './utils/chat-billing.util.js';
import { getShanghaiWeekInfo, spendRedisKey } from './utils/week-quota.util.js';

export { computeCostMicros } from './utils/chat-billing.util.js';
export type { ChatUsageForBilling } from './utils/chat-billing.util.js';

@Injectable()
export class ChatBillingService {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  getPrices(): ChatPriceMicrosPerMTokens {
    return {
      inputMiss: BigInt(
        this.configService.get(
          'CHAT_PRICE_INPUT_MISS_MICROS_PER_MTOKENS',
          '1065000',
        ),
      ),
      inputHit: BigInt(
        this.configService.get(
          'CHAT_PRICE_INPUT_HIT_MICROS_PER_MTOKENS',
          '21600',
        ),
      ),
      output: BigInt(
        this.configService.get(
          'CHAT_PRICE_OUTPUT_MICROS_PER_MTOKENS',
          '4320000',
        ),
      ),
    };
  }

  getPriceVersion(): string {
    return (
      this.configService.get<string>(
        'CHAT_PRICE_VERSION',
        '2026-10-deepseek-flash',
      ) ?? '2026-10-deepseek-flash'
    );
  }

  /** Weekly budget in 微元（CHAT_USER_WEEKLY_BUDGET_CNY × 1e6）. */
  getWeeklyBudgetMicros(): bigint {
    const budgetCny = Number(
      this.configService.get('CHAT_USER_WEEKLY_BUDGET_CNY', '10'),
    );
    return BigInt(Math.max(0, budgetCny)) * 1_000_000n;
  }

  computeCostMicros(usage: ChatUsageForBilling): bigint {
    return computeCostMicros(usage, this.getPrices());
  }

  /**
   * 本周已花费（微元）。优先 Redis；miss / flush 后从 ChatWeeklySpend 回填。
   */
  async getWeeklySpendMicros(userId: string): Promise<bigint> {
    const week = getShanghaiWeekInfo();
    const key = spendRedisKey(userId, week.redisWeekKey);
    const raw = await this.redis.get(key);
    if (raw && /^\d+$/.test(raw)) {
      return BigInt(raw);
    }

    const row = await this.prisma.chatWeeklySpend.findUnique({
      where: { userId_period: { userId, period: week.period } },
      select: { spendMicros: true },
    });
    const spend = row?.spendMicros ?? 0n;

    if (week.resetsInSeconds > 0) {
      await this.redis.set(key, spend.toString(), week.resetsInSeconds);
    }

    return spend;
  }

  /**
   * 在同一 DB 事务内累加周额度账本（消息落库时调用）。
   */
  async incrementWeeklySpend(
    tx: Prisma.TransactionClient,
    userId: string,
    costMicros: bigint,
    period = getShanghaiWeekInfo().period,
  ): Promise<void> {
    if (costMicros <= 0n) {
      return;
    }
    await tx.chatWeeklySpend.upsert({
      where: { userId_period: { userId, period } },
      create: {
        userId,
        period,
        spendMicros: costMicros,
      },
      update: {
        spendMicros: { increment: costMicros },
      },
    });
  }

  /** 热路径计数器；DB 账本已由 incrementWeeklySpend 写入。 */
  async recordSpend(userId: string, costMicros: bigint): Promise<void> {
    if (costMicros <= 0n) {
      return;
    }
    const week = getShanghaiWeekInfo();
    const key = spendRedisKey(userId, week.redisWeekKey);
    await this.redis.incrby(key, costMicros, week.resetsInSeconds);
  }
}
