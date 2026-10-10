import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

  async getWeeklySpendMicros(userId: string): Promise<bigint> {
    const week = getShanghaiWeekInfo();
    const key = spendRedisKey(userId, week.redisWeekKey);
    const raw = await this.redis.get(key);
    return BigInt(raw && /^\d+$/.test(raw) ? raw : '0');
  }

  async recordSpend(userId: string, costMicros: bigint): Promise<void> {
    if (costMicros <= 0n) {
      return;
    }
    const week = getShanghaiWeekInfo();
    const key = spendRedisKey(userId, week.redisWeekKey);
    await this.redis.incrby(key, costMicros, week.resetsInSeconds);
  }
}
